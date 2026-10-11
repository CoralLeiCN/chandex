import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CodexClient } from "../src/codex/client.ts";
import {
  validateAnswer,
  OUTPUT_CONTRACT_VERSION,
  TOOL_CONTRACT_VERSION,
} from "../src/domain/evidence.ts";
import { loadStudyCorpus, studyPassages } from "./study-corpus.ts";
import { documentText } from "../src/domain/artifacts.ts";
import { exportMarkdown } from "../src/domain/export.ts";
import type { AdapterStats } from "../src/domain/run-stats.ts";
const corpus = loadStudyCorpus(),
  cases = corpus.cases;
const root = path.resolve(".codeboom/evals");
mkdirSync(root, { recursive: true });
const client = new CodexClient(root),
  status = await client.status();
const model = status.models.find((model) => model.isDefault)?.model;
if (!model) throw new Error("No default model.");
const results: any[] = [];
let next = 0;
async function worker() {
  while (next < cases.length) {
    const item = cases[next++],
      started = performance.now();
    let stats: AdapterStats | undefined, firstProgressMs: number | undefined;
    const passages = studyPassages(item, corpus.version);
    try {
      const answer = await client.run({
        passages,
        question: item.question,
        kind: item.kind,
        itemCount: corpus.requestedCount,
        model,
        onStats: (value) => {
          stats = value;
        },
        onProgress: () => {
          firstProgressMs ??= Math.round(performance.now() - started);
        },
      });
      validateAnswer(answer, passages, item.kind, corpus.requestedCount);
      const markdown = exportMarkdown(
        answer.title,
        answer,
        (id) => passages.find((p) => p.id === id) ?? null,
      );
      const statusMet = answer.status === item.expectedStatus;
      const countMet = item.id.endsWith("-sparse")
        ? answer.items!.length === 1 && answer.coverageWarnings.length > 0
        : item.expectedStatus === "answered"
          ? answer.items!.length > 0 &&
            answer.items!.length <= corpus.requestedCount
          : answer.items!.length === 0;
      const promotion = documentText(answer);
      const promotionSafe = !(answer.items ?? []).some((question) =>
        (question.options ?? [])
          .filter((o) => o.id !== question.correctOptionId)
          .some((o) => promotion.includes(o.text)),
      );
      const exportMet =
        answer.status === "insufficient_evidence" ||
        (markdown.includes(
          item.kind === "quiz" ? "## Question 1" : "## Card 1",
        ) &&
          markdown.includes("Evidence:"));
      results.push({
        ...item,
        answer,
        statusMet,
        countMet,
        promotionSafe,
        exportMet,
        firstProgressMs,
        elapsedMs: Math.round(performance.now() - started),
        stats,
      });
      console.log(
        item.id,
        statusMet && countMet && promotionSafe && exportMet ? "PASS" : "REVIEW",
      );
    } catch (error) {
      results.push({
        ...item,
        error: error instanceof Error ? error.message : "Generation failed.",
        firstProgressMs,
        elapsedMs: Math.round(performance.now() - started),
        stats,
      });
      console.log(item.id, "ERROR");
    }
    writeFileSync(
      path.join(root, "study.json"),
      JSON.stringify(
        {
          corpusVersion: corpus.version,
          corpusHash: corpus.hash,
          requestedCount: corpus.requestedCount,
          outputContractVersion: OUTPUT_CONTRACT_VERSION,
          toolContractVersion: TOOL_CONTRACT_VERSION,
          runtime: status.version,
          model,
          date: new Date().toISOString(),
          concurrency: 2,
          semanticHumanReview: "pending",
          results,
        },
        null,
        2,
      ),
    );
  }
}
await Promise.all([worker(), worker()]);
const passed = results.filter(
  (r) => r.statusMet && r.countMet && r.promotionSafe && r.exportMet,
).length;
console.log(
  JSON.stringify({
    cases: results.length,
    passed,
    errors: results.filter((r) => r.error).length,
  }),
);
if (passed !== cases.length) process.exitCode = 1;
