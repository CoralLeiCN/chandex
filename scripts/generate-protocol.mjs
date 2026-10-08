import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const bin = path.resolve("node_modules/.bin/codex");
const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
if (version !== "codex-cli 0.161.0")
  throw new Error("Unsupported Codex version: " + version);
const temp = path.resolve(".codeboom/protocol-0.161");
mkdirSync(temp, { recursive: true });
execFileSync(
  bin,
  ["app-server", "generate-ts", "--experimental", "--out", temp],
  { stdio: "inherit" },
);
const target = path.resolve("src/codex/protocol");
mkdirSync(target, { recursive: true });
const seen = new Set();
function copy(relative) {
  if (seen.has(relative)) return;
  seen.add(relative);
  const source = readFileSync(path.join(temp, relative), "utf8");
  for (const match of source.matchAll(/from "([^"]+)"/g))
    copy(path.normalize(path.join(path.dirname(relative), match[1] + ".ts")));
  mkdirSync(path.dirname(path.join(target, relative)), { recursive: true });
  writeFileSync(path.join(target, relative), source);
}
for (const root of [
  "InitializeParams.ts",
  "v2/ThreadStartParams.ts",
  "v2/ThreadStartResponse.ts",
  "v2/TurnStartParams.ts",
  "v2/DynamicToolCallParams.ts",
  "v2/DynamicToolCallResponse.ts",
])
  copy(root);
writeFileSync(path.join(target, "VERSION"), "0.161.0\n");
console.log("Retained " + seen.size + " generated protocol types.");
