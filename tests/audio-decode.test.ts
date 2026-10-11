import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { decodeAudio } from "../src/ingestion/audio-decode.ts";
import { parseM4a } from "../src/ingestion/audio-m4a.ts";
import { preflightAudio } from "../src/ingestion/audio-containers.ts";

const fixture = (extension: string) =>
  readFile(new URL(`./fixtures/audio/speech.${extension}`, import.meta.url));

test("complete local codec decoding preserves speech duration and every declared sample", async () => {
  for (const ext of ["wav", "mp3", "aac", "flac", "ogg", "opus", "m4a"]) {
    const decoded = await decodeAudio(await fixture(ext));
    assert.equal(decoded.channels, 1);
    assert.equal(
      decoded.sampleRate,
      ext === "aac" ? 32000 : ext === "opus" ? 48000 : 16000,
    );
    assert.equal(
      decoded.mono.length,
      ext === "aac" ? 276480 : ext === "opus" ? 413916 : 137972,
    );
    assert.ok(decoded.mono.some((sample) => Math.abs(sample) > 0.1));
    assert.ok(decoded.mono.every(Number.isFinite));
    assert.ok(decoded.warnings.length > 0);
  }
  const untagged = await readFile(
    new URL("./fixtures/audio/speech-no-xing.mp3", import.meta.url),
  );
  const raw = await decodeAudio(untagged);
  assert.equal(raw.mono.length, preflightAudio(untagged, "mp3").samples);
  assert.ok(
    raw.warnings.some((warning) => warning.includes("untagged recordings")),
  );
});

test("AAC engine error status refuses a malformed first packet rather than treating it as priming", async () => {
  for (const ext of ["aac", "m4a"]) {
    const bytes = Buffer.from(await fixture(ext));
    if (ext === "aac") {
      const length = ((bytes[3] & 3) << 11) | (bytes[4] << 3) | (bytes[5] >> 5);
      bytes.fill(0, 7, length);
    } else parseM4a(bytes).packets[0].fill(0);
    await assert.rejects(decodeAudio(bytes), /AAC decoding failed/);
    await assert.rejects(
      decodeAudio((await fixture(ext)).subarray(0, -1)),
      /Malformed|truncated/,
    );
  }
  await assert.rejects(
    decodeAudio(Buffer.from("SOURCE_PRIVATE_CANARY")),
    (error: Error) => !/SOURCE_PRIVATE_CANARY/.test(error.message),
  );
});

test("M4A preflight resolves complete local sample tables and refuses invalid, external or ambiguous layouts", async () => {
  const original = await fixture("m4a"),
    plan = parseM4a(original);
  assert.equal(plan.packets.length, 136);
  assert.equal(plan.asc.toString("hex"), "140856e500");
  assert.deepEqual(plan.window, { start: 1024, samples: 137972 });
  const locate = (bytes: Buffer, name: string) => {
    const offset = bytes.indexOf(name);
    assert.ok(offset > 0);
    return offset + 4;
  };
  for (const mutate of [
    (b: Buffer) => b.writeUInt32BE(0xffffffff, locate(b, "stsz") + 8),
    (b: Buffer) => b.writeUInt32BE(65537, locate(b, "stsz") + 12),
    (b: Buffer) => b.writeUInt32BE(0xffffffff, locate(b, "stco") + 8),
    (b: Buffer) => b.writeUInt32BE(2, locate(b, "stsc") + 8),
    (b: Buffer) => b.writeUInt32BE(0xffffffff, locate(b, "stsc") + 12),
    (b: Buffer) => b.writeUInt32BE(2, locate(b, "stsc") + 16),
    (b: Buffer) => b.writeUInt32BE(2, locate(b, "stsd") + 4),
    (b: Buffer) => b.writeUInt16BE(2, locate(b, "mp4a") + 6),
    (b: Buffer) => b.writeUInt16BE(1, locate(b, "mp4a") + 8),
    (b: Buffer) => b.write("enca", locate(b, "mp4a") - 4),
    (b: Buffer) => b.write("vide", locate(b, "hdlr") + 8),
    (b: Buffer) => b.writeUInt32BE(0, locate(b, "url ")),
    (b: Buffer) => b.writeUInt32BE(2, locate(b, "elst") + 4),
    (b: Buffer) => b.writeInt32BE(-1, locate(b, "elst") + 12),
    (b: Buffer) => b.writeInt16BE(2, locate(b, "elst") + 16),
    (b: Buffer) => b.writeUInt32BE(0xffffffff, locate(b, "stts") + 12),
    (b: Buffer) => b.writeUInt32BE(1, locate(b, "moov") - 8),
    (b: Buffer) => b.write("moof", locate(b, "moov") - 4),
  ]) {
    const bytes = Buffer.from(original);
    mutate(bytes);
    assert.throws(() => parseM4a(bytes));
  }
  const corrupted = Buffer.from(original),
    ascOffset = plan.asc.byteOffset - original.byteOffset;
  corrupted[ascOffset] = (5 << 3) | (corrupted[ascOffset] & 7);
  assert.throws(() => parseM4a(corrupted), /unsupported M4A/);
  assert.throws(
    () =>
      parseM4a(Buffer.concat([original, Buffer.from("SOURCE_PRIVATE_CANARY")])),
    (error: Error) => !/SOURCE_PRIVATE_CANARY/.test(error.message),
  );
});

test("MP3 gapless metadata must agree with every physical frame before decoder trimming", async () => {
  const original = await fixture("mp3"),
    layout = preflightAudio(original, "mp3");
  assert.equal(layout.expectedSamples, 137972);
  assert.equal(layout.samples, 139968);
  const tag = original.indexOf("Info");
  assert.ok(tag > 0);
  for (const offset of [tag + 8, tag + 12]) {
    const damaged = Buffer.from(original);
    damaged.writeUInt32BE(0xffffffff, offset);
    await assert.rejects(decodeAudio(damaged), /gapless metadata/);
  }
});
