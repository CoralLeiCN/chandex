import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CodexClient } from "../src/codex/client.ts";
import {
  chunkText,
  validateAnswer,
  OUTPUT_CONTRACT_VERSION,
  TOOL_CONTRACT_VERSION,
} from "../src/domain/evidence.ts";
import { exportPptx } from "../src/domain/export-pptx.ts";
import { officePackage } from "../src/ingestion/office-package.ts";
import type { AdapterStats } from "../src/domain/run-stats.ts";

const corpusBytes = readFileSync(
  "tests/fixtures/evaluation/slides-corpus.json",
);
const corpus = JSON.parse(corpusBytes.toString()) as {
  version: number;
  cases: {
    id: string;
    expectedStatus: string;
    sources: { id: string; title: string; text: string }[];
    question: string;
    requiredPatterns: string[];
    maxSlides?: number;
    requiresSpeakerNote?: boolean;
    requiresWarning?: boolean;
  }[];
};
const root = path.resolve(".codeboom/evals");
mkdirSync(root, { recursive: true });
const client = new CodexClient(root),
  status = await client.status();
const model = status.models.find((model) => model.isDefault)?.model;
if (!model) throw Error("No default model.");
const resultPath = path.join(root, "slides.json");
const results: unknown[] = [];
let passed = 0;
for (const item of corpus.cases) {
  const started = performance.now();
  const passages = item.sources.flatMap((source) =>
    chunkText(
      source.text,
      source.id,
      `slides-v${corpus.version}-${item.id}-${source.id}`,
      source.title,
    ),
  );
  let stats: AdapterStats | undefined;
  try {
    const answer = await client.run({
      passages,
      question: item.question,
      kind: "slides",
      model,
      onStats: (value) => {
        stats = value;
      },
    });
    validateAnswer(answer, passages, "slides");
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
      sparseCount: !item.maxSlides || answer.slides!.length <= item.maxSlides,
      speakerNote:
        !item.requiresSpeakerNote ||
        answer.slides!.some((slide) => slide.noteBlockIndexes.length > 0),
      sparseWarning:
        !item.requiresWarning || answer.coverageWarnings.length > 0,
    };
    let powerpoint: unknown = null;
    if (answer.status === "answered") {
      const bytes = await exportPptx(
        answer.title,
        answer,
        (id) => passages.find((passage) => passage.id === id) ?? null,
        {
          revisionId: `evaluation-${item.id}`,
          created: new Date().toISOString(),
          authored: false,
          historical: false,
          available: true,
        },
      );
      const pkg = await officePackage(bytes);
      powerpoint = {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        contentSlides: answer.slides!.length,
        archiveSlides: [...pkg.names].filter((name) =>
          /^ppt\/slides\/slide\d+\.xml$/.test(name),
        ).length,
      };
      writeFileSync(path.join(root, `slides-${item.id}.pptx`), bytes);
    }
    const ok = Object.values(checks).every(Boolean);
    if (ok) passed++;
    results.push({
      ...item,
      passages,
      answer,
      checks,
      passed: ok,
      powerpoint,
      stats,
      elapsedMs: Math.round(performance.now() - started),
    });
    console.log(item.id, ok ? "PASS" : "REVIEW");
  } catch (error) {
    results.push({
      ...item,
      passages,
      error: error instanceof Error ? error.message : "Generation failed.",
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
if (passed !== corpus.cases.length) process.exitCode = 1;
