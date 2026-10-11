import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  audioFormat,
  preflightAudio,
} from "../src/ingestion/audio-containers.ts";

test("compressed audio preflight validates real mono speech frame/page boundaries and declared sample budgets", async () => {
  for (const [extension, format, rate] of [
    ["mp3", "mp3", 16000],
    ["aac", "aac", 16000],
    ["flac", "flac", 16000],
    ["ogg", "vorbis", 16000],
    ["opus", "opus", 48000],
  ] as const) {
    const bytes = await readFile(
      new URL(`./fixtures/audio/speech.${extension}`, import.meta.url),
    );
    assert.equal(audioFormat(bytes), format);
    const layout = preflightAudio(bytes, format);
    assert.equal(layout.channels, 1);
    assert.equal(layout.sampleRate, rate);
    assert.ok(layout.samples / rate > 8 && layout.samples / rate < 9);
    for (const truncated of [
      bytes.subarray(0, bytes.length - 1),
      bytes.subarray(0, Math.floor(bytes.length / 2)),
    ])
      assert.throws(() => preflightAudio(truncated, format));
    assert.throws(() =>
      preflightAudio(
        Buffer.concat([bytes, Buffer.from("SOURCE_PRIVATE_CANARY")]),
        format,
      ),
    );
  }
  assert.equal(audioFormat(Buffer.from("not an audio file")), undefined);
  assert.equal(
    audioFormat(
      await readFile(new URL("./fixtures/audio/speech.m4a", import.meta.url)),
    ),
    "m4a",
  );
  assert.throws(() => preflightAudio(Buffer.from("ID3"), "mp3"));
});

test("audio preflight refuses changed streams, checksum failures, malformed tags and announced allocation attacks", async () => {
  const flac = await readFile(
    new URL("./fixtures/audio/speech.flac", import.meta.url),
  );
  const damaged = Buffer.from(flac);
  damaged[damaged.length - 4] ^= 1;
  assert.throws(() => preflightAudio(damaged, "flac"), /checksum/);
  const duration = Buffer.from(flac);
  const info = duration.readBigUInt64BE(18);
  duration.writeBigUInt64BE((info & ~0xfffffffffn) | BigInt(16000 * 601), 18);
  assert.throws(() => preflightAudio(duration, "flac"), /ten-minute/);
  const unknown = Buffer.from(flac);
  unknown.writeBigUInt64BE(info & ~0xfffffffffn, 18);
  assert.throws(() => preflightAudio(unknown, "flac"), /unsupported FLAC/);
  for (const ext of ["ogg", "opus"] as const) {
    const original = await readFile(
      new URL(`./fixtures/audio/speech.${ext}`, import.meta.url),
    );
    const damaged = Buffer.from(original);
    damaged[damaged.length - 3] ^= 1;
    assert.throws(
      () => preflightAudio(damaged, ext === "ogg" ? "vorbis" : "opus"),
      /checksum/,
    );
    const extra = Buffer.concat([original, original]);
    assert.throws(
      () => preflightAudio(extra, ext === "ogg" ? "vorbis" : "opus"),
      /Ogg/,
    );
  }
  const mp3 = await readFile(
    new URL("./fixtures/audio/speech.mp3", import.meta.url),
  );
  const tag = Buffer.from(mp3);
  tag[6] = 128;
  assert.throws(() => preflightAudio(tag, "mp3"), /MP3/);
  const aac = await readFile(
    new URL("./fixtures/audio/speech.aac", import.meta.url),
  );
  const reserved = Buffer.from(aac);
  reserved[2] = (reserved[2] & ~0x3c) | 0x3c;
  assert.throws(() => preflightAudio(reserved, "aac"), /AAC/);
  assert.throws(() => preflightAudio(mp3, "flac"), /signature/);
});
