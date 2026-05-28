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
  const usedVerses = new Set();

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
    console.log(booksData);

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
    console.log(chapterData);

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
    text: verses
      .map((v) => v.text)
      .join(" "),
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

  const valid = rawQuestions
    .filter(
      (q) =>
        q &&
        typeof q.question ===
          "string"
    )
    .filter(
      (q) =>
        q.question.includes("(") &&
        q.question.includes(")")
    )
    .map((q) => {
      if (
        q.type === "fill" ||
        q.type === "direct" ||
        q.type === "rapid"
      ) {
        return {
          type: q.type,
          question: q.question,
          answer: String(
            q.answer || ""
          ).trim(),
        };
      }

      const options =
        Array.isArray(q.options)
          ? q.options
              .map((o) =>
                String(o).trim()
              )
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
        !uniqueOptions.includes(
          answer
        )
      ) {
        return null;
      }

      return {
        type: "mcq",
        question: q.question,
        options: shuffle(
          uniqueOptions
        ),
        answer,
      };
    })
    .filter(Boolean);

  return valid.slice(0, count);
}

async function generateAiQuestions(
  book,
  chapter,
  verses,
  count = 20,
  type = "mcq"
) {
  const shuffledVerses =
    shuffle(verses);

  const verseText =
    shuffledVerses
      .map(
        (v) =>
          `${book} ${chapter}:${v.verse} - ${clean(v.text)}`
      )
      .join("\n");

  const prompt = `
You are creating Bible memory-verse drill questions from NIV scripture.

IMPORTANT:
- Create MANY questions from EACH verse.
- Extract every possible phrase, noun, action, and statement.
- Questions should help children memorize scripture word-for-word.
- Use exact NIV wording only.
- NEVER paraphrase.
- NEVER summarize.
- Ask short direct questions.
- Generate multiple questions from the SAME verse.
- Focus on phrase-by-phrase extraction.
- Questions should feel like Bible Bowl memory drills.
- Answers must match scripture wording exactly.

- EVERY question MUST include the Bible reference at the END.

GOOD EXAMPLES:
- What appeared? (1 John 1:2)
- What do we testify to? (1 John 1:2)
- What is God? (1 John 1:5)

QUESTION TYPES:
1. direct
2. rapid
3. fill
4. mcq

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
            "You create Bible memory questions from supplied NIV scripture only.",
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

  io.to(pin).emit(
    "question",
    {
      number:
        room.currentQuestion + 1,
      total:
        room.questions.length,
      ...q,
      timeLeft:
        QUESTION_TIME,
    }
  );
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
          room.questions
        );

        io.to(pin).emit(
          "question",
          {
            number: 1,
            total:
              room.questions
                .length,
            ...room.questions[0],
            timeLeft:
              QUESTION_TIME,
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

      socket.emit(
        "answerResult",
        {
          correct,
          correctAnswer:
            q.answer,
        }
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

app.get(
  /.*/,
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "client",
        "dist",
        "index.html"
      )
    );
  }
);

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