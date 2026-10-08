import Ajv from "ajv";
import { createHash } from "node:crypto";

export interface Passage {
  derivedFrom?: string | null;
  origin?: string | null;
  warnings?: string[];
  id: string;
  sourceId: string;
  revisionId: string;
  title: string;
  locator: string;
  text: string;
  start: number;
  end: number;
}
export interface Citation {
  passageId: string;
  quote: string;
  start: number;
  end: number;
}
export interface Answer {
  status: "answered" | "insufficient_evidence";
  title: string;
  blocks: {
    text: string;
    kind: "fact" | "inference" | "notice";
    citations: Citation[];
  }[];
  coverageWarnings: string[];
}
export const answerSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "title", "blocks", "coverageWarnings"],
  properties: {
    status: { type: "string", enum: ["answered", "insufficient_evidence"] },
    title: { type: "string", minLength: 1, maxLength: 200 },
    blocks: {
      type: "array",
      maxItems: 80,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "kind", "citations"],
        properties: {
          text: { type: "string", minLength: 1, maxLength: 8000 },
          kind: { type: "string", enum: ["fact", "inference", "notice"] },
          citations: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["passageId", "quote", "start", "end"],
              properties: {
                passageId: { type: "string" },
                quote: { type: "string", minLength: 1, maxLength: 8000 },
                start: { type: "integer", minimum: 0 },
                end: { type: "integer", minimum: 1 },
              },
            },
          },
        },
      },
    },
    coverageWarnings: {
      type: "array",
      maxItems: 50,
      items: { type: "string", maxLength: 1000 },
    },
  },
} as const;
const validate = new Ajv({ allErrors: true }).compile<Answer>(answerSchema);
export const points = (text: string) => Array.from(text);
export const slicePoints = (text: string, start: number, end: number) =>
  points(text).slice(start, end).join("");
export const digest = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");
export function validateAnswer(
  value: unknown,
  passages: readonly Passage[],
): Answer {
  if (!validate(value))
    throw new Error(
      "Invalid answer structure: " + new Ajv().errorsText(validate.errors),
    );
  if (
    value.status === "answered" &&
    !value.blocks.some((b) => b.kind !== "notice")
  )
    throw new Error("An answer needs supported content.");
  if (
    value.status === "insufficient_evidence" &&
    value.blocks.some((b) => b.kind !== "notice")
  )
    throw new Error("Insufficient evidence may only contain notices.");
  const allowed = new Map(passages.map((p) => [p.id, p]));
  for (const block of value.blocks) {
    if (block.kind !== "notice" && block.citations.length === 0)
      throw new Error("Factual and inferred blocks require evidence.");
    for (const cite of block.citations) {
      const passage = allowed.get(cite.passageId);
      if (!passage)
        throw new Error("Citation references an unselected passage.");
      if (
        cite.end <= cite.start ||
        cite.end > points(passage.text).length ||
        slicePoints(passage.text, cite.start, cite.end) !== cite.quote
      )
        throw new Error("Citation does not match its evidence span.");
    }
  }
  return value;
}
export function chunkText(
  text: string,
  sourceId: string,
  revisionId: string,
  title: string,
  locator = "Text",
): Passage[] {
  const normalized = text.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  const chars = points(normalized),
    result: Passage[] = [];
  for (let start = 0; start < chars.length; start += 1400) {
    const end = Math.min(start + 1600, chars.length);
    result.push({
      id: digest(revisionId + ":" + locator + ":" + start).slice(0, 32),
      sourceId,
      revisionId,
      title,
      locator,
      text: chars.slice(start, end).join(""),
      start,
      end,
    });
    if (end === chars.length) break;
  }
  return result;
}
export function contextKey(revisions: string[], instructions: string): string {
  return digest(
    JSON.stringify({
      revisions: [...new Set(revisions)].sort(),
      instructions,
      contract: 1,
      tools: 2,
      mode: "sources",
    }),
  );
}
