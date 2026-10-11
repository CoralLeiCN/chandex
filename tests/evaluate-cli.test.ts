import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
test("evaluation CLI refuses to overwrite explicit existing evidence before runtime initialization", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-eval-evidence-"));
  const target = path.join(root, "preserved result.json"),
    original = '{"preserved":"🦉 exact evidence"}\n';
  writeFileSync(target, original);
  try {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/evaluate.ts", target],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let error = "";
    child.stderr.on("data", (chunk) => {
      error += String(chunk);
    });
    const [code] = await once(child, "exit");
    assert.notEqual(code, 0);
    assert.match(error, /EEXIST/);
    assert.equal(readFileSync(target, "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
