import type { Answer, Citation } from "./evidence.ts";

export type StudyKind = "flashcards" | "quiz";
export interface StudyItem {
  id: string;
  question: string;
  questionCitations: Citation[];
  answerBlockIndexes: number[];
  options?: { id: string; text: string }[];
  correctOptionId?: string;
  explanationBlockIndexes?: number[];
}
export const isStudyKind = (kind: unknown): kind is StudyKind =>
  kind === "flashcards" || kind === "quiz";
export function studyItemSchema(kind: StudyKind, citations: object) {
  const indexes = {
    type: "array",
    minItems: 1,
    maxItems: 4,
    items: { type: "integer", minimum: 0, maximum: 79 },
  };
  const common = {
    id: { type: "string", minLength: 1, maxLength: 100 },
    question: { type: "string", minLength: 1, maxLength: 2000 },
    questionCitations: citations,
    answerBlockIndexes: kind === "quiz" ? { ...indexes, maxItems: 1 } : indexes,
  };
  return {
    type: "object",
    additionalProperties: false,
    required: [
      ...Object.keys(common),
      ...(kind === "quiz"
        ? ["options", "correctOptionId", "explanationBlockIndexes"]
        : []),
    ],
    properties: {
      ...common,
      ...(kind === "quiz"
        ? {
            options: {
              type: "array",
              minItems: 3,
              maxItems: 4,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "text"],
                properties: {
                  id: { type: "string", minLength: 1, maxLength: 100 },
                  text: { type: "string", minLength: 1, maxLength: 2000 },
                },
              },
            },
            correctOptionId: { type: "string", minLength: 1, maxLength: 100 },
            explanationBlockIndexes: indexes,
          }
        : {}),
    },
  };
}
export function studyCount(value: unknown = 10): number {
  if (!Number.isSafeInteger(value) || Number(value) < 5 || Number(value) > 20)
    throw new Error("Request between 5 and 20 study items.");
  return Number(value);
}
export function validateStudy(answer: Answer, requestedCount = 20) {
  if (!isStudyKind(answer.kind) || !answer.items || answer.sections)
    throw new Error(
      "Study material requires items, without document sections.",
    );
  if (answer.status === "insufficient_evidence") {
    if (answer.items.length)
      throw new Error(
        "Insufficient evidence cannot produce playable study items.",
      );
    return;
  }
  if (!answer.items.length || answer.items.length > requestedCount)
    throw new Error(
      "Study item count exceeds the request or has no supported items.",
    );
  if (
    answer.items.length < requestedCount &&
    !answer.coverageWarnings.some((w) => w.trim())
  )
    throw new Error(
      "Fewer study items require an explicit evidence/count warning.",
    );
  const ids = new Set<string>(),
    questions = new Set<string>(),
    assigned: number[] = [];
  const normalized = (text: string) =>
    text.trim().normalize("NFC").toLocaleLowerCase("en");
  for (const item of answer.items) {
    if (
      !item.id.trim() ||
      ids.has(item.id) ||
      !item.question.trim() ||
      questions.has(normalized(item.question))
    )
      throw new Error(
        "Study item IDs and questions must be distinct and nonempty.",
      );
    ids.add(item.id);
    questions.add(normalized(item.question));
    if (answer.kind === "flashcards") {
      if (item.options || item.correctOptionId || item.explanationBlockIndexes)
        throw new Error("Flashcards cannot contain quiz answer keys.");
    } else {
      if (
        !item.options ||
        !item.correctOptionId ||
        !item.explanationBlockIndexes ||
        item.answerBlockIndexes.length !== 1
      )
        throw new Error(
          "Quiz items require options, one answer block and an explanation.",
        );
      if (
        new Set(item.options.map((o) => o.id)).size !== item.options.length ||
        new Set(item.options.map((o) => normalized(o.text))).size !==
          item.options.length ||
        item.options.some((o) => !o.id.trim() || !o.text.trim())
      )
        throw new Error("Quiz options must be distinct and nonempty.");
      const correct = item.options.find((o) => o.id === item.correctOptionId);
      const block = answer.blocks[item.answerBlockIndexes[0]];
      if (
        !correct ||
        !block ||
        block.kind !== "fact" ||
        correct.text !== block.text
      )
        throw new Error(
          "The quiz key must identify exactly one option matching its cited factual answer.",
        );
    }
    const indexes = [
      ...item.answerBlockIndexes,
      ...(item.explanationBlockIndexes ?? []),
    ];
    if (
      indexes.some(
        (i) => !answer.blocks[i] || answer.blocks[i].kind === "notice",
      )
    )
      throw new Error(
        "Study answers and explanations must reference supported blocks.",
      );
    assigned.push(...indexes);
  }
  const supported = answer.blocks
    .map((b, i) => (b.kind !== "notice" ? i : -1))
    .filter((i) => i >= 0);
  if (
    assigned.length !== supported.length ||
    new Set(assigned).size !== assigned.length ||
    supported.some((i) => !assigned.includes(i))
  )
    throw new Error(
      "Every supported study block must belong to exactly one item.",
    );
}
// Promotion deliberately omits distractors and learner attempts.
export function studyGroups<T>(content: {
  kind?: string;
  items?: StudyItem[];
  blocks?: T[];
}) {
  return [
    ...(content.items ?? []).flatMap((item, i) => [
      { title: `${i + 1}. ${item.question}`, blocks: [] as T[] },
      {
        title: content.kind === "quiz" ? "Correct answer" : "Answer",
        blocks: item.answerBlockIndexes.map((index) => content.blocks![index]),
      },
      ...(item.explanationBlockIndexes
        ? [
            {
              title: "Explanation",
              blocks: item.explanationBlockIndexes.map(
                (index) => content.blocks![index],
              ),
            },
          ]
        : []),
    ]),
    {
      blocks: (content.blocks ?? []).filter(
        (block) => (block as { kind?: string }).kind === "notice",
      ),
    },
  ];
}
