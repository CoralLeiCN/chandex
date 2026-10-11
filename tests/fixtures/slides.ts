import type { Answer, Passage } from "../../src/domain/evidence.ts";

export const slideSourceText =
  "Zoë proposes a €240 budget, conditional on reviewer approval. The date is not confirmed. No launch commitment has been made.";

export function slideAnswer(p: Passage): Answer {
  const citations = [
    {
      passageId: p.id,
      quote: p.text,
      start: 0,
      end: Array.from(p.text).length,
    },
  ];
  return {
    kind: "slides",
    status: "answered",
    title: "Conditional proposal",
    blocks: [
      { kind: "fact", text: "Zoë’s proposal needs approval", citations },
      {
        kind: "fact",
        text: "Zoë proposes €240, conditional on reviewer approval.",
        citations,
      },
      {
        kind: "inference",
        text: "Treat approval as a prerequisite, rather than a launch commitment.",
        citations,
      },
      { kind: "fact", text: "The date is not confirmed", citations },
      { kind: "fact", text: "No launch commitment has been made.", citations },
      {
        kind: "notice",
        text: "The source does not state who the reviewer is.",
        citations: [],
      },
    ],
    slides: [
      {
        id: "approval",
        headlineBlockIndex: 0,
        bodyBlockIndexes: [1],
        noteBlockIndexes: [2],
      },
      {
        id: "timing",
        headlineBlockIndex: 3,
        bodyBlockIndexes: [4],
        noteBlockIndexes: [],
      },
    ],
    coverageWarnings: ["This is a proposal, not an approved budget."],
  };
}
