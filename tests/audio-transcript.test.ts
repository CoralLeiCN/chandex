import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeAudioTranscript } from "../src/ingestion/audio-transcript.ts";
import { recognizeAudio } from "../src/ingestion/audio-recognize.ts";
import { checkAudioParameters } from "../src/ingestion/audio-limits.ts";

test("audio transcript preserves complete Unicode text, qualifiers and explicit estimated/unknown timing", () => {
  const result = normalizeAudioTranscript(
    {
      text: " Budget: 240.\nApproval is not granted. Cafe\u0301 🦉.",
      chunks: [
        { text: " Budget: 240.", timestamp: [0, 2.5] },
        {
          text: "\nApproval is not granted. Cafe\u0301 🦉.",
          timestamp: [3, 6],
        },
      ],
    },
    5,
  );
  assert.deepEqual(
    result.sections.map((s) => s.text),
    ["Budget: 240.", "Approval is not granted. Café 🦉."],
  );
  assert.match(result.sections[0].locator, /00:00.00–00:02.50 \(estimated\)/);
  assert.match(result.sections[1].locator, /00:03.00–unknown/);
  assert.ok(result.warnings.some((w) => w.includes("extend beyond")));
  assert.ok(
    result.warnings.some((w) => w.includes("can invent or miss words")),
  );
  const unknown = normalizeAudioTranscript(
    { text: "Hello", chunks: [{ text: "Hello", timestamp: [null, null] }] },
    1,
  );
  assert.match(unknown.sections[0].locator, /unknown–unknown/);
});

test("audio transcript rejects missing or dropped text, invalid intervals and partial structures atomically", () => {
  const chunk = { text: "Test", timestamp: [0, 1] };
  const invalid = [
    null,
    [],
    { text: "Test" },
    { text: "", chunks: [] },
    { text: "Test missing tail", chunks: [chunk] },
    { text: "Test", chunks: [{ text: "", timestamp: [0, 1] }] },
    { text: "Test", chunks: [{ text: "Test", timestamp: [] }] },
    { text: "Test", chunks: [{ text: "Test", timestamp: [-1, 1] }] },
    { text: "Test", chunks: [{ text: "Test", timestamp: [0, Infinity] }] },
    { text: "Test", chunks: [{ text: "Test", timestamp: [2, 1] }] },
    { text: "Test", chunks: [{ text: "Test", timestamp: [3, 2] }] },
    { text: "Test", chunks: [{ text: "Test", timestamp: ["0", 1] }] },
    {
      text: "Test Next",
      chunks: [
        chunk,
        { text: " Next", timestamp: [0, 1] },
        { text: " Extra", timestamp: [0, 1] },
      ],
    },
    {
      text: "Test Next",
      chunks: [
        { text: "Test", timestamp: [0.8, 1] },
        { text: " Next", timestamp: [0.2, 0.3] },
      ],
    },
    { text: "Test\0", chunks: [{ text: "Test\0", timestamp: [0, 1] }] },
  ];
  for (const value of invalid)
    assert.throws(() => normalizeAudioTranscript(value, 1));
  assert.throws(() =>
    normalizeAudioTranscript({ text: "Test", chunks: [chunk] }, NaN),
  );
});

test("audio input budgets and silence/nonfinite refusal happen before model loading", async () => {
  checkAudioParameters(16000, 1, 9_600_000);
  for (const args of [
    [7999, 1, 1],
    [96001, 1, 1],
    [16000, 3, 1],
    [16000, 1, 0],
    [16000, 1, 9_600_001],
    [96000, 2, 12_000_001],
  ])
    assert.throws(() =>
      checkAudioParameters(...(args as [number, number, number])),
    );
  await assert.rejects(
    recognizeAudio(new Float32Array(16000)),
    /silent or too quiet/,
  );
  await assert.rejects(recognizeAudio(Float32Array.of(NaN)), /nonfinite/);
});
