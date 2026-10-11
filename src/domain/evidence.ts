import Ajv from "ajv";
import { createHash } from "node:crypto";
import {
  artifactSections,
  isDocumentKind,
  type ArtifactKind,
  type ArtifactSection,
  type OutputKind,
} from "./artifacts.ts";
export const OUTPUT_CONTRACT_VERSION = 8;
export const TOOL_CONTRACT_VERSION = 4;

import {
  isStudyKind,
  studyItemSchema,
  validateStudy,
  type StudyKind,
  type StudyItem,
} from "./study.ts";
import {
  isStructuredKind,
  structuredProperties,
  structuredCitations,
  validateStructured,
  type StructuredKind,
  type MapNode,
  type TableColumn,
  type TableRow,
} from "./structured.ts";
import { overviewSpeechText } from "./audio-overview.ts";
import {
  slideProperties,
  validateSlides,
  type SlideKind,
  type DeckSlide,
} from "./slides.ts";

import type { DriveProvenance } from "./drive-provenance.ts";
import {
  infographicProperties,
  validateInfographic,
  type InfographicKind,
  type InfographicData,
} from "./infographic.ts";

export interface Passage {
  drive?: DriveProvenance | null;
  derivedFrom?: string | null;
  origin?: string | null;
  requestedOrigin?: string | null;
  retrievedAt?: string | null;
  originalHash?: string;
  extractionVersion?: string;
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
  coverage?: SourceCoverage[];
  kind?:
    ArtifactKind | StudyKind | StructuredKind | SlideKind | InfographicKind;
  infographic?: InfographicData;
  slides?: DeckSlide[];
  nodes?: MapNode[];
  columns?: TableColumn[];
  rows?: TableRow[];
  items?: StudyItem[];
  sections?: ArtifactSection[];
}
export interface SourceCoverage {
  sourceId: string;
  revisionId: string;
  title: string;
  totalPassages: number;
  readPassages: number;
  omittedSections: {
    locator: string;
    totalPassages: number;
    unreadPassages: number;
  }[];
}
// The model supplies claims and its own warnings. The application adds
// coverage from successful evidence responses, independently of model claims.
export const modelAnswerSchema = {
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
const sectionsSchema = {
  type: "array",
  minItems: 1,
  maxItems: 4,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["key", "blockIndexes"],
    properties: {
      key: { type: "string" },
      blockIndexes: {
        type: "array",
        maxItems: 80,
        items: { type: "integer", minimum: 0, maximum: 79 },
      },
    },
  },
} as const;
export function modelOutputSchema(kind: OutputKind) {
  if (kind === "answer") return modelAnswerSchema;
  if (kind === "infographic")
    return {
      ...modelAnswerSchema,
      required: [...modelAnswerSchema.required, "kind", "infographic"],
      properties: {
        ...modelAnswerSchema.properties,
        kind: { type: "string", enum: [kind] },
        ...infographicProperties,
      },
    };
  if (kind === "slides")
    return {
      ...modelAnswerSchema,
      required: [...modelAnswerSchema.required, "kind", "slides"],
      properties: {
        ...modelAnswerSchema.properties,
        kind: { type: "string", enum: [kind] },
        ...slideProperties,
      },
    };
  if (isStructuredKind(kind)) {
    const fields = structuredProperties(
      kind,
      modelAnswerSchema.properties.blocks.items.properties.citations,
    );
    return {
      ...modelAnswerSchema,
      required: [...modelAnswerSchema.required, "kind", ...Object.keys(fields)],
      properties: {
        ...modelAnswerSchema.properties,
        kind: { type: "string", enum: [kind] },
        ...fields,
      },
    };
  }
  if (isStudyKind(kind))
    return {
      ...modelAnswerSchema,
      required: [...modelAnswerSchema.required, "kind", "items"],
      properties: {
        ...modelAnswerSchema.properties,
        kind: { type: "string", enum: [kind] },
        items: {
          type: "array",
          maxItems: 20,
          items: studyItemSchema(
            kind,
            modelAnswerSchema.properties.blocks.items.properties.citations,
          ),
        },
      },
    };
  return {
    ...modelAnswerSchema,
    required: [...modelAnswerSchema.required, "kind", "sections"],
    properties: {
      ...modelAnswerSchema.properties,
      kind: { type: "string", enum: [kind] },
      sections: {
        ...sectionsSchema,
        minItems: artifactSections[kind].length,
        maxItems: artifactSections[kind].length,
        items: {
          ...sectionsSchema.items,
          properties: {
            ...sectionsSchema.items.properties,
            key: {
              type: "string",
              enum: artifactSections[kind].map((section) => section.key),
            },
          },
        },
      },
    },
  };
}
export const answerSchema = {
  ...modelAnswerSchema,
  properties: {
    ...modelAnswerSchema.properties,
    kind: {
      type: "string",
      enum: [
        ...Object.keys(artifactSections),
        "flashcards",
        "quiz",
        "mind-map",
        "data-table",
        "slides",
        "infographic",
      ],
    },
    sections: sectionsSchema,
    ...slideProperties,
    ...infographicProperties,
    ...structuredProperties(
      "mind-map",
      modelAnswerSchema.properties.blocks.items.properties.citations,
    ),
    ...structuredProperties(
      "data-table",
      modelAnswerSchema.properties.blocks.items.properties.citations,
    ),
    items: {
      type: "array",
      maxItems: 20,
      items: {
        anyOf: [
          studyItemSchema(
            "flashcards",
            modelAnswerSchema.properties.blocks.items.properties.citations,
          ),
          studyItemSchema(
            "quiz",
            modelAnswerSchema.properties.blocks.items.properties.citations,
          ),
        ],
      },
    },
    coverage: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "sourceId",
          "revisionId",
          "title",
          "totalPassages",
          "readPassages",
          "omittedSections",
        ],
        properties: {
          sourceId: { type: "string" },
          revisionId: { type: "string" },
          title: { type: "string" },
          totalPassages: { type: "integer", minimum: 1 },
          readPassages: { type: "integer", minimum: 0 },
          omittedSections: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["locator", "totalPassages", "unreadPassages"],
              properties: {
                locator: { type: "string" },
                totalPassages: { type: "integer", minimum: 1 },
                unreadPassages: { type: "integer", minimum: 1 },
              },
            },
          },
        },
      },
    },
  },
} as const;
export function evidenceCoverage(
  passages: readonly Passage[],
  read: ReadonlySet<string>,
): SourceCoverage[] {
  const sources = new Map<string, SourceCoverage>();
  const sections = new Map<
    string,
    Map<string, SourceCoverage["omittedSections"][number]>
  >();
  for (const p of passages) {
    let source = sources.get(p.revisionId);
    if (!source) {
      source = {
        sourceId: p.sourceId,
        revisionId: p.revisionId,
        title: p.title,
        totalPassages: 0,
        readPassages: 0,
        omittedSections: [],
      };
      sources.set(p.revisionId, source);
      sections.set(p.revisionId, new Map());
    }
    source.totalPassages++;
    if (read.has(p.id)) source.readPassages++;
    const byLocator = sections.get(p.revisionId)!;
    let section = byLocator.get(p.locator);
    if (!section) {
      section = { locator: p.locator, totalPassages: 0, unreadPassages: 0 };
      byLocator.set(p.locator, section);
    }
    section.totalPassages++;
    if (!read.has(p.id)) section.unreadPassages++;
  }
  for (const source of sources.values())
    source.omittedSections = [
      ...sections.get(source.revisionId)!.values(),
    ].filter((section) => section.unreadPassages > 0);
  return [...sources.values()];
}
const validate = new Ajv({ allErrors: true }).compile<Answer>(answerSchema);
export const points = (text: string) => Array.from(text);
export const slicePoints = (text: string, start: number, end: number) =>
  points(text).slice(start, end).join("");
