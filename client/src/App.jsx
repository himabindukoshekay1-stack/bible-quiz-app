import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const socket = io();

const bibleBooks = {
  Genesis: 50,
  Exodus: 40,
  Leviticus: 27,
  Numbers: 36,
  Deuteronomy: 34,
  Joshua: 24,
  Judges: 21,
  Ruth: 4,
  "1 Samuel": 31,
  "2 Samuel": 24,
  "1 Kings": 22,
  "2 Kings": 25,
  "1 Chronicles": 29,
  "2 Chronicles": 36,
  Ezra: 10,
  Nehemiah: 13,
  Esther: 10,
  Job: 42,
  Psalms: 150,
  Proverbs: 31,
  Ecclesiastes: 12,
  "Song of Solomon": 8,
  Isaiah: 66,
  Jeremiah: 52,
  Lamentations: 5,
  Ezekiel: 48,
  Daniel: 12,
  Hosea: 14,
  Joel: 3,
  Amos: 9,
  Obadiah: 1,
  Jonah: 4,
  Micah: 7,
  Nahum: 3,
  Habakkuk: 3,
  Zephaniah: 3,
  Haggai: 2,
  Zechariah: 14,
  Malachi: 4,
  Matthew: 28,
  Mark: 16,
  Luke: 24,
  John: 21,
  Acts: 28,
  Romans: 16,
  "1 Corinthians": 16,
  "2 Corinthians": 13,
  Galatians: 6,
  Ephesians: 6,
  Philippians: 4,
  Colossians: 4,
  "1 Thessalonians": 5,
  "2 Thessalonians": 3,
  "1 Timothy": 6,
  "2 Timothy": 4,
  Titus: 3,
  Philemon: 1,
  Hebrews: 13,
  James: 5,
  "1 Peter": 5,
  "2 Peter": 3,
  "1 John": 5,
  "2 John": 1,
  "3 John": 1,
  Jude: 1,
  Revelation: 22,
};

