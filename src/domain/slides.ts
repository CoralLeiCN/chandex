import type { Answer } from "./evidence.ts";

export type SlideKind = "slides";
export interface DeckSlide {
  id: string;
  headlineBlockIndex: number;
  bodyBlockIndexes: number[];
  noteBlockIndexes: number[];
}
export const slideProperties = {
  slides: {
    type: "array",
    maxItems: 8,
    items: {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "headlineBlockIndex",
        "bodyBlockIndexes",
        "noteBlockIndexes",
      ],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 100 },
        headlineBlockIndex: { type: "integer", minimum: 0, maximum: 79 },
        bodyBlockIndexes: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: { type: "integer", minimum: 0, maximum: 79 },
        },
        noteBlockIndexes: {
          type: "array",
          maxItems: 2,
          items: { type: "integer", minimum: 0, maximum: 79 },
        },
      },
    },
  },
} as const;
export function slideIndexes(slide: DeckSlide) {
  return [
    slide.headlineBlockIndex,
    ...slide.bodyBlockIndexes,
    ...slide.noteBlockIndexes,
  ];
}
export function validateSlides(answer: Answer) {
  if (
    answer.kind !== "slides" ||
    !answer.slides ||
    answer.sections ||
    answer.items ||
    answer.nodes ||
    answer.columns ||
    answer.rows
  )
    throw Error(
      "A slide deck requires slides without another artifact layout.",
    );
  if (answer.status === "insufficient_evidence") {
    if (answer.slides.length)
      throw Error("Insufficient evidence cannot populate slides.");
    return;
  }
  if (
    !answer.slides.length ||
    new Set(answer.slides.map((s) => s.id)).size !== answer.slides.length ||
    answer.slides.some((s) => !s.id.trim())
  )
    throw Error("A supported deck needs slides with distinct nonempty IDs.");
  const assigned = answer.slides.flatMap(slideIndexes),
    supported = answer.blocks.flatMap((b, i) =>
      b.kind === "notice" ? [] : [i],
    );
  if (
    assigned.length !== supported.length ||
    new Set(assigned).size !== assigned.length ||
    assigned.some((i) => !supported.includes(i))
  )
    throw Error("Every supported slide block must be assigned exactly once.");
  for (const slide of answer.slides) {
    for (const [indexes, limit] of [
      [[slide.headlineBlockIndex], 70],
      [slide.bodyBlockIndexes, 160],
      [slide.noteBlockIndexes, 400],
    ] as const)
      for (const index of indexes) {
        const block = answer.blocks[index];
        if (
          !block.text.trim() ||
          Array.from(block.text).length > limit ||
          /[\x00-\x1f\x7f]/.test(block.text) ||
          block.citations.length > 4
        )
          throw Error(
            "Slide claims exceed their concise text/reference limits.",
          );
      }
  }
}
export function slideGroups<T>(content: {
  slides?: DeckSlide[];
  blocks?: T[];
}) {
  return (content.slides ?? []).flatMap((s, i) => [
    {
      title: `Slide ${i + 1}`,
      blocks: [s.headlineBlockIndex, ...s.bodyBlockIndexes].map(
        (index) => content.blocks![index],
      ),
    },
    ...(s.noteBlockIndexes.length
      ? [
          {
            title: `Speaker notes for slide ${i + 1}`,
            blocks: s.noteBlockIndexes.map((index) => content.blocks![index]),
          },
        ]
      : []),
  ]);
}
