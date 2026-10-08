import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CodexClient } from "../src/codex/client.ts";
import { chunkText } from "../src/domain/evidence.ts";
const root = path.resolve(".codeboom/harness");
mkdirSync(root, { recursive: true });
const passages = ["a", "b"].flatMap((x) =>
  chunkText(
    readFileSync("tests/fixtures/proposal-" + x + ".txt", "utf8"),
    "source-" + x,
    "revision-" + x,
    "Proposal " + x.toUpperCase(),
  ),
);
const client = new CodexClient(root);
try {
  const status = await client.status();
  console.log(
    "Runtime",
    status.version,
    "authenticated:",
    status.authenticated,
    "models:",
    status.models.length,
  );
  const answer = await client.run({
    passages,
    question:
      "Compare the proposed databases and delivery dates. Cite both proposals.",
    onProgress: (e) => {
      if (e.type === "tool") console.log(e);
    },
  });
  if (
    answer.status !== "answered" ||
    !answer.blocks.some((b) => b.citations.length)
  )
    throw new Error("Harness proof did not produce a cited answer.");
  console.log(JSON.stringify(answer, null, 2));
  writeFileSync(
    path.join(root, "result.json"),
    JSON.stringify(
      { date: new Date().toISOString(), version: status.version, answer },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
