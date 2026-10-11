import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  validateAnswer,
  OUTPUT_CONTRACT_VERSION,
  type Answer,
  type Passage,
} from "../src/domain/evidence.ts";
import { exportInfographic } from "../src/domain/export-infographic.ts";
import { imageDimensions } from "../src/ingestion/ocr.ts";

// Reconstruct preserved synthetic outputs with current validators/encoders.
// This does not make a model request or erase the initial failed attempt.
const inputs = [
  "evals/results/2026-10-10-infographic-model-v8-initial.json",
  "evals/results/2026-10-10-infographic-steps-v8.json",
];
type Result = {
  id: string;
  answer?: Answer;
  passages: Passage[];
  error?: string;
};
const records = inputs.map((file) => {
  const bytes = readFileSync(file);
  return {
    file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    record: JSON.parse(bytes.toString()) as { date: string; results: Result[] },
  };
});
const corpusBytes = readFileSync(
    "tests/fixtures/evaluation/infographic-corpus.json",
  ),
  corpus = JSON.parse(corpusBytes.toString()) as {
    version: number;
    cases: {
      id: string;
      expectedStatus: string;
      expectedLayout?: string;
      maxCards?: number;
      requiredPatterns: string[];
      requiresWarning?: boolean;
    }[];
  };
const output = path.resolve(".codeboom/infographic-native-v8");
mkdirSync(output, { recursive: true });
const results = [];
for (const item of corpus.cases) {
  const candidate = [...records]
      .reverse()
      .find((r) => r.record.results.some((x) => x.id === item.id && x.answer)),
    selected = candidate?.record.results.find(
      (x) => x.id === item.id && x.answer,
    );
  if (!candidate || !selected?.answer)
    throw Error(`No accepted synthetic output for ${item.id}`);
  const answer = validateAnswer(
      selected.answer,
      selected.passages,
      "infographic",
    ),
    text = answer.blocks
      .filter((b) => b.kind !== "notice")
      .map((b) => b.text)
      .join("\n");
  const checks = {
    structureAndExactCitations: true,
    expectedStatus: answer.status === item.expectedStatus,
    layout:
      !item.expectedLayout ||
      answer.infographic!.layout === item.expectedLayout,
    sparseCount:
      item.maxCards === undefined ||
      answer.infographic!.cards.length <= item.maxCards,
    requiredText: item.requiredPatterns.every((p) =>
      new RegExp(p, "iu").test(text),
    ),
    warning: !item.requiresWarning || answer.coverageWarnings.length > 0,
  };
  if (!Object.values(checks).every(Boolean))
    throw Error(`Preserved output failed current criteria: ${item.id}`);
  const images = [];
  if (answer.status === "answered")
    for (const format of ["png", "svg"] as const) {
      const bytes = await exportInfographic(
          answer.title,
          answer,
          (id) => selected.passages.find((p) => p.id === id) ?? null,
          {
            revisionId: `evaluation-${item.id}`,
            created: candidate.record.date,
            authored: false,
            historical: false,
            available: true,
          },
          format,
        ),
        file = path.join(output, `${item.id}.${format}`);
      writeFileSync(file, bytes);
      if (format === "svg") {
        const decoded = await loadImage(bytes),
          canvas = createCanvas(decoded.width, decoded.height);
        canvas.getContext("2d").drawImage(decoded, 0, 0);
        writeFileSync(
          path.join(output, `${item.id}-svg-render.png`),
          await canvas.encode("png"),
        );
      }
      images.push({
        file,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        dimensions: format === "png" ? imageDimensions(bytes) : null,
      });
    }
  results.push({
    id: item.id,
    input: candidate.file,
    checks,
    images,
    initialFailure:
      records[0].record.results.find((x) => x.id === item.id)?.error ?? null,
  });
}
const record = {
  date: new Date().toISOString(),
  outputContract: OUTPUT_CONTRACT_VERSION,
  corpusVersion: corpus.version,
  corpusSha256: createHash("sha256").update(corpusBytes).digest("hex"),
  inputs: records.map(({ file, sha256 }) => ({ file, sha256 })),
  providerRequests: 0,
  criteriaCorrection:
    "The conditional case's former two-card bound was stricter than its request and the product contract. Three independent cited facts may use three cards. Original 3/5 result and withheld steps validation failure remain preserved; a separate steps retry passed.",
  semanticHumanReview:
    "pending; keyword and exact-span checks do not certify semantic support or process order",
  results,
};
writeFileSync(
  path.join(output, "qualification.json"),
  JSON.stringify(record, null, 2),
);
console.log(
  JSON.stringify({ cases: results.length, passed: results.length, output }),
);
