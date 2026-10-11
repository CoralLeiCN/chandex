import { mkdirSync, writeFileSync } from "node:fs";
import { CodexClient } from "../src/codex/client.ts";
import { CODEX_VERSION } from "../src/codex/config.ts";
import { WebResearchClient } from "../src/codex/web-research.ts";
mkdirSync(".codeboom/web-research-check", { recursive: true });
const client = new CodexClient(".codeboom/web-research-check");
const query =
  "Find official W3C documentation about PNG image textual metadata chunks.";
try {
  const result = await new WebResearchClient(client).discover({ query });
  if (
    !result.candidates.length ||
    !result.candidates.some((c) => new URL(c.url).hostname.endsWith("w3.org"))
  )
    throw Error("Probe did not find an official W3C candidate.");
  const record = {
    date: new Date().toISOString(),
    runtime: CODEX_VERSION,
    query,
    result,
    passed: true,
    limits: [
      "Synthetic live discovery probe only; no human search relevance assessment.",
      "No notebook data or instructions sent; no page imported by discovery.",
    ],
  };
  writeFileSync(
    "evals/results/2026-10-10-web-research-live-v1.json",
    JSON.stringify(record, null, 2) + "\n",
  );
  console.log(JSON.stringify(record, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
