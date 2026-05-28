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

function removeDuplicateQuestions(questions) {
  const seenVerses = new Set();
  const seenKeywords = new Set();

  return questions.filter((q) => {
    const question = q.question
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .trim();

    const verseMatch =
      question.match(/\((.*?)\)/);

    const verseKey = verseMatch
      ? verseMatch[1]
      : "";

    const keywordKey = question
      .split(" ")
      .slice(0, 8)
      .join(" ");

    if (
      verseKey &&
      seenVerses.has(verseKey)
    ) {
      return false;
    }

    if (seenKeywords.has(keywordKey)) {
      return false;
    }

    if (verseKey) {
      seenVerses.add(verseKey);
    }

    seenKeywords.add(keywordKey);

    return true;
  });
}

async function getBibleChapter(book, chapter) {
  const bibleId = process.env.NIV_BIBLE_ID;
  const apiKey = process.env.API_BIBLE_KEY;

  if (!bibleId) {
    throw new Error("Missing NIV_BIBLE_ID");
  }

  if (!apiKey) {
    throw new Error("Missing API_BIBLE_KEY");
  }

  const booksRes = await fetch(
    `https://api.scripture.api.bible/v1/bibles/${bibleId}/books`,
    {
      headers: {
        "api-key": apiKey,
        "Content-Type": "text/plain",
      },
    }
  );

  const booksData = await booksRes.json();

  if (!booksData.data) {
    console.log("BOOKS RESPONSE:", booksData);

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
    `https://api.scripture.api.bible/v1/bibles/${bibleId}/books/${matchedBook.id}/chapters`,
    {
      headers: {
        "api-key": apiKey,
        "Content-Type": "text/plain",
      },
    }
  );

  const chaptersData = await chaptersRes.json();

  if (!chaptersData.data) {
    console.log("CHAPTERS RESPONSE:", chaptersData);

    throw new Error("Failed to fetch chapters");
  }

  const matchedChapter = chaptersData.data.find(
    (c) => c.number === String(chapter)
  );

  if (!matchedChapter) {
    throw new Error(`Chapter not found: ${chapter}`);
  }

  const chapterRes = await fetch(
    `https://api.scripture.api.bible/v1/bibles/${bibleId}/chapters/${matchedChapter.id}?content-type=text&include-notes=false&include-titles=false&include-chapter-numbers=false&include-verse-numbers=true`,
    {
      headers: {
        "api-key": apiKey,
        "Content-Type": "text/plain",
      },
    }
  );

  const chapterData = await chapterRes.json();

  if (!chapterData.data || !chapterData.data.content) {
    console.log("CHAPTER RESPONSE:", chapterData);

    throw new Error("Failed to fetch NIV chapter");
  }

  const content = chapterData.data.content;

  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const verses = [];

  for (const line of lines) {
    const match = line.match(/^(\d+)\s+(.*)$/);

    if (!match) continue;

    verses.push({
      verse: match[1],
      text: match[2].trim(),
    });
  }

  if (verses.length === 0) {
    verses.push({
      verse: "1",
      text: content,
    });
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
        ? q.options
            .map((o) => String(o).trim())
            .filter(Boolean)
        : [];

      const uniqueOptions = [
        ...new Set(options),
      ].slice(0, 4);

      const answer = String(
        q.answer || ""
      ).trim();

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
You are a Bible study teacher creating verse-by-verse Bible quiz questions STRICTLY from NIV scripture text.

Book: ${book}
Chapter: ${chapter}

IMPORTANT RULES:
- NEVER paraphrase scripture.
- NEVER summarize scripture.
- NEVER rewrite scripture wording.
- Use ONLY the EXACT NIV wording from supplied verses.
- Questions should feel like Bible Bowl and Sunday school study questions.
- Questions should follow verse-by-verse order.
- Questions must test different verses and concepts.
- Generate at most ONE question per verse.
- Spread questions evenly across the chapter.
- Avoid repeating the same question idea.
- Answers MUST match scripture wording exactly.

QUESTION TYPE:
Generate ONLY "${type}" questions.

Generate ${count * 2} questions.

MCQ RULES:
- EXACTLY 4 choices.
- Only ONE correct answer.
- Wrong answers should come from nearby verses or nearby chapter concepts.
- Choices may be phrases directly from scripture.
- Every MCQ MUST contain:
  - question
  - options
  - answer

DIRECT QUESTION RULES:
- Use questions like:
  - Who...
  - What...
  - Why...
  - According to...
- Answers MUST use exact scripture wording.

FILL IN THE BLANK RULES:
- Use COMPLETE NIV verses.
- Remove ONLY 2 or 3 important words.
- Keep ALL remaining wording EXACTLY unchanged.
- Use underscores for blanks.

RAPID FIRE RULES:
- Very short scripture-based questions.
- Very short exact scripture answers.

Use ONLY these verses:
${verseText}

Return ONLY valid JSON array.
`;

  const response =
    await openai.chat.completions.create({
      model: "gpt-4o-mini",

      temperature: 0.1,

      messages: [
        {
          role: "system",
          content:
            "You create accurate Bible quiz questions using ONLY supplied NIV scripture text. Return ONLY valid JSON.",
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

  const validated =
    validateQuestions(
      parsed,
      count * 2
    );

  const unique =
    removeDuplicateQuestions(
      validated
    );

  console.log(
    "Generated:",
    parsed.length
  );

  console.log(
    "Validated:",
    validated.length
  );

  console.log(
    "Unique:",
    unique.length
  );

  return unique.slice(0, count);
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
    leaderboard:
      leaderboardWithStatus(room),
  });

  room.revealTimeout = setTimeout(() => {
    room.currentQuestion++;

    if (
      room.currentQuestion >=
      room.questions.length
    ) {
      io.to(pin).emit("gameOver", {
        leaderboard:
          leaderboardWithStatus(room),
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
    async ({
      pin,
      book,
      chapter,
      count,
      type,
    }) => {
      const room = rooms[pin];

      if (!room) {
        socket.emit(
          "errorMessage",
          "Room not found"
        );

        return;
      }

      try {
        socket.emit(
          "errorMessage",
          "Generating NIV questions..."
        );

        room.questions =
          await generateQuestions(
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
          e.message ||
            "Failed to generate quiz"
        );
      }
    }
  );

  socket.on(
    "joinRoom",
    ({ pin, name }) => {
      const room = rooms[pin];

      if (!room) {
        socket.emit(
          "errorMessage",
          "Room not found"
        );

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
    }
  );

  socket.on("startGame", (pin) => {
    const room = rooms[pin];

    if (
      !room ||
      room.questions.length === 0
    ) {
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

  socket.on("submitAnswer", ({ pin, answer }) => {
    const room = rooms[pin];

    if (!room) return;

    if (room.answers[socket.id])
      return;

    const player =
      room.players[socket.id];

    const q =
      room.questions[
        room.currentQuestion
      ];

    if (!player || !q) return;

    const correct =
      String(answer)
        .trim()
        .toLowerCase() ===
      String(q.answer)
        .trim()
        .toLowerCase();

    if (correct) {
      player.score +=
        500 + room.timeLeft * 30;
    }

    room.answers[socket.id] = {
      answer,
      correct,
    };

    socket.emit(
      "answerSubmitted",
      {
        correct,
      }
    );

    io.to(pin).emit(
      "playersUpdate",
      leaderboardWithStatus(room)
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
  console.log(
    `Server running on port ${PORT}`
  );
});
````
