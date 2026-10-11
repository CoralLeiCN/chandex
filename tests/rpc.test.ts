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

test("semantically malformed protocol and an unterminated oversized frame close outstanding work", async () => {
  for (const payload of ["null\n", "[]\n", "1\n", "x".repeat(4_000_001)]) {
    const rpc = new Rpc(
      process.execPath,
      [
        "-e",
        `process.stdin.once('data',()=>process.stdout.write(${JSON.stringify(payload.length > 100 ? null : payload)} ?? 'x'.repeat(4000001)))`,
      ],
      process.cwd(),
    );
    try {
      await assert.rejects(
        rpc.request("initialize", {}, 2000),
        /Invalid runtime protocol|exceeded limit/,
      );
    } finally {
      rpc.close();
    }
  }
});

test("runtime RPC errors retain provider failure categories and duplicate responses are ignored", async () => {
  const rpc = new Rpc(
    process.execPath,
    [
      "-e",
      `process.stdin.once('data',chunk=>{const q=JSON.parse(String(chunk)); const response=JSON.stringify({id:q.id,error:{message:'expired',data:{codexErrorInfo:'unauthorized'}}})+'\\n';process.stdout.write(response+response)})`,
    ],
    process.cwd(),
  );
  try {
    await assert.rejects(
      rpc.request("turn/start", {}, 1000),
      (error: any) => error.category === "authentication",
    );
  } finally {
    rpc.close();
  }
});
