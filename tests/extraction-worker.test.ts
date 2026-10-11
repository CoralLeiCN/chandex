import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createIsolatedExtractor } from "../src/ingestion/service.ts";
import { MAX_BYTES } from "../src/ingestion/url.ts";
import { AudioProcess } from "../src/ingestion/audio-process.ts";
class FakeWorker extends EventEmitter {
  terminated = 0;
  async terminate() {
    this.terminated++;
    return 0;
  }
}

test("extraction settles only after its isolation boundary has finished terminating", async () => {
  let release!: (code: number) => void;
  const worker = new FakeWorker();
  worker.terminate = () =>
    new Promise<number>((resolve) => {
      release = resolve;
    });
  const pending = createIsolatedExtractor(() => worker)(
    Buffer.from("audio"),
    "audio",
  );
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  worker.emit("message", { result: { sections: [], warnings: [] } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release(0);
  await pending;
  assert.equal(settled, true);
});

test("the actual audio process refuses malformed input and is gone before extraction settles", async () => {
  const previousArgs = process.execArgv;
  process.execArgv = [
    ...previousArgs,
    "--eval",
    "throw Error('LAUNCHER_PRIVATE_CANARY')",
  ];
  let processBoundary!: AudioProcess;
  const extract = createIsolatedExtractor((bytes) => {
    processBoundary = new AudioProcess(bytes);
    return processBoundary;
  });
  try {
    await assert.rejects(
      extract(Buffer.from("SOURCE_PRIVATE_CANARY"), "audio"),
      (error: Error) => {
        assert.equal(error.message.includes("SOURCE_PRIVATE_CANARY"), false);
        return /audio|Audio/.test(error.message);
      },
    );
  } finally {
    process.execArgv = previousArgs;
  }
  assert.equal(processBoundary.child.spawnargs.includes("--eval"), false);
  assert.ok(processBoundary.child.pid);
  assert.throws(() => process.kill(processBoundary.child.pid!, 0), {
    code: "ESRCH",
  });
  await processBoundary.terminate();
});

test("clean worker exit, worker errors and malformed replies settle instead of leaving an import pending", async () => {
  for (const event of ["exit", "error", "message"] as const) {
    const worker = new FakeWorker();
    const extract = createIsolatedExtractor(() => worker);
    const pending = extract(Buffer.from("evidence"), "text");
    worker.emit(
      event,
      event === "error"
        ? new Error("synthetic parser crash")
        : event === "message"
          ? { result: null }
          : 0,
    );
    await assert.rejects(pending, /stopped|parser crash|invalid result/);
    assert.equal(worker.terminated, 1);
  }
});

test("cancellation and timeout terminate extraction and ignore late worker replies", async () => {
  for (const cancel of [false, true]) {
    const worker = new FakeWorker();
    const extract = createIsolatedExtractor(() => worker);
    const controller = new AbortController();
    const pending = extract(Buffer.from("evidence"), "text", {
      signal: controller.signal,
      timeoutMs: 15,
    });
    if (cancel) controller.abort();
    await assert.rejects(pending, cancel ? /cancelled/ : /deadline/);
    worker.emit("message", {
      result: { sections: [{ text: "late" }], warnings: [] },
    });
    assert.equal(worker.terminated, 1);
  }
});

test("oversized and already cancelled inputs fail before allocating a worker", async () => {
  let calls = 0;
  const extract = createIsolatedExtractor(() => {
    calls++;
    return new FakeWorker();
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    extract(Buffer.from("evidence"), "text", { signal: controller.signal }),
    /cancelled/,
  );
  await assert.rejects(extract(Buffer.alloc(MAX_BYTES + 1), "text"), /25 MiB/);
  assert.equal(calls, 0);
});

test("only audio accepts the longer deadline and fixed progress phases before its final result", async () => {
  const worker = new FakeWorker();
  const extract = createIsolatedExtractor(() => worker);
  await assert.rejects(
    extract(Buffer.from("input"), "text", { timeoutMs: 30001 }),
    /30,000/,
  );
  await assert.rejects(
    extract(Buffer.from("input"), "audio", { timeoutMs: 300001 }),
    /300,000/,
  );
  const phases: string[] = [];
  const pending = extract(Buffer.from("audio"), "audio", {
    timeoutMs: 300000,
    onProgress: (phase) => phases.push(phase),
  });
  for (const progress of [
    "decoding",
    "loading_model",
    "recognizing",
    "validating",
  ])
    worker.emit("message", { progress });
  const result = {
    sections: [{ locator: "Audio 1", text: "Transcript" }],
    warnings: ["Estimated"],
  };
  worker.emit("message", { result });
  assert.deepEqual(await pending, result);
  assert.deepEqual(phases, [
    "decoding",
    "loading_model",
    "recognizing",
    "validating",
  ]);
  assert.equal(worker.terminated, 1);
  const invalidWorker = new FakeWorker();
  const invalid = createIsolatedExtractor(() => invalidWorker)(
    Buffer.from("input"),
    "audio",
  );
  invalidWorker.emit("message", { progress: "SOURCE_PRIVATE_CANARY" });
  await assert.rejects(invalid, /invalid result/);
  assert.equal(invalidWorker.terminated, 1);
});
