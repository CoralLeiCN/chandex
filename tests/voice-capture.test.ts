import assert from "node:assert/strict";
import test from "node:test";
import { startVoiceCapture } from "../src/web/voice-capture.ts";
import { decodeWav } from "../src/ingestion/audio-pcm.ts";
import { voiceEnvironment } from "./fixtures/voice-capture.ts";
const options = () => ({
  signal: new AbortController().signal,
  onSeconds: () => {},
  onLimit: () => {},
});

test("normal capture stops tracks, flushes final samples once, produces complete WAV and closes the graph", async () => {
  const env = voiceEnvironment();
  try {
    const seconds: number[] = [],
      capture = await startVoiceCapture({
        ...options(),
        onSeconds: (value) => seconds.push(value),
      }),
      node = env.nodes[0];
    node.samples([0.25, -0.5]);
    node.tail = Float32Array.of(0.75);
    const first = capture.finish(),
      second = capture.finish();
    assert.equal(first, second);
    const pcm = decodeWav(Buffer.from(await first));
    assert.deepEqual([...pcm.mono], [0.25, -0.5, 0.75]);
    assert.equal(pcm.sampleRate, 16000);
    assert.deepEqual(seconds, [2 / 16000, 3 / 16000]);
    assert.equal(node.stops, 1);
    assert.ok(env.track.stops >= 1);
    assert.equal(env.contexts[0].state, "closed");
    assert.equal(node.port.onmessage, null);
    assert.equal(node.closes, 1);
    assert.match(
      env.contexts[0].moduleCalls[0],
      /voice-worklet\.js\?no-inline$/,
    );
  } finally {
    env.restore();
  }
});

test("abort during module startup settles promptly and closes the already granted microphone", async () => {
  const env = voiceEnvironment({ module: () => new Promise(() => {}) });
  try {
    const controller = new AbortController(),
      pending = startVoiceCapture({ ...options(), signal: controller.signal });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(env.contexts.length, 1);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.ok(env.track.stops >= 1);
    assert.equal(env.contexts[0].state, "closed");
    assert.equal(env.nodes.length, 0);
  } finally {
    env.restore();
  }
});

test("abort during suspended-context resume settles rather than retaining a granted microphone", async () => {
  const env = voiceEnvironment({ resume: () => new Promise(() => {}) });
  try {
    const controller = new AbortController(),
      pending = startVoiceCapture({ ...options(), signal: controller.signal });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(env.nodes.length, 1);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.equal(env.contexts[0].state, "closed");
    assert.equal(env.nodes[0].port.onmessage, null);
  } finally {
    env.restore();
  }
});

test("microphone loss and processor failure discard samples, notify once and prevent transcription", async () => {
  for (const cause of ["track", "processor"] as const) {
    const env = voiceEnvironment();
    try {
      const errors: string[] = [],
        capture = await startVoiceCapture({
          ...options(),
          onError: (value) => errors.push(value),
        });
      env.nodes[0].samples([0.5]);
      if (cause === "track") {
        env.track.end();
        env.track.end();
      } else env.nodes[0].onprocessorerror!();
      assert.equal(errors.length, 1);
      assert.match(errors[0], /discarded/);
      await assert.rejects(
        capture.finish(),
        cause === "track" ? /disconnected/ : /unexpectedly/,
      );
      assert.equal(env.contexts[0].state, "closed");
      assert.equal(env.nodes[0].port.onmessage, null);
    } finally {
      env.restore();
    }
  }
});

test("startup has a ten-second deadline and wall-clock limit stops capture even without more samples", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let env = voiceEnvironment({ module: () => new Promise(() => {}) });
  try {
    const pending = startVoiceCapture(options());
    await Promise.resolve();
    await Promise.resolve();
    t.mock.timers.tick(10000);
    await assert.rejects(pending, /could not start/);
    assert.equal(env.contexts[0].state, "closed");
  } finally {
    env.restore();
  }
  env = voiceEnvironment();
  let capture: Awaited<ReturnType<typeof startVoiceCapture>> | undefined;
  try {
    let limits = 0;
    capture = await startVoiceCapture({
      ...options(),
      onLimit: () => {
        limits++;
      },
    });
    env.nodes[0].samples([0.25]);
    t.mock.timers.tick(120000);
    assert.equal(limits, 1);
    assert.ok(env.track.stops >= 1);
    const pcm = decodeWav(Buffer.from(await capture.finish()));
    assert.deepEqual([...pcm.mono], [0.25]);
    assert.equal(env.contexts[0].state, "closed");
  } finally {
    capture?.cancel();
    env.restore();
    t.mock.timers.reset();
  }
});
