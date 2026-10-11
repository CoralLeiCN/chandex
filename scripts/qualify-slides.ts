import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { exportPptx } from "../src/domain/export-pptx.ts";
import {
  validateAnswer,
  type Answer,
  type Passage,
} from "../src/domain/evidence.ts";

// Reassemble preserved synthetic cases with the current writer, without model calls.
const resultFile =
  process.argv[2] ?? "evals/results/2026-10-10-slides-model-v7.json";
const outputRoot = path.resolve(process.argv[3] ?? "tmp/pdfs/slides");
const input = readFileSync(resultFile);
const results = JSON.parse(input.toString()) as {
  results: {
    id: string;
    passed: boolean;
    answer: Answer;
    passages: Passage[];
  }[];
};
mkdirSync(outputRoot, { recursive: true });
const outputs = [];
for (const item of results.results) {
  if (!/^[a-z0-9-]{1,80}$/.test(item.id) || !item.passed)
    throw Error("Expected qualified synthetic slide cases with safe IDs.");
  validateAnswer(item.answer, item.passages, "slides");
  if (item.answer.status === "insufficient_evidence") continue;
  const bytes = await exportPptx(
    item.answer.title,
    item.answer,
    (id) => item.passages.find((p) => p.id === id) ?? null,
    {
      revisionId: `qualification-${item.id}`,
      created: new Date().toISOString(),
      authored: false,
      historical: false,
      available: true,
    },
  );
  const file = path.join(outputRoot, `${item.id}.pptx`);
  writeFileSync(file, bytes);
  outputs.push({
    id: item.id,
    file,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentSlides: item.answer.slides!.length,
    expectedPages: item.answer.slides!.length + 1,
  });
}
writeFileSync(
  path.join(outputRoot, "assembly.json"),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      resultFile,
      inputHash: createHash("sha256").update(input).digest("hex"),
      outputs,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ outputRoot, decks: outputs.length }));
