import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeWav, resampleAudio } from "../src/ingestion/audio-pcm.ts";

function wav(
  values: number[],
  { rate = 16000, channels = 1, bits = 16, float = false } = {},
) {
  const data = Buffer.alloc((values.length * bits) / 8);
  values.forEach((value, i) => {
    const offset = (i * bits) / 8;
    if (float && bits === 32) data.writeFloatLE(value, offset);
    else if (float && bits === 64) data.writeDoubleLE(value, offset);
    else if (bits === 8) data[offset] = value;
    else data.writeIntLE(value, offset, bits / 8);
  });
  const bytes = Buffer.alloc(44 + data.length + (data.length % 2));
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(float ? 3 : 1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE((rate * channels * bits) / 8, 28);
  bytes.writeUInt16LE((channels * bits) / 8, 32);
  bytes.writeUInt16LE(bits, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(data.length, 40);
  data.copy(bytes, 44);
  return bytes;
}

test("WAV decoding retains integer/float PCM, stereo mixing and declared amplitude normalization", () => {
  const scales = [128, 32768, 8388608, 2147483648];
  for (const [i, bits] of [8, 16, 24, 32].entries()) {
    const values = bits === 8 ? [0, 128, 192] : [-scales[i], 0, scales[i] / 2];
    assert.deepEqual(
      Array.from(decodeWav(wav(values, { bits })).mono),
      [-1, 0, 0.5],
    );
  }
  for (const bits of [32, 64]) {
    const decoded = decodeWav(wav([0.25, -0.5, 0], { float: true, bits }));
    assert.deepEqual(Array.from(decoded.mono), [0.25, -0.5, 0]);
  }
  const stereo = decodeWav(wav([32767, -32767, 0, 16384], { channels: 2 }));
  assert.deepEqual(Array.from(stereo.mono), [0, 0.25]);
  assert.ok(stereo.warnings.some((w) => w.includes("opposite-phase")));
  const normalized = decodeWav(wav([2, -1], { float: true, bits: 32 }));
  assert.deepEqual(Array.from(normalized.mono), [1, -0.5]);
  assert.ok(normalized.warnings.some((w) => w.includes("scaled by its peak")));
  const bytes = wav([0, 16384]);
  const extensible = Buffer.concat([
    bytes.subarray(0, 36),
    Buffer.alloc(24),
    bytes.subarray(36),
  ]);
  extensible.writeUInt32LE(extensible.length - 8, 4);
  extensible.writeUInt32LE(40, 16);
  extensible.writeUInt16LE(0xfffe, 20);
  extensible.writeUInt16LE(22, 36);
  extensible.writeUInt16LE(16, 38);
  Buffer.from("0100000000001000800000aa00389b71", "hex").copy(extensible, 44);
  assert.deepEqual(Array.from(decodeWav(extensible).mono), [0, 0.5]);
});

test("WAV preflight rejects truncation, ambiguous data, compression, invalid PCM and declared budgets", () => {
  const original = wav([0, 100]);
  for (const mutate of [
    (b: Buffer) => {
      b.writeUInt32LE(b.length, 4);
    },
    (b: Buffer) => {
      b.writeUInt32LE(1000, 40);
    },
    (b: Buffer) => {
      b.writeUInt16LE(2, 20);
    },
    (b: Buffer) => {
      b.writeUInt16LE(3, 22);
    },
    (b: Buffer) => {
      b.writeUInt32LE(7999, 24);
      b.writeUInt32LE(15998, 28);
    },
    (b: Buffer) => {
      b.writeUInt32LE(96001, 24);
      b.writeUInt32LE(192002, 28);
    },
    (b: Buffer) => {
      b.writeUInt32LE(1, 28);
    },
    (b: Buffer) => {
      b.writeUInt16LE(24, 34);
    },
  ]) {
    const bytes = Buffer.from(original);
    mutate(bytes);
    assert.throws(() => decodeWav(bytes));
  }
  assert.throws(() => decodeWav(original.subarray(0, original.length - 1)));
  assert.throws(() => decodeWav(wav([])), /no usable samples/);
  assert.throws(
    () => decodeWav(wav([NaN], { float: true, bits: 32 })),
    /nonfinite/,
  );
  assert.throws(
    () => decodeWav(wav([Infinity], { float: true, bits: 64 })),
    /nonfinite/,
  );
  const duplicate = Buffer.concat([original, original.subarray(36)]);
  duplicate.writeUInt32LE(duplicate.length - 8, 4);
  assert.throws(() => decodeWav(duplicate), /Malformed/);
  const long = Buffer.alloc(44 + 8000 * 601 * 2);
  original.copy(long);
  long.writeUInt32LE(long.length - 8, 4);
  long.writeUInt32LE(long.length - 44, 40);
  long.writeUInt32LE(8000, 24);
  long.writeUInt32LE(16000, 28);
  assert.throws(() => decodeWav(long), /ten-minute/);
});

test("resampling preserves time and passband while suppressing aliased high frequencies", () => {
  const tone = (frequency: number, rate: number) =>
    Float32Array.from(
      { length: rate },
      (_, i) => Math.sin((2 * Math.PI * frequency * i) / rate) * 0.5,
    );
  const rms = (samples: Float32Array) =>
    Math.sqrt(
      samples
        .subarray(100, samples.length - 100)
        .reduce((sum, value) => sum + value * value, 0) /
        (samples.length - 200),
    );
  for (const rate of [8000, 22050, 44100, 48000, 96000]) {
    const result = resampleAudio(tone(1000, rate), rate);
    assert.equal(result.length, 16000);
    assert.ok(Math.abs(rms(result) - Math.sqrt(0.125)) < 0.005);
  }
  assert.ok(rms(resampleAudio(tone(12000, 48000), 48000)) < 0.001);
  const original = Float32Array.of(0.2, -0.1);
  assert.equal(resampleAudio(original, 16000), original);
  assert.throws(() => resampleAudio(Float32Array.of(NaN), 16000), /nonfinite/);
});
