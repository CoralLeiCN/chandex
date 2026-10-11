export const AUDIO_MAX_SECONDS = 600;
export const AUDIO_MAX_CHANNEL_SAMPLES = 24_000_000;
export const AUDIO_MIN_RATE = 8000;
export const AUDIO_MAX_RATE = 96000;
export const AUDIO_TARGET_RATE = 16000;
export const AUDIO_DEADLINE_MS = 300000;

export function checkAudioParameters(
  rate: number,
  channels: number,
  samples: number,
) {
  if (
    !Number.isSafeInteger(rate) ||
    rate < AUDIO_MIN_RATE ||
    rate > AUDIO_MAX_RATE
  )
    throw new Error("Audio must use an 8–96 kHz sampling rate.");
  if (channels !== 1 && channels !== 2)
    throw new Error("Audio must have one or two channels.");
  if (!Number.isSafeInteger(samples) || samples < 1)
    throw new Error("Audio contains no usable samples.");
  if (samples / rate > AUDIO_MAX_SECONDS)
    throw new Error("Audio exceeds the ten-minute transcription limit.");
  if (samples * channels > AUDIO_MAX_CHANNEL_SAMPLES)
    throw new Error(
      "Audio exceeds the 24-million decoded channel-sample limit. Use a lower sampling rate or a shorter recording.",
    );
}