function App() {
	

  const [role, setRole] = useState("");
  const [pin, setPin] = useState("");
  const [name, setName] = useState("");
  

  const [selectedBook, setSelectedBook] = useState("Genesis");
  const [selectedChapter, setSelectedChapter] = useState("1");

  const [questionCount, setQuestionCount] = useState(20);

  const [questionType, setQuestionType] =
    useState("mcq");

  const [question, setQuestion] = useState(null);

  const [timeLeft, setTimeLeft] = useState(30);

  const [message, setMessage] = useState("");

  const [leaderboard, setLeaderboard] =
    useState([]);

  const [correctAnswer, setCorrectAnswer] =
    useState("");

  const [answered, setAnswered] = useState(false);

  const [gameOver, setGameOver] = useState(false);

  const [typedAnswer, setTypedAnswer] =
    useState("");

  const [paused, setPaused] = useState(false);

  const joinUrl = window.location.origin;

  const playTimerSound = () => {
    const audio = new Audio(
      "https://actions.google.com/sounds/v1/alarms/beep_short.ogg"
    );

    audio.play().catch(() => {});
  };

  useEffect(() => {
    socket.on("connect", () => {
      console.log("Connected:", socket.id);
    });

    socket.on("connect_error", () => {
      setMessage("Server connection failed");
    });

    socket.on("roomCreated", setPin);

    socket.on("quizSet", ({ count }) => {
      setMessage(`Loaded ${count} questions`);
    });

    socket.on("playersUpdate", setLeaderboard);

    socket.on("question", (q) => {
      setQuestion(q);

      setTimeLeft(q.timeLeft);

      setCorrectAnswer("");

      setAnswered(false);

      setTypedAnswer("");

      setPaused(false);

      setGameOver(false);

      setMessage("");
    });

    socket.on("timer", (time) => {
      setTimeLeft(time);

      if (time <= 5 && time > 0) {
        playTimerSound();
      }
    });

    socket.on(
      "answerSubmitted",
      ({ correct }) => {
        setMessage(
          correct
            ? "Correct Answer!"
            : "Answer Submitted"
        );
      }
    );

    socket.on(
      "revealAnswer",
      ({ correctAnswer, leaderboard }) => {
        setCorrectAnswer(correctAnswer);

        setLeaderboard(leaderboard);

        setMessage(
          `Correct Answer: ${correctAnswer}`
        );
      }
    );

    socket.on("gamePaused", () => {
      setPaused(true);

      setMessage("Game Paused");
    });

    socket.on("gameResumed", () => {
      setPaused(false);

      setMessage("Game Resumed");
    });

    socket.on("gameExited", () => {
      window.location.reload();
    });

    socket.on("gameOver", ({ leaderboard }) => {
      setQuestion(null);

      setLeaderboard(leaderboard);

      setPaused(false);

      setGameOver(true);

      setMessage("Game Over");
    });

    socket.on("errorMessage", setMessage);

    return () => {
      socket.off();
    };
  }, []);

  const createRoom = () => {
    setRole("host");

    socket.emit("createRoom");
  };

  const joinRoom = () => {
    if (!pin || !name) {
      setMessage("Enter PIN and Name");

      return;
    }

    socket.emit("joinRoom", {
      pin,
      name,
    });

    setRole("player");
  };

  const loadQuiz = () => {
    socket.emit("setQuiz", {
      pin,
      book: selectedBook,
      chapter: selectedChapter,
      count: questionCount,
      type: questionType,
	  source,
    });
  };

  const startGame = () => {
    socket.emit("startGame", pin);
  };

  const pauseGame = () => {
    socket.emit("pauseGame", pin);
  };

  const resumeGame = () => {
    socket.emit("resumeGame", pin);
  };

  const exitGame = () => {
    socket.emit("exitGame", pin);

    window.location.reload();
  };

  const submitAnswer = (answer) => {
    if (
      answered ||
      correctAnswer ||
      !answer ||
      paused
    ) {
      return;
    }

    setAnswered(true);

    socket.emit("submitAnswer", {
      pin,
      answer,
    });

    setTypedAnswer("");
  };

  const exitToHome = () => {
    window.location.reload();
  };

  return (
    <div className="app">
      {!role && (
        <div className="card">
          <h1>NIV Bible Quiz</h1>

          <button onClick={createRoom}>
            Host Game
          </button>

          <hr />

          <input
            placeholder="Enter PIN"
            value={pin}
            onChange={(e) =>
              setPin(e.target.value)
            }
          />

          <input
            placeholder="Your Name"
            value={name}
            onChange={(e) =>
              setName(e.target.value)
            }
          />

          <button onClick={joinRoom}>
            Join Game
          </button>

          <p>{message}</p>
        </div>
      )}

      {role === "host" && (
        <div className="card">
          <h1>Host Screen</h1>

          <h2>PIN: {pin}</h2>

          {!question && !gameOver && (
            <>
              <h3>Select Book</h3>

              <select
                value={selectedBook}
                onChange={(e) => {
                  setSelectedBook(
                    e.target.value
                  );

                  setSelectedChapter("1");
                }}
              >
                {Object.keys(bibleBooks).map(
                  (book) => (
                    <option
                      key={book}
                      value={book}
                    >
                      {book}
                    </option>
                  )
                )}
              </select>

              <h3>Select Chapter</h3>

              <select
                value={selectedChapter}
                onChange={(e) =>
                  setSelectedChapter(
                    e.target.value
                  )
                }
              >
                {Array.from(
                  {
                    length:
                      bibleBooks[selectedBook],
                  },
                  (_, i) => i + 1
                ).map((chapter) => (
                  <option
                    key={chapter}
                    value={chapter}
                  >
                    Chapter {chapter}
                  </option>
                ))}
              </select>

              <h3>Questions</h3>

              <select
                value={questionCount}
                onChange={(e) =>
                  setQuestionCount(
                    Number(e.target.value)
                  )
                }
              >
                <option value={5}>
                  5 Questions
                </option>

                <option value={10}>
                  10 Questions
                </option>

                <option value={20}>
                  20 Questions
                </option>

                <option value={30}>
                  30 Questions
                </option>
              </select>

              <h3>Question Type</h3>

              <select
                value={questionType}
                onChange={(e) =>
                  setQuestionType(
                    e.target.value
                  )
                }
              >
                <option value="mcq">
                  Multiple Choice
                </option>

                <option value="direct">
                  Direct Questions
                </option>

                <option value="fill">
                  Fill in the Blanks
                </option>

                <option value="rapid">
                  Rapid Fire Questions
                </option>
              </select>
			  
			  <div style={{ marginTop: "10px" }}>
  <label>
    Question Source
  </label>

  <select
    value={source}
    onChange={(e) =>
      setSource(
        e.target.value
      )
    }
  >
    <option value="ai">
      AI Generated
    </option>

    <option value="adhoc">
      Adhoc Questions
    </option>

    <option value="mixed">
      Mixed
    </option>
  </select>
</div>

              <button onClick={loadQuiz}>
                Load Quiz
              </button>

              <button onClick={startGame}>
                Start Game
              </button>
            </>
          )}

          <p>{message}</p>

          {question && (
            <>
              <h2>
                Time Left: {timeLeft}
              </h2>

              {paused && (
                <h2>⏸ Game Paused</h2>
              )}

              <h3>
                Question {question.number} of{" "}
                {question.total}
              </h3>

              <h2>{question.question}</h2>

              {question.type === "mcq" && (
                <div className="grid">
                  {question.options.map(
                    (opt) => (
                      <div
                        key={opt}
                        className={
                          correctAnswer &&
                          opt === correctAnswer
                            ? "option correct"
                            : "option"
                        }
                      >
                        {opt}
                      </div>
                    )
                  )}
                </div>
              )}

              {[
                "fill",
                "direct",
                "rapid",
              ].includes(question.type) && (
                <h3>
                  Players must type the
                  answer
                </h3>
              )}

              {correctAnswer && (
                <h2>
                  Correct Answer:{" "}
                  {correctAnswer}
                </h2>
              )}
            </>
          )}

          <div className="host-controls">
            {question && !gameOver && (
              <>
                {!paused ? (
                  <button
                    onClick={pauseGame}
                  >
                    ⏸ Pause
                  </button>
                ) : (
                  <button
                    onClick={resumeGame}
                  >
                    ▶ Resume
                  </button>
                )}
              </>
            )}

            <button onClick={exitGame}>
              ❌ Exit
            </button>
          </div>

          <h3>Leaderboard</h3>

          {leaderboard.map((p, i) => (
            <p key={p.id}>
              {i + 1}. {p.name} -{" "}
              {p.score}
            </p>
          ))}
        </div>
      )}

      {role === "player" && (
        <div className="card">
          <h1>Player Screen</h1>

          <p>{message}</p>

          {paused && (
            <h2>⏸ Game Paused</h2>
          )}

          {question && !gameOver && (
            <>
              <h2>Time: {timeLeft}</h2>

              <h3>
                Question {question.number} of{" "}
                {question.total}
              </h3>

              <h2>{question.question}</h2>

              {question.type === "mcq" && (
                <div className="grid">
                  {question.options.map(
                    (opt) => (
                      <button
                        key={opt}
                        disabled={
                          answered ||
                          !!correctAnswer ||
                          paused
                        }
                        onClick={() =>
                          submitAnswer(opt)
                        }
                        className={
                          correctAnswer &&
                          opt === correctAnswer
                            ? "correct"
                            : ""
                        }
                      >
                        {opt}
                      </button>
                    )
                  )}
                </div>
              )}

              {[
                "fill",
                "direct",
                "rapid",
              ].includes(question.type) && (
                <div>
                  <input
                    placeholder="Type your answer"
                    value={typedAnswer}
                    disabled={
                      answered ||
                      !!correctAnswer ||
                      paused
                    }
                    onChange={(e) =>
                      setTypedAnswer(
                        e.target.value
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        submitAnswer(
                          typedAnswer
                        );
                      }
                    }}
                  />

                  <button
                    disabled={
                      answered ||
                      !!correctAnswer ||
                      paused
                    }
                    onClick={() =>
                      submitAnswer(
                        typedAnswer
                      )
                    }
                  >
                    Submit Answer
                  </button>
                </div>
              )}

              {correctAnswer && (
                <h2>
                  Correct Answer:{" "}
                  {correctAnswer}
                </h2>
              )}
            </>
          )}

          {!question && !gameOver && (
            <h2>Waiting for host...</h2>
          )}

          {gameOver && (
            <>
              <h2>Final Scores</h2>

              {leaderboard.map((p, i) => (
                <p key={p.id}>
                  {i + 1}. {p.name} -{" "}
                  {p.score}
                </p>
              ))}

              <button onClick={exitToHome}>
                Exit
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default App;