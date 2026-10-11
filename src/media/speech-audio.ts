import { decodeWav } from "../ingestion/audio-pcm.ts";
export const SPEECH_MAX_BYTES = 25 * 1024 * 1024;
export const SPEECH_DEADLINE_MS = 300000;
export function validateSpeechAudio(bytes: Buffer) {
  if (bytes.length > SPEECH_MAX_BYTES)
    throw new Error("Generated speech exceeds 25 MiB.");
  const pcm = decodeWav(bytes);
  let format = -1;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    if (bytes.toString("ascii", offset, offset + 4) === "fmt ") {
      format = offset + 8;
      break;
    }
    const length = bytes.readUInt32LE(offset + 4);
    offset += 8 + length + (length % 2);
  }
  if (
    format < 0 ||
    bytes.readUInt16LE(format) !== 1 ||
    bytes.readUInt16LE(format + 14) !== 16 ||
    pcm.channels !== 1 ||
    pcm.sampleRate !== 22050
  )
    throw new Error("Generated speech has an unsupported audio format.");
  const duration = pcm.mono.length / pcm.sampleRate;
  if (duration > 300) throw new Error("Generated speech exceeds five minutes.");
  const mean =
    pcm.mono.reduce((sum, value) => sum + value * value, 0) / pcm.mono.length;
  if (Math.sqrt(mean) < 1e-4)
    throw new Error("The speech provider produced no usable audio.");
  return { duration, sampleRate: pcm.sampleRate, channels: pcm.channels };
}
