const express = require("express");
const http = require("http");
const cors = require("cors");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const rooms = {};
const QUESTION_TIME = 15;
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
  return text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
}

function shuffle(arr) {
  return [...arr].sort(() => Math.random() - 0.5);
}

function createSmartWrongOptions(correctText, allTexts, count = 3) {
  const correct = clean(correctText);

  const correctWords = correct
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);

  const candidates = allTexts
    .map((t) => clean(t))
    .filter((t) => {
      if (!t) return false;
      if (t === correct) return false;
      if (t.length < 30) return false;

      const words = t
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 3);

      const shared = words.filter((w) =>
        correctWords.includes(w)
      ).length;

      const similarLength =
        Math.abs(t.length - correct.length) < 80;

      return shared >= 3 && similarLength;
    });

  const unique = [...new Set(candidates)];

  let selected = shuffle(unique).slice(0, count);

  if (selected.length < count) {
    const fillers = shuffle(
      allTexts.filter(
        (t) =>
          t &&
          t !== correct &&
          !selected.includes(t) &&
          t.length > 30
      )
    );

    selected = [...selected, ...fillers].slice(0, count);
  }

  return selected;
}

async function generateQuestions(book, chapter, count = 30, type = "mixed") {
  const bibleData = await getBibleChapter(book, chapter);
  const chapterText = bibleData.text;
  const verses = bibleData.verses;

  const wrongOptions = [
    "This is not in the selected chapter",
    "God forgot His people",
    "The chapter teaches people to ignore faith",
    "No lesson is taught in this verse",
  ];

  const questions = [];

  if (type === "verse-5-each") {
  for (const verse of verses) {
    const verseText = clean(verse.text);
    if (!verseText || verseText.length < 20) continue;

    const words = verseText.split(" ");
    const middleIndex = Math.floor(words.length / 2);
    const answerWord = words[middleIndex]?.replace(/[^a-zA-Z]/g, "");

    questions.push({
      type: "fill",
      question: `${book} ${chapter}:${verse.verse} — What is the full verse?`,
      answer: verseText,
    });

    questions.push({
      type: "fill",
      question: `Which verse reference says: "${verseText}"?`,
      answer: `${book} ${chapter}:${verse.verse}`,
    });

    questions.push({
      type: "fill",
      question: `${book} ${chapter}:${verse.verse} — Type one important word from this verse.`,
      answer: answerWord || words[0],
    });

    if (words.length > 6 && answerWord && answerWord.length > 2) {
      const fillWords = [...words];
      fillWords[middleIndex] = "______";

      questions.push({
        type: "fill",
        question: `${book} ${chapter}:${verse.verse} — ${fillWords.join(" ")}`,
        answer: answerWord,
      });
    }

    questions.push({
      type: "fill",
      question: `${book} ${chapter}:${verse.verse} — What book is this verse from?`,
      answer: book,
    });
  }

  return questions;
}
  

  const isVerseType = type.startsWith("verse");

  if (isVerseType) {
    for (const verse of verses) {
      if (questions.length >= count) break;

      const verseText = clean(verse.text);
      if (!verseText || verseText.length < 20) continue;

      if (type === "verse-mcq" || type === "verse-mixed") {
        questions.push({
          type: "mcq",
          question: `${book} ${chapter}:${verse.verse} — identify the exact wording from this verse.`,
          options: shuffle([verseText, ...wrongOptions.slice(0, 3)]),
          answer: verseText,
        });
      }

      if (type === "verse-fill" || type === "verse-mixed") {
        const words = verseText.split(" ");

        if (words.length > 6 && questions.length < count) {
          const importantIndexes = words
  .map((w, i) => ({ w, i }))
  .filter(
    (x) =>
      x.w.length > 5 &&
      ![
        "therefore",
        "because",
        "people",
        "Israel",
        "Jesus",
        "Christ",
      ].includes(x.w.toLowerCase())
  );

const randomWord =
  importantIndexes[
    Math.floor(Math.random() * importantIndexes.length)
  ];

const index = randomWord
  ? randomWord.i
  : Math.floor(words.length / 2);
          const answerWord = words[index].replace(/[^a-zA-Z]/g, "");

          if (answerWord.length > 2) {
            words[index] = "______";

            questions.push({
              type: "fill",
              question: `${book} ${chapter}:${verse.verse} — ${words.join(
                " "
              )}`,
              answer: answerWord,
            });
          }
        }
      }
    }

    return shuffle(questions).slice(0, count);
  }

  const chapterSentences = clean(chapterText)
    .split(/[.!?]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 35);

  for (let i = 0; i < chapterSentences.length && questions.length < count; i++) {
    const sentence = chapterSentences[i];

    if (type === "mcq" || type === "mixed") {
      questions.push({
        type: "mcq",
        question: `Which statement most accurately reflects ${book} ${chapter}?`,
        options: shuffle([sentence, ...wrongOptions.slice(0, 3)]),
        answer: sentence,
      });
    }

    if (type === "fill" || type === "mixed") {
      const words = sentence.split(" ");

      if (words.length > 6) {
        const index = Math.floor(words.length / 2);
        const answerWord = words[index].replace(/[^a-zA-Z]/g, "");

        if (answerWord.length > 2) {
          words[index] = "______";

          questions.push({
            type: "fill",
            question: words.join(" "),
            answer: answerWord,
          });
        }
      }
    }
  }

  return shuffle(questions).slice(0, count);
}


function leaderboard(room) {
  return Object.values(room.players).sort((a, b) => b.score - a.score);
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
    leaderboard: leaderboard(room),
  });

  room.revealTimeout = setTimeout(() => {
    room.currentQuestion++;

    if (room.currentQuestion >= room.questions.length) {
      room.status = "finished";

      io.to(pin).emit("gameOver", {
        leaderboard: leaderboard(room),
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
      socket.emit("errorMessage", "Loading quiz...");

      clearRoomTimers(room);

      room.questions = await generateQuestions(
        book,
        chapter,
        Number(count) || 30,
        type || "mixed"
      );

      room.currentQuestion = 0;
      room.answers = {};
      room.status = "loaded";

      io.to(pin).emit("quizSet", {
        count: room.questions.length,
      });
    } catch (e) {
      console.error(e);
      socket.emit("errorMessage", "Failed to load quiz");
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
    io.to(pin).emit(
    "playersUpdate",
    leaderboard(room).map((p) => ({
    ...p,
    status: "pending",
  }))
);
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
      leaderboard: leaderboard(room).map((p) => ({
      ...p,
     status: room.answers[p.id]
    ? room.answers[p.id].correct
      ? "correct"
      : "wrong"
    : "pending",
})),
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

    io.to(pin).emit("playersUpdate", leaderboard(room));
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
      q.type === "fill" ? userAnswer === correctAnswer : answer === q.answer;

    if (correct) {
      player.score += 500 + room.timeLeft * 30;
    }

    room.answers[socket.id] = {
    answer,
    correct,
    };

    socket.emit("answerSubmitted", { correct });
    io.to(pin).emit("playersUpdate",  leaderboard(room).map((p) => ({
    ...p,
    status: room.answers[p.id]
      ? room.answers[p.id].correct
        ? "correct"
        : "wrong"
      : "pending",
  }))
);
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
        io.to(pin).emit("playersUpdate", leaderboard(room));
      }
    }
  });
});

// Serve React frontend build
app.use(express.static(path.join(__dirname, "client", "dist")));

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "client", "dist", "index.html"));
});

const PORT = process.env.PORT || 4000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`App running on port ${PORT}`);
});