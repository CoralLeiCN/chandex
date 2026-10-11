import { checkAudioParameters } from "./audio-limits.ts";
import { MAX_BYTES } from "./url.ts";

export type AudioFormat =
  "wav" | "mp3" | "flac" | "opus" | "vorbis" | "aac" | "m4a";
export interface AudioLayout {
  format: Exclude<AudioFormat, "wav" | "m4a">;
  sampleRate: number;
  channels: number;
  samples: number;
  expectedSamples?: number;
  // Decoder delay/padding is bounded, never an unlimited recovery allowance.
  sampleTolerance: number;
}
export function audioFormat(bytes: Buffer): AudioFormat | undefined {
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WAVE"
  )
    return "wav";
  if (bytes.toString("ascii", 0, 4) === "fLaC") return "flac";
  if (bytes.toString("ascii", 4, 8) === "ftyp") return "m4a";
  if (bytes.toString("ascii", 0, 4) === "OggS" && bytes.length >= 28) {
    const start = 27 + bytes[26];
    if (bytes.toString("ascii", start, start + 8) === "OpusHead") return "opus";
    if (
      bytes[start] === 1 &&
      bytes.toString("ascii", start + 1, start + 7) === "vorbis"
    )
      return "vorbis";
    return undefined;
  }
  if (bytes.toString("ascii", 0, 3) === "ID3") return "mp3";
  if (bytes.length >= 4 && bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0) {
    if ((bytes[1] & 6) === 0) return "aac";
    if ((bytes[1] & 6) === 2) return "mp3";
  }
  return undefined;
}

function invalid(format: string): never {
  throw new Error(
    `Malformed, truncated or unsupported ${format} recording. Use a complete recording with one consistent mono or stereo audio stream.`,
  );
}
function checked(layout: AudioLayout): AudioLayout {
  checkAudioParameters(layout.sampleRate, layout.channels, layout.samples);
  return layout;
}
const rates = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350,
];

function mp3(bytes: Buffer): AudioLayout {
  let offset = 0,
    end = bytes.length;
  if (bytes.toString("ascii", 0, 3) === "ID3") {
    if (
      bytes.length < 10 ||
      ![2, 3, 4].includes(bytes[3]) ||
      bytes[4] === 255 ||
      bytes.subarray(6, 10).some((n) => n & 128)
    )
      invalid("MP3");
    const size =
      bytes[6] * 2097152 + bytes[7] * 16384 + bytes[8] * 128 + bytes[9];
    offset = 10 + size + (bytes[3] === 4 && bytes[5] & 16 ? 10 : 0);
    if (offset >= end) invalid("MP3");
  }
  if (end >= 128 && bytes.toString("ascii", end - 128, end - 125) === "TAG")
    end -= 128;
  let sampleRate = 0,
    channels = 0,
    samples = 0,
    samplesPerFrame = 0;
  const firstFrame = offset;
  let xing: { frames: number; byteCount?: number; trim: number } | undefined;
  while (offset < end) {
    if (offset + 4 > end) invalid("MP3");
    const b1 = bytes[offset + 1],
      b2 = bytes[offset + 2],
      b3 = bytes[offset + 3];
    const version = (b1 >> 3) & 3,
      layer = (b1 >> 1) & 3,
      bitrate = (b2 >> 4) & 15,
      frequency = (b2 >> 2) & 3;
    if (
      bytes[offset] !== 255 ||
      (b1 & 0xe0) !== 0xe0 ||
      version === 1 ||
      layer !== 1 ||
      !bitrate ||
      bitrate === 15 ||
      frequency === 3 ||
      (b3 & 3) === 2
    )
      invalid("MP3");
    const rate =
      [44100, 48000, 32000][frequency] /
      (version === 3 ? 1 : version === 2 ? 2 : 4);
    const channel = b3 >> 6 === 3 ? 1 : 2;
    const kbps = (
      version === 3
        ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
        : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    )[bitrate];
    const length =
      Math.floor(((version === 3 ? 144000 : 72000) * kbps) / rate) +
      ((b2 >> 1) & 1);
    if (
      offset + length > end ||
      length < 4 ||
      (sampleRate && (rate !== sampleRate || channels !== channel))
    )
      invalid("MP3");
    sampleRate = rate;
    channels = channel;
    samplesPerFrame = version === 3 ? 1152 : 576;
    if (offset === firstFrame) {
      const side =
        version === 3 ? (channel === 1 ? 17 : 32) : channel === 1 ? 9 : 17;
      const positions = [
        offset + 4 + side,
        offset + 4 + side + (b1 & 1 ? 0 : 2),
      ];
      const tag = positions.find((position) =>
        ["Xing", "Info"].includes(
          bytes.toString("ascii", position, position + 4),
        ),
      );
      if (tag !== undefined) {
        const bound = offset + length;
        if (tag + 12 > bound) invalid("MP3 gapless metadata");
        const flags = bytes.readUInt32BE(tag + 4);
        if (!(flags & 1) || flags & ~15) invalid("MP3 gapless metadata");
        const frames = bytes.readUInt32BE(tag + 8);
        let position = tag + 12,
          byteCount: number | undefined;
        if (flags & 2) {
          if (position + 4 > bound) invalid("MP3 gapless metadata");
          byteCount = bytes.readUInt32BE(position);
          position += 4;
        }
        if (flags & 4) position += 100;
        if (flags & 8) position += 4;
        if (position > bound) invalid("MP3 gapless metadata");
        let trim = 0;
        if (
          position + 24 <= bound &&
          /^(LAME|Lavc|Lavf)/.test(
            bytes.toString("ascii", position, position + 4),
          )
        ) {
          const delay =
            (bytes[position + 21] << 4) | (bytes[position + 22] >> 4);
          const padding =
            ((bytes[position + 22] & 15) << 8) | bytes[position + 23];
          if (delay > 3000 || padding > 3000) invalid("MP3 gapless metadata");
          trim = delay + padding;
        }
        xing = { frames, byteCount, trim };
      }
    }
    samples += samplesPerFrame;
    checkAudioParameters(sampleRate, channels, samples);
    offset += length;
  }
  if (
    xing &&
    (xing.frames !== samples / samplesPerFrame - 1 ||
      (xing.byteCount !== undefined && xing.byteCount !== end - firstFrame))
  )
    invalid("MP3 gapless metadata");
  const expectedSamples = xing
    ? xing.frames * samplesPerFrame - xing.trim
    : samples;
  checkAudioParameters(sampleRate, channels, expectedSamples);
  return checked({
    format: "mp3",
    sampleRate,
    channels,
    samples,
    expectedSamples,
    sampleTolerance: 0,
  });
}

