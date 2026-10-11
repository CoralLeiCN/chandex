import type { Answer, Passage } from "../../src/domain/evidence.ts";
export const infographicSourceText =
  "Zoë proposes €240, conditional on reviewer approval. The date is not confirmed. No launch commitment has been made. First record the proposal, then ask the reviewer, and only after approval schedule the work.";
export function infographicAnswer(p: Passage): Answer {
  const citations = [
    {
      passageId: p.id,
      quote: p.text,
      start: 0,
      end: Array.from(p.text).length,
    },
  ];
  return {
    kind: "infographic",
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
        text: "Approval is a prerequisite; the proposal is not a launch commitment.",
        citations,
      },
      { kind: "fact", text: "The date is not confirmed", citations },
      { kind: "fact", text: "No launch commitment has been made.", citations },
      {
        kind: "notice",
        text: "The source does not name the reviewer.",
        citations: [],
      },
    ],
    infographic: {
      layout: "cards",
      orderBlockIndex: null,
      cards: [
        { id: "approval", headlineBlockIndex: 0, bodyBlockIndexes: [1, 2] },
        { id: "timing", headlineBlockIndex: 3, bodyBlockIndexes: [4] },
      ],
    },
    coverageWarnings: ["This is a proposal, not an approved budget."],
  };
}
