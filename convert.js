const fs = require("fs");

const text = fs.readFileSync(
  "./questions/colossians1.txt",
  "utf8"
);

const lines = text
  .split(/\r?\n/)
  .map(line => line.trim());

const questions = [];

let currentReference = "Colossians 1";

for (let i = 0; i < lines.length; i++) {

  const line = lines[i];

  // Reference
  if (/^Colossians\s+\d+:\d+/i.test(line)) {
    currentReference = line;
    continue;
  }

  // Question
  if (line.endsWith("?")) {

    const options = [];

    let j = i + 1;

    while (j < lines.length) {

      const current = lines[j];

      if (/^[A-D]\)/.test(current)) {
        options.push(
          current.replace(/^[A-D]\)\s*/, "")
        );
      }

      if (
        current.startsWith("Answer:")
      ) {

        const answer =
          current
            .replace(
              /^Answer:\s*[A-D]\)\s*/,
              ""
            )
            .trim();

        if (options.length === 4) {

          questions.push({
            type: "mcq",
            book: "Colossians",
            chapter: 1,
            reference: currentReference,
            question: `${line} (${currentReference})`,
            options,
            answer
          });

        }

        break;
      }

      j++;
    }
  }
}

fs.writeFileSync(
  "./questions/colossians1.json",
  JSON.stringify(
    questions,
    null,
    2
  )
);

console.log(
  `Converted ${questions.length} questions`
);