function adts(bytes: Buffer): AudioLayout {
  let offset = 0,
    sampleRate = 0,
    channels = 0,
    samples = 0;
  while (offset < bytes.length) {
    if (
      offset + 7 > bytes.length ||
      bytes[offset] !== 255 ||
      (bytes[offset + 1] & 0xf6) !== 0xf0
    )
      invalid("AAC");
    const crc = !(bytes[offset + 1] & 1),
      profile = (bytes[offset + 2] >> 6) + 1;
    const rate = rates[(bytes[offset + 2] >> 2) & 15];
    const channel = ((bytes[offset + 2] & 1) << 2) | (bytes[offset + 3] >> 6);
    const length =
      ((bytes[offset + 3] & 3) << 11) |
      (bytes[offset + 4] << 3) |
      (bytes[offset + 5] >> 5);
    // Initial AAC policy is AAC-LC: other profiles can have different output
    // rates/sample counts and require a separate bounded decoding contract.
    if (
      profile !== 2 ||
      !rate ||
      (channel !== 1 && channel !== 2) ||
      bytes[offset + 6] & 3 ||
      length < (crc ? 9 : 7) ||
      offset + length > bytes.length ||
      (sampleRate && (sampleRate !== rate || channels !== channel))
    )
      invalid("AAC-LC");
    sampleRate = rate;
    channels = channel;
    samples += 1024;
    checkAudioParameters(sampleRate, channels, samples);
    offset += length;
  }
  return checked({
    format: "aac",
    sampleRate,
    channels,
    samples,
    sampleTolerance: 1024,
  });
}

function flac(bytes: Buffer): AudioLayout {
  let offset = 4,
    count = 0,
    streamInfo: Buffer | undefined;
  for (;;) {
    if (++count > 10000 || offset + 4 > bytes.length) invalid("FLAC");
    const last = bytes[offset] & 128,
      type = bytes[offset] & 127;
    const size = bytes.readUIntBE(offset + 1, 3);
    offset += 4;
    if (
      type === 127 ||
      offset + size > bytes.length ||
      (!streamInfo && (type !== 0 || size !== 34))
    )
      invalid("FLAC");
    if (type === 0) {
      if (streamInfo) invalid("FLAC");
      streamInfo = bytes.subarray(offset, offset + size);
    }
    offset += size;
    if (last) break;
  }
  if (!streamInfo || offset >= bytes.length) invalid("FLAC");
  const info = streamInfo.readBigUInt64BE(10);
  const sampleRate = Number(info >> 44n),
    channels = Number((info >> 41n) & 7n) + 1,
    samples = Number(info & 0xfffffffffn);
  const bitDepth = Number((info >> 36n) & 31n) + 1;
  if (
    !samples ||
    bitDepth < 4 ||
    bitDepth > 32 ||
    streamInfo.readUInt16BE(0) < 16 ||
    streamInfo.readUInt16BE(2) < streamInfo.readUInt16BE(0) ||
    bytes[offset] !== 255 ||
    (bytes[offset + 1] & 0xfe) !== 0xf8
  )
    invalid("FLAC");
  // Each complete FLAC frame has zero CRC-16 residue; so does the sequence.
  // Sample-count agreement and the decoder's errors independently catch a
  // parser skipping a bad/unsupported frame rather than accepting a prefix.
  let crc = 0;
  for (let i = offset; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit++)
      crc = ((crc << 1) ^ (crc & 0x8000 ? 0x8005 : 0)) & 0xffff;
  }
  if (crc) invalid("FLAC checksum");
  return checked({
    format: "flac",
    sampleRate,
    channels,
    samples,
    sampleTolerance: 0,
  });
}

const oggTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = (index << 24) >>> 0;
  for (let i = 0; i < 8; i++)
    crc = ((crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
  return crc;
});
function ogg(bytes: Buffer, format: "opus" | "vorbis"): AudioLayout {
  let offset = 0,
    serial: number | undefined,
    sequence = 0,
    pending = false,
    pages = 0;
  let sampleRate = 0,
    channels = 0,
    preSkip = 0,
    finalGranule = -1n,
    lastGranule = 0n;
  while (offset < bytes.length) {
    if (
      ++pages > 50000 ||
      offset + 27 > bytes.length ||
      bytes.toString("ascii", offset, offset + 4) !== "OggS" ||
      bytes[offset + 4] !== 0
    )
      invalid("Ogg");
    const flags = bytes[offset + 5],
      count = bytes[offset + 26],
      body = offset + 27 + count;
    if (
      body > bytes.length ||
      flags & ~7 ||
      Boolean(flags & 1) !== pending ||
      Boolean(flags & 2) !== (offset === 0) ||
      bytes.readUInt32LE(offset + 18) !== sequence++
    )
      invalid("Ogg");
    const id = bytes.readUInt32LE(offset + 14);
    if (serial !== undefined && id !== serial) invalid("multiplexed Ogg");
    serial = id;
    let end = body;
    for (let i = offset + 27; i < body; i++) end += bytes[i];
    if (end > bytes.length || Boolean(flags & 4) !== (end === bytes.length))
      invalid("Ogg");
    let crc = 0;
    for (let i = offset; i < end; i++) {
      const byte = i >= offset + 22 && i < offset + 26 ? 0 : bytes[i];
      crc = ((crc << 8) ^ oggTable[((crc >>> 24) ^ byte) & 255]) >>> 0;
    }
    if (crc !== bytes.readUInt32LE(offset + 22)) invalid("Ogg checksum");
    const granule = bytes.readBigInt64LE(offset + 6);
    if (granule < -1n || (granule >= 0n && granule < lastGranule))
      invalid("Ogg timeline");
    if (granule >= 0n) lastGranule = granule;
    pending = count ? bytes[body - 1] === 255 : pending;
    if (offset === 0) {
      if (count !== 1 || pending) invalid("Ogg identification");
      if (format === "opus") {
        if (
          end - body !== 19 ||
          bytes.toString("ascii", body, body + 8) !== "OpusHead" ||
          bytes[body + 8] !== 1 ||
          bytes[body + 18] !== 0
        )
          invalid("Ogg Opus mapping");
        channels = bytes[body + 9];
        preSkip = bytes.readUInt16LE(body + 10);
        sampleRate = 48000;
      } else {
        if (
          end - body !== 30 ||
          bytes[body] !== 1 ||
          bytes.toString("ascii", body + 1, body + 7) !== "vorbis" ||
          bytes.readUInt32LE(body + 7) !== 0 ||
          bytes[body + 29] !== 1
        )
          invalid("Ogg Vorbis identification");
        channels = bytes[body + 11];
        sampleRate = bytes.readUInt32LE(body + 12);
      }
      checkAudioParameters(sampleRate, channels, 1);
    }
    if (flags & 4) {
      if (pending) invalid("Ogg continuation");
      finalGranule = granule;
    }
    offset = end;
  }
  if (finalGranule < 0n || finalGranule > BigInt(Number.MAX_SAFE_INTEGER))
    invalid("Ogg timeline");
  return checked({
    format,
    sampleRate,
    channels,
    samples: Number(finalGranule) - preSkip,
    sampleTolerance: 0,
  });
}

export function preflightAudio(
  bytes: Buffer,
  format: AudioFormat,
): AudioLayout {
  if (bytes.length > MAX_BYTES) throw new Error("Source exceeds 25 MiB.");
  if (audioFormat(bytes) !== format) invalid("audio signature");
  switch (format) {
    case "mp3":
      return mp3(bytes);
    case "aac":
      return adts(bytes);
    case "flac":
      return flac(bytes);
    case "opus":
    case "vorbis":
      return ogg(bytes, format);
    default:
      throw new Error(
        "This container requires its dedicated bounded audio parser.",
      );
  }
}
