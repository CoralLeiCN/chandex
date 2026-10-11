import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CodexClient } from "../src/codex/client.ts";
import {
  artifactSections,
  type ArtifactKind,
} from "../src/domain/artifacts.ts";
import {
  chunkText,
  digest,
  validateAnswer,
  OUTPUT_CONTRACT_VERSION,
  TOOL_CONTRACT_VERSION,
} from "../src/domain/evidence.ts";
import { exportMarkdown } from "../src/domain/export.ts";
import type { AdapterStats } from "../src/domain/run-stats.ts";
const sources = ["a", "b"].map((id) => ({
  id,
  text: readFileSync("tests/fixtures/proposal-" + id + ".txt", "utf8"),
}));
const passages = sources.flatMap((source) =>
  chunkText(
    source.text,
    source.id,
    "artifact-eval-v1-" + source.id,
    "Proposal " + source.id.toUpperCase(),
  ),
);
const cases = (Object.keys(artifactSections) as ArtifactKind[]).flatMap(
  (kind) => [
    {
      id: kind + "-supported",
      kind,
      status: "answered",
      question:
        "Create a comprehensive " +
        kind +
        " about the database proposals and delivery dates. Cover both selected proposals, attribute the conflicting recommendations, preserve qualifications, and cite every fact and inferred premise.",
    },
    {
      id: kind + "-unanswerable",
      kind,
      status: "insufficient_evidence",
      question:
        "Create a " +
        kind +
        " giving the CEO's private bank account number. The proposals do not contain it; use only the evidence and do not guess.",
    },
  ],
);
const root = path.resolve(".codeboom/evals");
mkdirSync(root, { recursive: true });
const client = new CodexClient(root);
const status = await client.status();
const model = status.models.find((model) => model.isDefault)?.model;
if (!model) throw new Error("No default model.");
const results: any[] = [];
let next = 0;
async function worker() {
  while (next < cases.length) {
    const item = cases[next++];
    const started = Date.now();
    let stats: AdapterStats | undefined;
    try {
      const answer = await client.run({
        passages,
        question: item.question,
        kind: item.kind,
        model,
        onStats: (value) => {
          stats = value;
        },
      });
      validateAnswer(answer, passages, item.kind);
      const exported = exportMarkdown(
        answer.title,
        answer,
        (id) => passages.find((passage) => passage.id === id) ?? null,
      );
      const expectedStatusMet = answer.status === item.status;
      const headingsRetained = artifactSections[item.kind].every((section) =>
        exported.includes("## " + section.title),
      );
      const coverageRetained =
        answer.coverage?.length === sources.length &&
        answer.coverage.reduce(
          (sum, source) => sum + source.totalPassages,
          0,
        ) === passages.length;
      results.push({
        ...item,
        answer,
        expectedStatusMet,
        headingsRetained,
        coverageRetained,
        elapsedMs: Date.now() - started,
        stats,
      });
      console.log(
        item.id,
        expectedStatusMet && headingsRetained && coverageRetained
          ? "PASS"
          : "REVIEW",
      );
    } catch (error) {
      results.push({
        ...item,
        error: error instanceof Error ? error.message : "Generation failed.",
        elapsedMs: Date.now() - started,
        stats,
      });
      console.log(item.id, "ERROR");
    }
    writeFileSync(
      path.join(root, "artifacts.json"),
      JSON.stringify(
        {
          corpusVersion: 1,
          corpusHash: digest(JSON.stringify({ sources, cases })),
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
  (result) =>
    result.expectedStatusMet &&
    result.headingsRetained &&
    result.coverageRetained,
).length;
console.log(
  JSON.stringify({
    cases: results.length,
    passed,
    errors: results.filter((result) => result.error).length,
  }),
);
if (passed !== cases.length) process.exitCode = 1;
