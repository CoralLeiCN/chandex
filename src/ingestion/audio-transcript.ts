import type { Extracted } from "./extract.ts";
import {
  AUDIO_MODEL,
  AUDIO_MODEL_LANGUAGE,
  AUDIO_MODEL_REVISION,
} from "./audio-assets.ts";
import { AUDIO_MAX_SECONDS } from "./audio-limits.ts";

const normalize = (text: string) =>
  text.replace(/\r\n?/g, "\n").normalize("NFC").trim();
const words = (text: string) => normalize(text).replace(/\s+/gu, " ");
function time(seconds: number | null) {
  if (seconds === null) return "unknown";
  const hundredths = Math.round(seconds * 100);
  return `${String(Math.floor(hundredths / 6000)).padStart(2, "0")}:${String(Math.floor(hundredths / 100) % 60).padStart(2, "0")}.${String(hundredths % 100).padStart(2, "0")}`;
}

export function normalizeAudioTranscript(
  value: unknown,
  duration: number,
): Extracted {
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > AUDIO_MAX_SECONDS
  )
    throw new Error("Invalid audio duration.");
  const result = value as { text?: unknown; chunks?: unknown } | null;
  if (
    !result ||
    typeof result.text !== "string" ||
    !Array.isArray(result.chunks) ||
    !result.chunks.length ||
    result.chunks.length > 10000
  )
    throw new Error(
      "Transcription returned an incomplete transcript. Nothing was imported.",
    );
  const complete = words(result.text);
  if (
    !complete ||
    complete.includes("\0") ||
    Array.from(complete).length > 500000
  )
    throw new Error(
      "Transcription returned no usable text or exceeded the text limit.",
    );
  const warnings = [
    `Automatic English transcript: ${AUDIO_MODEL} @ ${AUDIO_MODEL_REVISION}; Transformers.js 4.3.1, CPU quantized inference.`,
    "Speech recognition can invent or miss words. Listen to the original before relying on names, numbers, negation or commitments. This model does not verify speakers or identify speech versus noise.",
    "Segment times are estimates relative to the decoded audio; citations quote the stored transcript, not verified speech or waveform offsets.",
  ];
  const sections: Extracted["sections"] = [];
  const originalChunks: string[] = [];
  let lastStart: number | null = null;
  let unknownBoundary = false;
  for (const value of result.chunks) {
    const chunk = value as { text?: unknown; timestamp?: unknown } | null;
    if (
      !chunk ||
      typeof chunk.text !== "string" ||
      !Array.isArray(chunk.timestamp) ||
      chunk.timestamp.length !== 2
    )
      throw new Error(
        "Transcription returned an invalid segment. Nothing was imported.",
      );
    const text = words(chunk.text);
    if (!text || text.includes("\0"))
      throw new Error(
        "Transcription returned an empty or invalid segment. Nothing was imported.",
      );
    originalChunks.push(chunk.text);
    const bounds = chunk.timestamp.map((value: unknown): number | null => {
      if (value === null) {
        unknownBoundary = true;
        return null;
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        throw new Error(
          "Transcription returned invalid segment times. Nothing was imported.",
        );
      if (value > duration) {
        unknownBoundary = true;
        return null;
      }
      return value;
    });
    const [start, end] = bounds;
    // Validate ordering before converting model padding beyond the real audio
    // to an unknown boundary; do not turn inverted intervals into valid ones.
    const [rawStart, rawEnd] = chunk.timestamp;
    if (
      typeof rawStart === "number" &&
      typeof rawEnd === "number" &&
      rawEnd < rawStart
    )
      throw new Error(
        "Transcription returned inverted segment times. Nothing was imported.",
      );
    if (start !== null && lastStart !== null && start < lastStart)
      throw new Error(
        "Transcription returned unordered segments. Nothing was imported.",
      );
    if (start !== null) lastStart = start;
    sections.push({
      locator: `Audio ${sections.length + 1} · ${time(start)}–${time(end)} (estimated)`,
      text,
    });
  }
  // Compare complete canonical text, including punctuation and Unicode, with
  // the raw joined chunks. Reject an unassigned prefix/tail instead of losing
  // it when publishing only the timestamped sections.
  if (
    words(originalChunks.join("")) !== complete ||
    words(sections.map((section) => section.text).join(" ")) !== complete
  )
    throw new Error(
      "Transcript segments do not cover the complete recognized text. Nothing was imported.",
    );
  if (unknownBoundary)
    warnings.push(
      "Some estimated segment boundaries are unavailable or extend beyond the decoded recording and are labeled unknown; no replacement times were invented.",
    );
  warnings.push(
    `Recognition language: ${AUDIO_MODEL_LANGUAGE}. Speaker identities, diarization and translation are unavailable.`,
  );
  return { sections, warnings };
}
