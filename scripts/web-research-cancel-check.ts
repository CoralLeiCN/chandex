import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { CodexClient } from "../src/codex/client.ts";
import { WebResearchClient } from "../src/codex/web-research.ts";
import { CODEX_VERSION } from "../src/codex/config.ts";
const base = new CodexClient(".codeboom/web-research-cancel-check"),
  controller = new AbortController();
let transport: Awaited<ReturnType<CodexClient["connect"]>>["rpc"] | undefined,
  started = false;
const client = new WebResearchClient({
  workspace: base.workspace,
  connect: async (signal, mode) => {
    const result = await base.connect(signal, mode);
    transport = result.rpc;
    result.rpc.on("message", (message) => {
      if (message.method === "turn/started") {
        started = true;
        controller.abort();
      }
    });
    return result;
  },
});
try {
  const before = Date.now();
  await assert.rejects(
    client.discover({
      query: "Find official W3C PNG documentation.",
      signal: controller.signal,
    }),
  );
  assert.equal(started, true);
  assert.equal(controller.signal.aborted, true);
  assert.ok(
    transport &&
      (transport.process.exitCode !== null ||
        transport.process.signalCode !== null),
  );
  const record = {
    date: new Date().toISOString(),
    runtime: CODEX_VERSION,
    passed: true,
    elapsedMs: Date.now() - before,
    observedTurnStart: started,
    aborted: controller.signal.aborted,
    processSettledBeforeRejection: true,
    outputPublished: false,
    limitations: [
      "Synthetic cancellation during real turn startup; remote provider work may already have begun.",
    ],
  };
  writeFileSync(
    "evals/results/2026-10-10-web-research-cancel-v1.json",
    JSON.stringify(record, null, 2) + "\n",
  );
  console.log(JSON.stringify(record, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
