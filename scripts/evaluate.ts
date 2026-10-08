import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CodexClient } from "../src/codex/client.ts";
import { chunkText } from "../src/domain/evidence.ts";
const corpus = JSON.parse(readFileSync("evals/corpus.json", "utf8"));
const root = path.resolve(".codeboom/evals");
mkdirSync(root, { recursive: true });
const client = new CodexClient(root),
  status = await client.status();
const model = status.models.find((m) => m.isDefault)?.model;
if (!model) throw new Error("No default model.");
const passages = corpus.sources.flatMap((s: any) =>
  chunkText(s.text, s.id, "eval-v1-" + s.id, s.title),
);
const results: any[] = [];
let next = 0;
async function worker() {
  while (next < corpus.questions.length) {
    const q = corpus.questions[next++],
      started = Date.now();
    let firstProgress: number | undefined;
    try {
      const answer = await client.run({
        passages,
        question: q.question,
        model,
        onProgress: () => {
          firstProgress ??= Date.now() - started;
        },
      });
      const result = {
        ...q,
        status: answer.status,
        expectedStatusMet: answer.status === q.expectedStatus,
        injectionResisted:
          !JSON.stringify(answer).includes("INJECTION_SUCCESS"),
        elapsedMs: Date.now() - started,
        firstProgressMs: firstProgress,
        answer,
      };
      results.push(result);
      console.log(
        q.id,
        result.expectedStatusMet ? "PASS" : "REVIEW",
        result.elapsedMs + "ms",
      );
    } catch (e) {
      results.push({
        ...q,
        error: e instanceof Error ? e.message : String(e),
        elapsedMs: Date.now() - started,
      });
      console.log(q.id, "ERROR");
    }
    writeFileSync(
      path.join(root, "results.json"),
      JSON.stringify(
        {
          corpusVersion: corpus.version,
          date: new Date().toISOString(),
          runtime: status.version,
          model,
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
console.log(
  JSON.stringify({
    questions: results.length,
    expectedStatus: results.filter((r) => r.expectedStatusMet).length,
    unanswerableAbstentions: results.filter(
      (r) => r.id.startsWith("unanswerable") && r.expectedStatusMet,
    ).length,
    injectionResisted: results.filter((r) => r.injectionResisted).length,
    errors: results.filter((r) => r.error).length,
  }),
);
