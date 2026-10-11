import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CodexClient } from "../src/codex/client.ts";
import { GenerationError } from "../src/codex/errors.ts";
import {
  chunkText,
  validateAnswer,
  OUTPUT_CONTRACT_VERSION,
  TOOL_CONTRACT_VERSION,
} from "../src/domain/evidence.ts";
import { exportInfographic } from "../src/domain/export-infographic.ts";
import { imageDimensions } from "../src/ingestion/ocr.ts";
import type { AdapterStats } from "../src/domain/run-stats.ts";

const corpusBytes = readFileSync(
  "tests/fixtures/evaluation/infographic-corpus.json",
);
const corpus = JSON.parse(corpusBytes.toString()) as {
  version: number;
  cases: {
    id: string;
    expectedStatus: string;
    sources: { id: string; title: string; text: string }[];
    question: string;
    requiredPatterns: string[];
    maxCards?: number;
    expectedLayout?: string;
    requiresWarning?: boolean;
  }[];
};
const root = path.resolve(".codeboom/evals");
mkdirSync(root, { recursive: true });
const client = new CodexClient(root),
  status = await client.status();
const model = status.models.find((model) => model.isDefault)?.model;
if (!model) throw Error("No default model.");
const selected = process.argv.slice(2);
if (selected.some((id) => !corpus.cases.some((item) => item.id === id)))
  throw Error("Unknown infographic case.");
const cases = selected.length
  ? corpus.cases.filter((item) => selected.includes(item.id))
  : corpus.cases;
const resultPath = path.join(
  root,
  selected.length
    ? `infographic-${selected.join("-")}.json`
    : "infographic.json",
);
const results: unknown[] = [];
let passed = 0;
for (const item of cases) {
  const started = performance.now();
  const passages = item.sources.flatMap((source) =>
    chunkText(
      source.text,
      source.id,
      `infographic-v${corpus.version}-${item.id}-${source.id}`,
      source.title,
    ),
  );
  let stats: AdapterStats | undefined;
  try {
    const answer = await client.run({
      passages,
      question: item.question,
      kind: "infographic",
      model,
      onStats: (value) => {
        stats = value;
      },
    });
    validateAnswer(answer, passages, "infographic");
    const text = answer.blocks
      .filter((block) => block.kind !== "notice")
      .map((block) => block.text)
      .join("\n");
    const checks = {
      structuralValidation: true,
      expectedStatus: answer.status === item.expectedStatus,
      requiredText: item.requiredPatterns.every((pattern) =>
        new RegExp(pattern, "iu").test(text),
      ),
      sparseCount:
        item.maxCards === undefined ||
        answer.infographic!.cards.length <= item.maxCards,
      layout:
        !item.expectedLayout ||
        answer.infographic!.layout === item.expectedLayout,
      sparseWarning:
        !item.requiresWarning || answer.coverageWarnings.length > 0,
    };
    const images: unknown[] = [];
    if (answer.status === "answered")
      for (const format of ["svg", "png"] as const) {
        const bytes = await exportInfographic(
          answer.title,
          answer,
          (id) => passages.find((p) => p.id === id) ?? null,
          {
            revisionId: `evaluation-${item.id}`,
            created: new Date().toISOString(),
            authored: false,
            historical: false,
            available: true,
          },
          format,
        );
        const dimensions = format === "png" ? imageDimensions(bytes) : null;
        images.push({
          format,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          dimensions,
        });
        writeFileSync(
          path.join(root, `infographic-${item.id}.${format}`),
          bytes,
        );
      }
    const ok = Object.values(checks).every(Boolean);
    if (ok) passed++;
    results.push({
      ...item,
      passages,
      answer,
      checks,
      passed: ok,
      images,
      stats,
      elapsedMs: Math.round(performance.now() - started),
    });
    console.log(item.id, ok ? "PASS" : "REVIEW");
  } catch (error) {
    results.push({
      ...item,
      passages,
      error: error instanceof Error ? error.message : "Generation failed.",
      validationCause:
        error instanceof Error && error.cause instanceof Error
          ? error.cause.message
          : null,
      unverifiedDraft:
        error instanceof GenerationError ? (error.draft ?? null) : null,
      stats,
      elapsedMs: Math.round(performance.now() - started),
    });
    console.log(item.id, "ERROR");
  }
  writeFileSync(
    resultPath,
    JSON.stringify(
      {
        corpusVersion: corpus.version,
        corpusHash: createHash("sha256").update(corpusBytes).digest("hex"),
        outputContractVersion: OUTPUT_CONTRACT_VERSION,
        toolContractVersion: TOOL_CONTRACT_VERSION,
        runtime: status.version,
        model,
        date: new Date().toISOString(),
        concurrency: 1,
        semanticHumanReview:
          "pending; keyword and citation checks do not certify claim support",
        passed,
        results,
      },
      null,
      2,
    ),
  );
}
console.log(JSON.stringify({ cases: results.length, passed, resultPath }));
if (passed !== cases.length) process.exitCode = 1;
