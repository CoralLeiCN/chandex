import type { Answer } from "./evidence.ts";

export type InfographicKind = "infographic";
export interface InfographicCard {
  id: string;
  headlineBlockIndex: number;
  bodyBlockIndexes: number[];
}
export interface InfographicData {
  layout: "cards" | "comparison" | "steps";
  cards: InfographicCard[];
  orderBlockIndex: number | null;
}
const index = { type: "integer", minimum: 0, maximum: 79 } as const;
export const infographicProperties = {
  infographic: {
    type: "object",
    additionalProperties: false,
    required: ["layout", "cards", "orderBlockIndex"],
    properties: {
      layout: { type: "string", enum: ["cards", "comparison", "steps"] },
      orderBlockIndex: { anyOf: [index, { type: "null" }] },
      cards: {
        type: "array",
        maxItems: 6,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "headlineBlockIndex", "bodyBlockIndexes"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 100 },
            headlineBlockIndex: index,
            bodyBlockIndexes: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              items: index,
            },
          },
        },
      },
    },
  },
} as const;
export function cardIndexes(card: InfographicCard) {
  return [card.headlineBlockIndex, ...card.bodyBlockIndexes];
}
export function validateInfographic(answer: Answer) {
  const data = answer.infographic;
  if (
    !data ||
    answer.slides ||
    answer.sections ||
    answer.items ||
    answer.nodes ||
    answer.columns ||
    answer.rows
  )
    throw Error("An infographic requires its own layout only.");
  if (answer.status === "insufficient_evidence") {
    if (data.cards.length || data.orderBlockIndex !== null)
      throw Error("Insufficient evidence cannot populate an infographic.");
    return;
  }
  if (
    !data.cards.length ||
    new Set(data.cards.map((c) => c.id)).size !== data.cards.length ||
    data.cards.some((c) => !c.id.trim())
  )
    throw Error("An infographic needs distinct nonempty card IDs.");
  if (data.layout === "comparison" && data.cards.length !== 2)
    throw Error("A comparison requires exactly two positions.");
  if (data.layout === "steps") {
    if (
      data.orderBlockIndex === null ||
      answer.blocks[data.orderBlockIndex]?.kind !== "fact"
    )
      throw Error(
        "Process steps require a separate cited factual order claim.",
      );
  } else if (data.orderBlockIndex !== null)
    throw Error("Only steps can contain an order claim.");
  const assigned = [
      ...data.cards.flatMap(cardIndexes),
      ...(data.orderBlockIndex === null ? [] : [data.orderBlockIndex]),
    ],
    supported = answer.blocks.flatMap((b, i) =>
      b.kind === "notice" ? [] : [i],
    );
  if (
    assigned.length !== supported.length ||
    new Set(assigned).size !== assigned.length ||
    assigned.some((i) => !supported.includes(i))
  )
    throw Error(
      "Every supported infographic block must be assigned exactly once.",
    );
  const bounded = (i: number, length: number) => {
    const b = answer.blocks[i];
    if (
      !b.text.trim() ||
      Array.from(b.text).length > length ||
      /[\x00-\x1f\x7f]/.test(b.text) ||
      b.citations.length > 4
    )
      throw Error("Infographic claims exceed concise text/reference limits.");
  };
  for (const card of data.cards) {
    bounded(card.headlineBlockIndex, 70);
    card.bodyBlockIndexes.forEach((i) => bounded(i, 160));
  }
  if (data.orderBlockIndex !== null) bounded(data.orderBlockIndex, 240);
}
export function infographicGroups<T>(content: {
  infographic?: InfographicData;
  blocks?: T[];
}) {
  const data = content.infographic;
  if (!data) return [];
  return [
    ...(data.orderBlockIndex === null
      ? []
      : [
          {
            title: "Source-supported order",
            blocks: [content.blocks![data.orderBlockIndex]],
          },
        ]),
    ...data.cards.map((card, i) => ({
      title:
        data.layout === "steps"
          ? `Step ${i + 1}`
          : data.layout === "comparison"
            ? `Position ${i + 1}`
            : `Card ${i + 1}`,
      blocks: cardIndexes(card).map((index) => content.blocks![index]),
    })),
  ];
}
