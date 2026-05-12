require("dotenv").config();

const express = require("express");
const http = require("http");
const cors = require("cors");
const path = require("path");
const { Server } = require("socket.io");
const OpenAI = require("openai");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const rooms = {};

const QUESTION_TIME = 30;
const REVEAL_TIME = 5;

function createPin() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function getBibleChapter(book, chapter) {
  const url = `https://bible-api.com/${encodeURIComponent(
    book + " " + chapter
  )}?translation=web`;

  const res = await fetch(url);
  const contentType = res.headers.get("content-type") || "";

  if (!res.ok) {
    throw new Error(`Bible API failed: ${res.status}`);
  }

  if (!contentType.includes("application/json")) {
    const html = await res.text();
    console.log("Bible API returned non-JSON:", html.slice(0, 200));
    throw new Error("Bible API returned HTML instead of JSON");
  }

  const data = await res.json();

  if (!data.text && !data.verses) {
    throw new Error("No Bible text found");
  }

  return {
    text: data.text || "",
    verses: data.verses || [],
  };
}

function clean(text) {
  return String(text || "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

function safeJsonParse(text) {
  let cleaned = text.trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```json/i, "")
      .replace(/^```/i, "")
      .replace(/```$/i, "")
      .trim();
  }

  return JSON.parse(cleaned);
}

function validateQuestions(rawQuestions, count) {
  if (!Array.isArray(rawQuestions)) {
    throw new Error("AI response was not an array");
  }

  const valid = rawQuestions
    .filter((q) => q && typeof q.question === "string")
    .map((q) => {
      if (q.type === "fill") {
        return {
          type: "fill",
          question: q.question,
          answer: String(q.answer || "").trim(),
        };
      }

      const options = Array.isArray(q.options)
        ? q.options.map((o) => String(o).trim()).filter(Boolean)
        : [];

      const uniqueOptions = [...new Set(options)].slice(0, 4);
      const answer = String(q.answer || "").trim();

      if (uniqueOptions.length < 4 || !uniqueOptions.includes(answer)) {
        return null;
      }

      return {
        type: "mcq",
        question: q.question,
        options: shuffle(uniqueOptions),
        answer,
      };
    })
    .filter(Boolean)
    .filter((q) => q.answer);

  if (valid.length === 0) {
    throw new Error("No valid AI questions generated");
  }

  return valid.slice(0, count);
}

async function generateAiQuestions(book, chapter, verses, count = 20, type = "mixed") {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const verseText = verses
    .map((v) => `${book} ${chapter}:${v.verse} - ${clean(v.text)}`)
    .join("\n");

  const prompt = `
Create ${count} difficult Bible quiz questions.

Book: ${book}
Chapter: ${chapter}
Translation: WEB Bible
Quiz type selected by host: ${type}

Use ONLY this chapter text:
${verseText}

Return ONLY valid JSON array. No markdown. No explanation.

JSON format:
[
  {
    "type": "mcq",
    "question": "question text",
    "options": ["short option A", "short option B", "short option C", "short option D"],
    "answer": "exact correct option"
  },
  {
    "type": "fill",
    "question": "fill blank question",
    "answer": "short correct answer"
  }
]

Rules:
- Make questions harder than basic recall.
- Do NOT use full verses as multiple-choice options.
- Multiple-choice options must be short phrases, names, places, actions, meanings, or missing phrases.
- Wrong answers must be believable and similar.
- Correct answer must exactly match one option.
- Use a mix of meaning, sequence, speaker, action, location, missing phrase, and context.
- If type is "mcq" or "ai-mcq", return only mcq questions.
- If type is "fill", return only fill questions.
- If type is "mixed", return both mcq and fill questions.
- If type includes "verse", include verse references in the question text.
- For "verse-5-each", create open-answer/fill-style questions per verse.
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.75,
    messages: [
      {
        role: "system",
        content:
          "You create accurate, difficult Bible quiz questions. Return only valid JSON.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const text = response.choices[0].message.content || "";
  const parsed = safeJsonParse(text);

  return validateQuestions(parsed, count);
}

async function generateQuestions(book, chapter, count = 20, type = "mixed") {
  const bibleData = await getBibleChapter(book, chapter);

  return await generateAiQuestions(
    book,
    chapter,
    bibleData.verses,
    Number(count) || 20,
    type || "mixed"
  );
}

function leaderboard(room) {
  return Object.values(room.players).sort((a, b) => b.score - a.score);
}

function leaderboardWithStatus(room) {
  return leaderboard(room).map((p) => ({
    ...p,
    status: room.answers[p.id]
      ? room.answers[p.id].correct
        ? "correct"
        : "wrong"
      : "pending",
  }));
}

function clearRoomTimers(room) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }

  if (room.revealTimeout) {
    clearTimeout(room.revealTimeout);
    room.revealTimeout = null;
  }
}

function sendQuestion(pin) {
  const room = rooms[pin];
  if (!room) return;

  const q = room.questions[room.currentQuestion];
  if (!q) return;

  clearRoomTimers(room);

  room.answers = {};
  room.timeLeft = QUESTION_TIME;
  room.status = "question";

  io.to(pin).emit("question", {
    number: room.currentQuestion + 1,
    total: room.questions.length,
    ...q,
    timeLeft: room.timeLeft,
  });

  io.to(pin).emit("playersUpdate", leaderboardWithStatus(room));

  room.timer = setInterval(() => {
    if (room.status !== "question") return;

    room.timeLeft--;

    io.to(pin).emit("timer", room.timeLeft);

    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      room.timer = null;
      reveal(pin);
    }
  }, 1000);
}

function reveal(pin) {
  const room = rooms[pin];
  if (!room) return;

  const q = room.questions[room.currentQuestion];
  if (!q) return;

  room.status = "reveal";

  io.to(pin).emit("revealAnswer", {
    correctAnswer: q.answer,
    leaderboard: leaderboardWithStatus(room),
  });

  room.revealTimeout = setTimeout(() => {
    room.currentQuestion++;

    if (room.currentQuestion >= room.questions.length) {
      room.status = "finished";

      io.to(pin).emit("gameOver", {
        leaderboard: leaderboardWithStatus(room),
      });

      return;
    }

    sendQuestion(pin);
  }, REVEAL_TIME * 1000);
}

io.on("connection", (socket) => {
  socket.on("createRoom", () => {
    const pin = createPin();

    rooms[pin] = {
      host: socket.id,
      players: {},
      questions: [],
      currentQuestion: 0,
      answers: {},
      timer: null,
      revealTimeout: null,
      timeLeft: QUESTION_TIME,
      status: "lobby",
    };

    socket.join(pin);
    socket.emit("roomCreated", pin);
  });

  socket.on("setQuiz", async ({ pin, book, chapter, count, type }) => {
    const room = rooms[pin];

    if (!room) {
      socket.emit("errorMessage", "Room not found");
      return;
    }

    try {
      socket.emit("errorMessage", "******Loading the quiz questions pls wait ...");

      clearRoomTimers(room);

      room.questions = await generateQuestions(
        book,
        chapter,
        Number(count) || 20,
        type || "mixed"
      );

      room.currentQuestion = 0;
      room.answers = {};
      room.status = "loaded";

      io.to(pin).emit("quizSet", {
        count: room.questions.length,
      });

      socket.emit("errorMessage", `Loaded ${room.questions.length} questions`);
    } catch (e) {
      console.error("Quiz generation failed:", e);
      socket.emit(
        "errorMessage",
        e.message || "Failed to load AI quiz"
      );
    }
  });

  socket.on("joinRoom", ({ pin, name }) => {
    const room = rooms[pin];

    if (!room) {
      socket.emit("errorMessage", "Room not found");
      return;
    }

    if (!name) {
      socket.emit("errorMessage", "Enter your name");
      return;
    }

    room.players[socket.id] = {
      id: socket.id,
      name,
      score: 0,
    };

    socket.join(pin);
    io.to(pin).emit("playersUpdate", leaderboardWithStatus(room));
  });

  socket.on("startGame", (pin) => {
    const room = rooms[pin];

    if (!room || room.questions.length === 0) {
      socket.emit("errorMessage", "Load quiz first");
      return;
    }

    clearRoomTimers(room);

    room.currentQuestion = 0;
    room.answers = {};
    room.status = "started";

    sendQuestion(pin);
  });

  socket.on("pauseGame", (pin) => {
    const room = rooms[pin];
    if (!room) return;

    if (room.timer) {
      clearInterval(room.timer);
      room.timer = null;
    }

    room.status = "paused";

    io.to(pin).emit("gamePaused", {
      message: "Game paused by host",
      timeLeft: room.timeLeft,
    });
  });

  socket.on("resumeGame", (pin) => {
    const room = rooms[pin];
    if (!room) return;

    if (room.status !== "paused") return;

    room.status = "question";

    io.to(pin).emit("gameResumed", {
      message: "Game resumed",
      timeLeft: room.timeLeft,
    });

    room.timer = setInterval(() => {
      if (room.status !== "question") return;

      room.timeLeft--;

      io.to(pin).emit("timer", room.timeLeft);

      if (room.timeLeft <= 0) {
        clearInterval(room.timer);
        room.timer = null;
        reveal(pin);
      }
    }, 1000);
  });

  socket.on("stopGame", (pin) => {
    const room = rooms[pin];
    if (!room) return;

    clearRoomTimers(room);

    room.status = "stopped";
    room.currentQuestion = 0;
    room.answers = {};

    io.to(pin).emit("gameStopped", {
      leaderboard: leaderboardWithStatus(room),
    });
  });

  socket.on("replayGame", (pin) => {
    const room = rooms[pin];
    if (!room || room.questions.length === 0) return;

    clearRoomTimers(room);

    Object.values(room.players).forEach((player) => {
      player.score = 0;
    });

    room.currentQuestion = 0;
    room.answers = {};
    room.status = "started";

    io.to(pin).emit("playersUpdate", leaderboardWithStatus(room));
    sendQuestion(pin);
  });

  socket.on("exitGame", (pin) => {
    const room = rooms[pin];
    if (!room) return;

    clearRoomTimers(room);

    io.to(pin).emit("gameExited", {
      message: "Host ended the game",
    });

    delete rooms[pin];
  });

  socket.on("submitAnswer", ({ pin, answer }) => {
    const room = rooms[pin];

    if (!room) return;
    if (room.status !== "question") return;
    if (room.answers[socket.id]) return;

    const player = room.players[socket.id];
    const q = room.questions[room.currentQuestion];

    if (!player || !q) return;

    const userAnswer = String(answer).trim().toLowerCase();
    const correctAnswer = String(q.answer).trim().toLowerCase();

    const correct =
      q.type === "fill"
        ? userAnswer === correctAnswer
        : String(answer).trim() === String(q.answer).trim();

    if (correct) {
      player.score += 500 + room.timeLeft * 30;
    }

    room.answers[socket.id] = {
      answer,
      correct,
    };

    socket.emit("answerSubmitted", { correct });
    io.to(pin).emit("playersUpdate", leaderboardWithStatus(room));
  });

  socket.on("disconnect", () => {
    for (const pin in rooms) {
      const room = rooms[pin];
      if (!room) continue;

      delete room.players[socket.id];

      if (room.host === socket.id) {
        clearRoomTimers(room);
        delete rooms[pin];
      } else {
        io.to(pin).emit("playersUpdate", leaderboardWithStatus(room));
      }
    }
  });
});

app.use(express.static(path.join(__dirname, "client", "dist")));

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "client", "dist", "index.html"));
});

const PORT = process.env.PORT || 4000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`App running on port ${PORT}`);
});