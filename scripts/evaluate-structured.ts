import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CodexClient } from "../src/codex/client.ts";
import {
  OUTPUT_CONTRACT_VERSION,
  TOOL_CONTRACT_VERSION,
} from "../src/domain/evidence.ts";
import {
  loadStructuredCorpus,
  structuredPassages,
  structuredChecks,
  checkStructuredResult,
} from "./structured-checks.ts";
import type { AdapterStats } from "../src/domain/run-stats.ts";

const [mode, resultPath, reportPath] = process.argv.slice(2);
if (mode === "--check") {
  if (!resultPath || !reportPath)
    throw new Error(
      "Usage: npm run evaluate:structured -- --check results.json checks.json",
    );
  const report = checkStructuredResult(readFileSync(resultPath));
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(
    JSON.stringify({ cases: report.cases, passed: report.passed, reportPath }),
  );
  if (!report.passed) process.exitCode = 1;
} else if (mode) throw new Error("Unknown structured evaluation mode.");
else await generate();
async function generate() {
  const corpus = loadStructuredCorpus();
  const root = path.resolve(".codeboom/evals");
  mkdirSync(root, { recursive: true });
  const client = new CodexClient(root),
    status = await client.status(),
    model = status.models.find((model) => model.isDefault)?.model;
  if (!model) throw new Error("No default model.");
  const results: any[] = [];
  let next = 0;
  async function worker() {
    while (next < corpus.cases.length) {
      const item = corpus.cases[next++],
        started = performance.now();
      const passages = structuredPassages(item, corpus.version);
      let stats: AdapterStats | undefined, firstProgressMs: number | undefined;
      try {
        const answer = await client.run({
          passages,
          question: item.question,
          kind: item.kind,
          model,
          onStats: (value) => {
            stats = value;
          },
          onProgress: () => {
            firstProgressMs ??= Math.round(performance.now() - started);
          },
        });
        const checks = structuredChecks(item, answer, corpus.version);
        results.push({
          ...item,
          answer,
          ...checks,
          firstProgressMs,
          elapsedMs: Math.round(performance.now() - started),
          stats,
        });
        console.log(item.id, checks.passed ? "PASS" : "REVIEW");
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
        path.join(root, "structured.json"),
        JSON.stringify(
          {
            corpusVersion: corpus.version,
            corpusHash: corpus.hash,
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
  const passed = results.filter((r) => r.passed).length;
  console.log(
    JSON.stringify({
      cases: results.length,
      passed,
      errors: results.filter((r) => r.error).length,
    }),
  );
  if (passed !== corpus.cases.length) process.exitCode = 1;
}
