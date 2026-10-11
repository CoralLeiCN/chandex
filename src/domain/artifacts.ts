import {
  isStudyKind,
  studyGroups,
  type StudyKind,
  type StudyItem,
} from "./study.ts";
import {
  isStructuredKind,
  structuredText,
  type StructuredKind,
  type MapNode,
  type TableColumn,
  type TableRow,
} from "./structured.ts";
import { isRichNote, richText } from "./notes.ts";
import { slideGroups, type SlideKind, type DeckSlide } from "./slides.ts";
import {
  infographicGroups,
  type InfographicKind,
  type InfographicData,
} from "./infographic.ts";
export const artifactSections = {
  summary: [
    { key: "key_points", title: "Key points" },
    { key: "limitations", title: "Limitations" },
  ],
  briefing: [
    { key: "context", title: "Context" },
    { key: "findings", title: "Findings" },
    { key: "disagreements", title: "Disagreements" },
    { key: "open_questions", title: "Open questions" },
  ],
  "study-guide": [
    { key: "concepts", title: "Concepts" },
    { key: "explanations", title: "Explanations" },
    { key: "examples", title: "Examples" },
    { key: "revision_questions", title: "Revision questions" },
  ],
  faq: [{ key: "questions_and_answers", title: "Questions & answers" }],
  "audio-overview": [
    { key: "opening", title: "Opening" },
    { key: "main_ideas", title: "Main ideas" },
    { key: "differences", title: "Differences" },
    { key: "limitations", title: "Limitations" },
  ],
} as const;
export type ArtifactKind = keyof typeof artifactSections;
export type OutputKind =
  | "answer"
  | ArtifactKind
  | StudyKind
  | StructuredKind
  | SlideKind
  | InfographicKind;
export interface ArtifactSection {
  key: string;
  blockIndexes: number[];
}
export function isDocumentKind(kind: string): kind is ArtifactKind {
  return Object.hasOwn(artifactSections, kind);
}
export function isArtifactKind(
  kind: string,
): kind is
  ArtifactKind | StudyKind | StructuredKind | SlideKind | InfographicKind {
  return (
    isDocumentKind(kind) ||
    isStudyKind(kind) ||
    isStructuredKind(kind) ||
    kind === "slides" ||
    kind === "infographic"
  );
}
export function sectionTitle(kind: ArtifactKind, key: string): string {
  return (
    artifactSections[kind].find((section) => section.key === key)?.title ?? key
  );
}
export function documentGroups<T>(content: {
  kind?: string;
  sections?: ArtifactSection[];
  items?: StudyItem[];
  blocks?: T[];
  slides?: DeckSlide[];
  infographic?: InfographicData;
}): { title?: string; blocks: T[] }[] {
  const blocks = content.blocks ?? [];
  if (content.kind === "infographic") {
    const notices = blocks.filter(
      (b) => (b as { kind?: string }).kind === "notice",
    );
    return [
      ...infographicGroups(content),
      ...(notices.length ? [{ title: "Evidence gaps", blocks: notices }] : []),
    ];
  }
  if (content.kind === "slides") {
    const notices = blocks.filter(
      (b) => (b as { kind?: string }).kind === "notice",
    );
    return [
      ...slideGroups(content),
      ...(notices.length ? [{ title: "Evidence gaps", blocks: notices }] : []),
    ];
  }
  if (isStudyKind(content.kind)) return studyGroups(content);
  if (!content.kind || !isDocumentKind(content.kind) || !content.sections)
    return [{ blocks }];
  const kind = content.kind;
  return content.sections.map((section) => ({
    title: sectionTitle(kind, section.key),
    blocks: section.blockIndexes
      .map((index) => blocks[index])
      .filter((block) => block !== undefined),
  }));
}
export function documentText(
  content: {
    format?: string;
    version?: number;
    doc?: import("./notes.ts").NoteNode;
    text?: string;
    title?: string;
    kind?: string;
    sections?: ArtifactSection[];
    items?: StudyItem[];
    nodes?: MapNode[];
    columns?: TableColumn[];
    rows?: TableRow[];
    coverageWarnings?: string[];
    blocks?: { text: string }[];
    slides?: DeckSlide[];
    infographic?: InfographicData;
  },
  includeCandidates = false,
): string {
  if (isRichNote(content)) return richText(content);
  if (content.text !== undefined) return content.text;
  if (isStructuredKind(content.kind))
    return structuredText(content as Parameters<typeof structuredText>[0]);
  if (isStudyKind(content.kind) && includeCandidates)
    return [
      content.title ?? "",
      ...(content.items ?? []).flatMap((item, i) => [
        `${i + 1}. ${item.question}`,
        ...(item.options ?? []).map(
          (option) =>
            `Candidate answer (${option.id === item.correctOptionId ? "correct" : "distractor"}): ${option.text}`,
        ),
        "Answer",
        ...item.answerBlockIndexes.map((index) => content.blocks![index].text),
        ...(item.explanationBlockIndexes
          ? [
              "Explanation",
              ...item.explanationBlockIndexes.map(
                (index) => content.blocks![index].text,
              ),
            ]
          : []),
      ]),
      ...(content.blocks ?? [])
        .filter((block) => (block as { kind?: string }).kind === "notice")
        .map((block) => block.text),
    ]
      .filter(Boolean)
      .join("\n\n");
  return [
    content.title ?? "",
    ...documentGroups(content).flatMap((group) => [
      ...(group.title ? [group.title] : []),
      ...group.blocks.map(
        (block) =>
          `${(block as { kind?: string }).kind === "inference" ? "Inference: " : (block as { kind?: string }).kind === "notice" ? "Evidence limitation: " : ""}${block.text}`,
      ),
      ...(!isStudyKind(content.kind) && group.title && !group.blocks.length
        ? ["No supported content was produced for this section."]
        : []),
    ]),
    ...(content.coverageWarnings?.length
      ? ["Coverage warnings", ...content.coverageWarnings]
      : []),
  ]
    .filter(Boolean)
    .join("\n\n");
}
