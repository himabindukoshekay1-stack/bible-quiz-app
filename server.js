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
  return Math.floor(
    100000 + Math.random() * 900000
  ).toString();
}

function clean(text) {
  return String(text || "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function shuffle(arr) {
  return [...arr].sort(
    () => Math.random() - 0.5
  );
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

function removeDuplicateQuestions(
  questions
) {
  const usedConcepts =
    new Set();

  return questions.filter((q) => {
    const question =
      q.question.toLowerCase();

    const concept = question
      .replace(/\(.*?\)/g, "")
      .replace(/[^\w\s]/g, "")
      .split(" ")
      .slice(0, 6)
      .join(" ");

    if (
      usedConcepts.has(concept)
    ) {
      return false;
    }

    usedConcepts.add(concept);

    return true;
  });
}

async function getBibleChapter(
  book,
  chapter
) {
  const bibleId =
    process.env.NIV_BIBLE_ID;

  const apiKey =
    process.env.API_BIBLE_KEY;

  const booksRes = await fetch(
    `https://rest.api.bible/v1/bibles/${bibleId}/books`,
    {
      headers: {
        "api-key": apiKey,
        "Content-Type":
          "text/plain",
      },
    }
  );

  const booksData =
    await booksRes.json();

  if (!booksData.data) {
    throw new Error(
      "Failed to fetch NIV books"
    );
  }

  const matchedBook =
    booksData.data.find(
      (b) =>
        b.name.toLowerCase() ===
          book.toLowerCase() ||
        b.nameLong.toLowerCase() ===
          book.toLowerCase()
    );

  if (!matchedBook) {
    throw new Error(
      `Book not found: ${book}`
    );
  }

  const chaptersRes = await fetch(
    `https://rest.api.bible/v1/bibles/${bibleId}/books/${matchedBook.id}/chapters`,
    {
      headers: {
        "api-key": apiKey,
        "Content-Type":
          "text/plain",
      },
    }
  );

  const chaptersData =
    await chaptersRes.json();

  const matchedChapter =
    chaptersData.data.find(
      (c) =>
        c.number ===
        String(chapter)
    );

  if (!matchedChapter) {
    throw new Error(
      `Chapter not found: ${chapter}`
    );
  }

  const chapterRes = await fetch(
    `https://rest.api.bible/v1/bibles/${bibleId}/chapters/${matchedChapter.id}?content-type=text&include-notes=false&include-titles=false&include-chapter-numbers=false&include-verse-numbers=true`,
    {
      headers: {
        "api-key": apiKey,
        "Content-Type":
          "text/plain",
      },
    }
  );

  const chapterData =
    await chapterRes.json();

  if (
    !chapterData.data ||
    !chapterData.data.content
  ) {
    throw new Error(
      "Failed to fetch NIV chapter"
    );
  }

  const content =
    chapterData.data.content;

  const lines = content
    .split("\n")
    .map((line) =>
      line.trim()
    )
    .filter(Boolean);

  const verses = [];

  for (const line of lines) {
    const match = line.match(
      /^(\d+)\s+(.*)$/
    );

    if (!match) continue;

    verses.push({
      verse: match[1],
      text: match[2].trim(),
    });
  }

  return {
    verses,
  };
}

function validateQuestions(
  rawQuestions,
  count
) {
  if (!Array.isArray(rawQuestions)) {
    return [];
  }

  return rawQuestions
    .filter(
      (q) =>
        q &&
        q.question &&
        q.answer
    )
    .slice(0, count);
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
You are creating Bible memory drill questions from NIV scripture.

IMPORTANT:
- Use ONLY exact NIV wording.
- NEVER paraphrase.
- EVERY question must include the Bible reference.
- Generate MANY questions from each verse.
- Questions should feel like Bible Bowl memory drills.

QUESTION TYPES:
1. mcq
2. direct
3. fill
4. rapid

Generate ONLY "${type}" questions.

Generate ${count * 5} questions.

Use ONLY these verses:
${verseText}

Return ONLY valid JSON array.
`;

  const response =
    await openai.chat.completions.create({
      model: "gpt-4o-mini",

      temperature: 0.3,

      messages: [
        {
          role: "system",
          content:
            "You create Bible memory questions from NIV scripture only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

  const text =
    response.choices[0].message
      .content || "";

  const parsed =
    safeJsonParse(text);

  const validated =
    validateQuestions(
      parsed,
      count * 5
    );

  const unique =
    removeDuplicateQuestions(
      validated
    );

  return unique.slice(0, count);
}

async function generateQuestions(
  book,
  chapter,
  count = 20,
  type = "mcq"
) {
  const bibleData =
    await getBibleChapter(
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

function sendQuestion(pin) {
  const room = rooms[pin];

  if (!room) return;

  const q =
    room.questions[
      room.currentQuestion
    ];

  if (!q) return;

  room.answers = {};

  room.timeLeft =
    QUESTION_TIME;

  io.to(pin).emit(
    "question",
    {
      number:
        room.currentQuestion + 1,
      total:
        room.questions.length,
      ...q,
      timeLeft:
        room.timeLeft,
    }
  );

  room.timer = setInterval(() => {
    room.timeLeft--;

    io.to(pin).emit(
      "timer",
      room.timeLeft
    );

    if (room.timeLeft <= 0) {
      clearInterval(
        room.timer
      );

      io.to(pin).emit(
        "revealAnswer",
        {
          correctAnswer:
            q.answer,
        }
      );

      setTimeout(() => {
        room.currentQuestion++;

        if (
          room.currentQuestion >=
          room.questions.length
        ) {
          io.to(pin).emit(
            "gameOver",
            {}
          );

          return;
        }

        sendQuestion(pin);
      }, REVEAL_TIME * 1000);
    }
  }, 1000);
}

io.on("connection", (socket) => {
  socket.on(
    "createRoom",
    () => {
      const pin =
        createPin();

      rooms[pin] = {
        host: socket.id,
        players: {},
        questions: [],
        currentQuestion: 0,
      };

      socket.join(pin);

      socket.emit(
        "roomCreated",
        pin
      );
    }
  );

  socket.on(
    "setQuiz",
    async ({
      pin,
      book,
      chapter,
      count,
      type,
    }) => {
      try {
        const room =
          rooms[pin];

        room.questions =
          await generateQuestions(
            book,
            chapter,
            count,
            type
          );

        room.currentQuestion = 0;

        socket.emit(
          "quizSet",
          {
            count:
              room.questions
                .length,
          }
        );
      } catch (e) {
        console.error(e);

        socket.emit(
          "errorMessage",
          e.message
        );
      }
    }
  );

  socket.on(
    "startGame",
    (pin) => {
      const room =
        rooms[pin];

      if (!room) return;

      room.currentQuestion = 0;

      sendQuestion(pin);
    }
  );

  socket.on(
    "joinRoom",
    ({ pin, name }) => {
      const room =
        rooms[pin];

      if (!room) return;

      room.players[socket.id] = {
        id: socket.id,
        name,
        score: 0,
      };

      socket.join(pin);

      io.to(pin).emit(
        "playersUpdate",
        Object.values(
          room.players
        )
      );
    }
  );

  socket.on(
    "submitAnswer",
    ({ pin, answer }) => {
      const room =
        rooms[pin];

      if (!room) return;

      const player =
        room.players[socket.id];

      if (!player) return;

      const q =
        room.questions[
          room.currentQuestion
        ];

      if (!q) return;

      const correct =
        String(answer)
          .trim()
          .toLowerCase() ===
        String(q.answer)
          .trim()
          .toLowerCase();

      if (correct) {
        player.score +=
          100 +
          room.timeLeft * 10;
      }

      socket.emit(
        "answerSubmitted",
        {
          correct,
        }
      );

      io.to(pin).emit(
        "playersUpdate",
        Object.values(
          room.players
        )
      );
    }
  );
});

app.use(
  express.static(
    path.join(
      __dirname,
      "client",
      "dist"
    )
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

const PORT =
  process.env.PORT || 4000;

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Server running on port ${PORT}`
    );
  }
);