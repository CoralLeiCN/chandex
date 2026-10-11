import type { Answer } from "./evidence.ts";
import { documentGroups } from "./artifacts.ts";

export const SPEECH_SCRIPT_VERSION = 1;
export const MAX_SPEECH_CHARACTERS = 8000;
export const MAX_SPEECH_WORDS = 700;
export const SPEECH_PROVIDER_ID = "macos-speech";
export const SPEECH_RENDERER_VERSION = 1;
export const SPEECH_VOICES = [
  { id: "samantha", name: "Samantha", language: "en-US" },
  { id: "daniel", name: "Daniel", language: "en-GB" },
] as const;
export function speechVoice(id: string) {
  const voice = SPEECH_VOICES.find((v) => v.id === id);
  if (!voice) throw new Error("Choose a supported English speech voice.");
  return voice;
}
export const SPEECH_NOTICE =
  "This is generated speech from an AI-written script. Check the written script and its cited sources before relying on its claims.";

/** Every utterance is derived from the immutable script without another model. */
export function overviewSpeechText(answer: Answer): string {
  if (answer.kind !== "audio-overview" || answer.status !== "answered")
    throw new Error("Speech requires a supported audio overview script.");
  const text = [
    SPEECH_NOTICE,
    answer.title,
    ...documentGroups(answer).flatMap((group) => [
      group.title!,
      ...(group.blocks.length
        ? group.blocks.map(
            (block) =>
              `${block.kind === "inference" ? "Interpretation. " : block.kind === "notice" ? "Evidence limitation. " : ""}${block.text}`,
          )
        : ["No supported content was produced for this section."]),
    ]),
    ...(answer.coverageWarnings.length
      ? ["Coverage notes.", ...answer.coverageWarnings]
      : []),
  ].join("\n\n");
  validateSpeechText(text);
  return text;
}
export function validateSpeechText(text: string) {
  if (!text.trim()) throw new Error("Audio overview requires spoken text.");
  if (
    text.normalize("NFC") !== text ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) ||
    [...text].some((c) => c.length === 1 && /[\ud800-\udfff]/u.test(c))
  )
    throw new Error("Audio overview requires complete canonical Unicode text.");
  // Native speech interprets embedded commands. Refuse them without changing
  // cited wording, provider settings or the complete spoken-text hash.
  if (text.includes("[[") || text.includes("]]"))
    throw new Error("Audio overview cannot contain embedded speech commands.");
  if (
    [...text].length > MAX_SPEECH_CHARACTERS ||
    (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? []).length >
      MAX_SPEECH_WORDS
  )
    throw new Error(
      "Audio overview exceeds the complete 8,000-character or 700-word speech limit.",
    );
}
