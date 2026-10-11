import type { Answer, Passage } from "../../src/domain/evidence.ts";
import type { StudyKind } from "../../src/domain/study.ts";
export function studyAnswer(p: Passage, kind: StudyKind): Answer {
  const citations = [
    {
      passageId: p.id,
      quote: p.text,
      start: 0,
      end: Array.from(p.text).length,
    },
  ];
  return {
    kind,
    status: "answered",
    title: kind === "quiz" ? "Evidence quiz" : "Evidence cards",
    blocks: [
      { text: p.text, kind: "fact", citations },
      ...(kind === "quiz"
        ? [
            {
              text: "The selected source states: " + p.text,
              kind: "fact" as const,
              citations,
            },
          ]
        : []),
    ],
    items: [
      {
        id: "item-1",
        question: "Which statement appears in the selected source?",
        questionCitations: citations,
        answerBlockIndexes: [0],
        ...(kind === "quiz"
          ? {
              options: [
                { id: "correct", text: p.text },
                {
                  id: "wrong",
                  text: "A candidate answer absent from the source.",
                },
                {
                  id: "other",
                  text: "Another distractor absent from the source.",
                },
              ],
              correctOptionId: "correct",
              explanationBlockIndexes: [1],
            }
          : {}),
      },
    ],
    coverageWarnings: [
      "Only one distinct item is supported by this small fixture.",
    ],
  };
}
