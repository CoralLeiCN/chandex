export type AudioStage =
  "decoding" | "loading_model" | "recognizing" | "validating";
export type AudioProgress = (stage: AudioStage) => void;
export const AUDIO_STAGES: readonly AudioStage[] = [
  "decoding",
  "loading_model",
  "recognizing",
  "validating",
];
