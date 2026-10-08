import test from "node:test";
import assert from "node:assert/strict";
import { Rpc } from "../src/codex/rpc.ts";
test("runtime exit rejects outstanding work without hanging", async () => {
  const rpc = new Rpc(
    process.execPath,
    ["-e", 'process.stdin.once("data",()=>process.exit(7))'],
    process.cwd(),
  );
  try {
    await assert.rejects(rpc.request("initialize", {}, 1000), /exited/);
  } finally {
    rpc.close();
  }
});
test("runtime request timeout rejects work and invalid JSON closes the channel", async () => {
  const idle = new Rpc(
    process.execPath,
    ["-e", "process.stdin.resume()"],
    process.cwd(),
  );
  try {
    await assert.rejects(idle.request("initialize", {}, 50), /timed out/);
  } finally {
    idle.close();
  }
  const invalid = new Rpc(
    process.execPath,
    [
      "-e",
      'process.stdin.once("data",()=>process.stdout.write("not-json\\n"))',
    ],
    process.cwd(),
  );
  try {
    await assert.rejects(
      invalid.request("initialize", {}, 1000),
      /Invalid runtime protocol/,
    );
  } finally {
    invalid.close();
  }
});