export const digest = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");
export function validateAnswer(
  value: unknown,
  passages: readonly Passage[],
  expectedKind?: OutputKind,
  requestedCount?: number,
): Answer {
  if (!validate(value))
    throw new Error(
      "Invalid answer structure: " + new Ajv().errorsText(validate.errors),
    );
  if (
    expectedKind === "answer" &&
    (value.kind ||
      value.sections ||
      value.items ||
      value.nodes ||
      value.columns ||
      value.rows ||
      value.slides ||
      value.infographic)
  )
    throw new Error("A chat answer cannot use an artifact structure.");
  if (expectedKind && expectedKind !== "answer" && value.kind !== expectedKind)
    throw new Error("Artifact kind does not match the requested document.");
  if (value.kind === "infographic") validateInfographic(value);
  else if (value.infographic)
    throw Error("Only an infographic can contain its layout.");
  else if (value.kind === "slides") validateSlides(value);
  else if (value.slides) throw Error("Only a slide deck can contain slides.");
  else if (isStructuredKind(value.kind)) validateStructured(value);
  else if (value.nodes || value.columns || value.rows)
    throw new Error("Only structured material can contain maps or tables.");
  else if (isStudyKind(value.kind)) validateStudy(value, requestedCount ?? 20);
  else if (value.items)
    throw new Error("Only study material can contain study items.");
  else if (value.kind || value.sections) {
    if (!value.kind || !isDocumentKind(value.kind) || !value.sections)
      throw new Error("Artifact kind and sections are required together.");
    const expected = artifactSections[value.kind];
    if (
      value.sections.length !== expected.length ||
      value.sections.some((section, i) => section.key !== expected[i].key)
    )
      throw new Error(
        "Artifact sections must match the requested layout in order.",
      );
    const assigned = value.sections.flatMap((section) => section.blockIndexes);
    if (
      assigned.length !== value.blocks.length ||
      new Set(assigned).size !== assigned.length ||
      assigned.some((index) => index >= value.blocks.length)
    )
      throw new Error(
        "Every artifact block must appear in exactly one section.",
      );
  }
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
  for (const block of [
    ...value.blocks,
    ...(value.items ?? []).map((item) => ({
      kind: "notice",
      citations: item.questionCitations,
    })),
    { kind: "notice", citations: structuredCitations(value) },
  ]) {
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
  if (value.kind === "audio-overview" && value.status === "answered")
    overviewSpeechText(value);
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
      contract: OUTPUT_CONTRACT_VERSION,
      tools: TOOL_CONTRACT_VERSION,
      mode: "sources",
    }),
  );
}
