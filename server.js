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

const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const rooms = {};

const QUESTION_TIME = 30;
const REVEAL_TIME = 5;

function createPin() {
  return Math.floor(100000 + Math.random() * 900000).toString();
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

async function getBibleChapter(book, chapter) {
  const bibleId = process.env.NIV_BIBLE_ID;
  const apiKey = process.env.API_BIBLE_KEY;

  const booksRes = await fetch(
    `https://rest.api.bible/v1/bibles/${bibleId}/books`,
    {
      headers: {
        "api-key": apiKey,
        "Content-Type": "text/plain",
      },
    }
  );

  const booksData = await booksRes.json();

  if (!booksData.data) {
    console.log(booksData);
    throw new Error("Failed to fetch NIV books");
  }

  const matchedBook = booksData.data.find(
    (b) =>
      b.name.toLowerCase() === book.toLowerCase() ||
      b.nameLong.toLowerCase() === book.toLowerCase()
  );

  if (!matchedBook) {
    throw new Error(`Book not found: ${book}`);
  }

  const chaptersRes = await fetch(
    `https://rest.api.bible/v1/bibles/${bibleId}/books/${matchedBook.id}/chapters`,
    {
      headers: {
        "api-key": apiKey,
        "Content-Type": "text/plain",
      },
    }
  );

  const chaptersData = await chaptersRes.json();

  if (!chaptersData.data) {
    console.log(chaptersData);
    throw new Error("Failed to fetch chapters");
  }

  const matchedChapter = chaptersData.data.find(
    (c) => c.number === String(chapter)
  );

  if (!matchedChapter) {
    throw new Error(`Chapter not found: ${chapter}`);
  }

const chapterRes = await fetch(
  `https://rest.api.bible/v1/bibles/${bibleId}/chapters/${matchedChapter.id}?content-type=text&include-notes=false&include-titles=false&include-chapter-numbers=false&include-verse-numbers=true`,
  {
    headers: {
      "api-key": apiKey,
      "Content-Type": "text/plain",
    },
  }
);

  const chapterData = await chapterRes.json();

  if (!chapterData.data) {
    console.log(chapterData);
    throw new Error("Failed to fetch NIV chapter");
  }

  const html = chapterData.data.content;

const verses = [];

const cleanedHtml = html
  .replace(/\n/g, " ")
  .replace(/\r/g, " ");

const parts = cleanedHtml.split(
  /<span class="v" data-number="\d+"/
);

parts.shift();

for (const part of parts) {
  const numberMatch = part.match(/>(\d+)<\/span>/);

  if (!numberMatch) continue;

  const verseNumber = numberMatch[1];

  const verseContent = part
    .replace(/.*?<\/span>/, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

  if (verseContent) {
    verses.push({
      verse: verseNumber,
      text: verseContent,
    });
  }
}

  if (verses.length === 0) {
    throw new Error("No NIV verses parsed");
  }

  return {
    text: verses.map((v) => v.text).join(" "),
    verses,
  };
}

function validateQuestions(rawQuestions, count) {
  if (!Array.isArray(rawQuestions)) {
    throw new Error("AI response was not an array");
  }

  const valid = rawQuestions
    .filter((q) => q && typeof q.question === "string")
    .map((q) => {
      if (
        q.type === "fill" ||
        q.type === "direct" ||
        q.type === "rapid"
      ) {
        return {
          type: q.type,
          question: q.question,
          answer: String(q.answer || "").trim(),
        };
      }

      const options = Array.isArray(q.options)
        ? q.options.map((o) => String(o).trim()).filter(Boolean)
        : [];

      const uniqueOptions = [...new Set(options)].slice(0, 4);

      const answer = String(q.answer || "").trim();

      if (
        uniqueOptions.length < 2 ||
        !uniqueOptions.includes(answer)
      ) {	
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

async function generateAiQuestions(
  book,
  chapter,
  verses,
  count = 20,
  type = "mcq"
) {
  const verseText = verses
    .map(
      (v) =>
        `${book} ${chapter}:${v.verse} - ${clean(v.text)}`
    )
    .join("\n");

  const prompt = `
Generate ONLY ${type} questions.

Create ${count} Bible quiz questions.

Book: ${book}
Chapter: ${chapter}

IMPORTANT:
- NEVER paraphrase verses.
- NEVER rewrite verses.
- NEVER summarize verses.
- Use the EXACT NIV wording from the supplied verses.
- Fill in the blanks must come directly from the original verse text.
- Direct questions must use exact NIV phrasing.
- Preserve punctuation and wording exactly as given.

Use ONLY this chapter text:
${verseText}

Question Types:
1. Multiple Choice
2. Direct Questions
3. Fill in the Blanks
4. Rapid Fire Questions

Rules:
- Multiple choice should have ONLY 4 choices.
- Multiple choice answers must match the actual NIV verse context.
- Choices can be full phrases or sentences if needed.
- Do NOT shorten answers unnaturally.
- Wrong answers should sound believable
- Do NOT use long sentences.
- Include Bible references in questions.
- Make the questions very hard to guess
- Questions asking "Who", "What", "Why", "According to" should be type-answer questions.
- Direct/fill/rapid questions should let users TYPE answers.
- Fill in the blank questions must use the EXACT FULL NIV verse text.
- Remove ONLY 2 or 3 words from the ORIGINAL verse.
- Do NOT change any wording.
- Do NOT rephrase verses.
- Keep remaining verse visible.
- Use underscores for missing words.
- Make questions mobile friendly.
- Return ONLY valid JSON array.

JSON format:
[
  {
    "type": "mcq",
    "question": "Who built the ark? (Genesis 6)",
    "options": ["Noah", "Moses", "Peter","John"],
    "answer": "Noah"
  },
  {
    "type": "direct",
    "question": "Who is the liar according to 1 John 2:22?",
    "answer": "Whoever denies that Jesus is the Christ"
  },
  {
  "type": "fill",
  "question": "The Son is the _____ of the invisible God, the firstborn over all _____. (Colossians 1:15)",
  "answer": "image, creation"
},
  {
    "type": "rapid",
    "question": "Who denied Jesus three times?",
    "answer": "Peter"
  }
]
`;

  const response =
    await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.8,
      messages: [
        {
          role: "system",
          content:
            "You create Bible quiz questions. Return only valid JSON.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

  const text =
    response.choices[0].message.content || "";

  const parsed = safeJsonParse(text);

  return validateQuestions(parsed, count);
}

async function generateQuestions(
  book,
  chapter,
  count = 20,
  type = "mcq"
) {
  const bibleData = await getBibleChapter(
    book,
    chapter
  );

  return await generateAiQuestions(
    book,
    chapter,
    bibleData.verses,
    Number(count) || 20,
    type
  );
}

function leaderboard(room) {
  return Object.values(room.players).sort(
    (a, b) => b.score - a.score
  );
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
  room.paused = false;

  io.to(pin).emit("question", {
    number: room.currentQuestion + 1,
    total: room.questions.length,
    ...q,
    timeLeft: room.timeLeft,
  });

  io.to(pin).emit(
    "playersUpdate",
    leaderboardWithStatus(room)
  );

  room.timer = setInterval(() => {
    if (room.paused) return;

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

  io.to(pin).emit("revealAnswer", {
    correctAnswer: q.answer,
    leaderboard: leaderboardWithStatus(room),
  });

  room.revealTimeout = setTimeout(() => {
    room.currentQuestion++;

    if (
      room.currentQuestion >= room.questions.length
    ) {
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
      paused: false,
    };

    socket.join(pin);

    socket.emit("roomCreated", pin);
  });

  socket.on(
    "setQuiz",
    async ({ pin, book, chapter, count, type }) => {
      const room = rooms[pin];

      if (!room) {
        socket.emit("errorMessage", "Room not found");
        return;
      }

      try {
        socket.emit(
          "errorMessage",
          "Generating NIV questions..."
        );

        room.questions = await generateQuestions(
          book,
          chapter,
          Number(count) || 20,
          type || "mcq"
        );

        room.currentQuestion = 0;
        room.answers = {};

        io.to(pin).emit("quizSet", {
          count: room.questions.length,
        });

        socket.emit(
          "errorMessage",
          `Loaded ${room.questions.length} questions`
        );
      } catch (e) {
        console.error(e);

        socket.emit(
          "errorMessage",
          e.message || "Failed to generate quiz"
        );
      }
    }
  );

  socket.on("joinRoom", ({ pin, name }) => {
    const room = rooms[pin];

    if (!room) {
      socket.emit("errorMessage", "Room not found");
      return;
    }

    room.players[socket.id] = {
      id: socket.id,
      name,
      score: 0,
    };

    socket.join(pin);

    io.to(pin).emit(
      "playersUpdate",
      leaderboardWithStatus(room)
    );
  });

  socket.on("startGame", (pin) => {
    const room = rooms[pin];

    if (!room || room.questions.length === 0) {
      socket.emit(
        "errorMessage",
        "Load quiz first"
      );
      return;
    }

    room.currentQuestion = 0;
    room.answers = {};

    sendQuestion(pin);
  });

  socket.on("pauseGame", (pin) => {
    const room = rooms[pin];

    if (!room) return;

    room.paused = true;

    if (room.timer) {
      clearInterval(room.timer);
      room.timer = null;
    }

    io.to(pin).emit("gamePaused");
  });

  socket.on("resumeGame", (pin) => {
    const room = rooms[pin];

    if (!room) return;

    room.paused = false;

    io.to(pin).emit("gameResumed");

    room.timer = setInterval(() => {
      if (room.paused) return;

      room.timeLeft--;

      io.to(pin).emit("timer", room.timeLeft);

      if (room.timeLeft <= 0) {
        clearInterval(room.timer);
        room.timer = null;

        reveal(pin);
      }
    }, 1000);
  });

  socket.on("exitGame", (pin) => {
    const room = rooms[pin];

    if (!room) return;

    clearRoomTimers(room);

    io.to(pin).emit("gameExited");

    delete rooms[pin];
  });

  socket.on(
    "submitAnswer",
    ({ pin, answer }) => {
      const room = rooms[pin];

      if (!room) return;

      if (room.answers[socket.id]) return;

      const player = room.players[socket.id];

      const q =
        room.questions[room.currentQuestion];

      if (!player || !q) return;

      const correct =
        String(answer).trim().toLowerCase() ===
        String(q.answer).trim().toLowerCase();

      if (correct) {
        player.score +=
          500 + room.timeLeft * 30;
      }

      room.answers[socket.id] = {
        answer,
        correct,
      };

      socket.emit("answerSubmitted", {
        correct,
      });

      io.to(pin).emit(
        "playersUpdate",
        leaderboardWithStatus(room)
      );
    }
  );

  socket.on("disconnect", () => {
    for (const pin in rooms) {
      const room = rooms[pin];

      if (!room) continue;

      delete room.players[socket.id];

      if (room.host === socket.id) {
        clearRoomTimers(room);

        delete rooms[pin];
      } else {
        io.to(pin).emit(
          "playersUpdate",
          leaderboardWithStatus(room)
        );
      }
    }
  });
});

app.use(
  express.static(
    path.join(__dirname, "client", "dist")
  )
);

app.get(/.*/, (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "client",
      "dist",
      "index.html"
    )
  );
});

const PORT = process.env.PORT || 4000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});