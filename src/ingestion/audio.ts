import { decodeAudio } from "./audio-decode.ts";
import { resampleAudio } from "./audio-pcm.ts";
import { recognizeAudio } from "./audio-recognize.ts";
import { AUDIO_TARGET_RATE } from "./audio-limits.ts";
import type { Extracted } from "./extract.ts";
import type { AudioProgress } from "./audio-progress.ts";

export async function extractAudio(
  bytes: Buffer,
  onProgress?: AudioProgress,
): Promise<Extracted> {
  onProgress?.("decoding");
  const decoded = await decodeAudio(bytes);
  const samples = resampleAudio(decoded.mono, decoded.sampleRate);
  const result = await recognizeAudio(samples, onProgress);
  return {
    ...result,
    warnings: [
      ...decoded.warnings,
      decoded.sampleRate === AUDIO_TARGET_RATE
        ? "Recognition uses the decoded 16 kHz mono audio."
        : `Recognition resamples ${decoded.sampleRate} Hz mono audio to 16 kHz using a rate-scaled Hann-windowed sinc filter (256 phases, zero-padded edges).`,
      ...result.warnings,
    ],
  };
}
