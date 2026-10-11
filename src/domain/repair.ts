import { points, type Passage } from "./evidence.ts";
// Only suggest locations of the exact quote in the same selected passage.
// The model must still return a corrected answer and pass the strict validator.
export function citationRepairHints(
  raw: string,
  passages: readonly Passage[],
): unknown[] {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const hints: unknown[] = [];
  const locations = [
    ...(Array.isArray(parsed.blocks) ? parsed.blocks.slice(0, 80) : []).map(
      (block: any, blockIndex: number) => ({
        path: { blockIndex },
        citations: block?.citations,
      }),
    ),
    ...(Array.isArray(parsed.items) ? parsed.items.slice(0, 20) : []).map(
      (item: any, itemIndex: number) => ({
        path: { itemIndex, field: "questionCitations" },
        citations: item?.questionCitations,
      }),
    ),
    ...(Array.isArray(parsed.nodes) ? parsed.nodes.slice(0, 40) : []).flatMap(
      (node: any, nodeIndex: number) =>
        ["labelCitations", "relationCitations"].map((field) => ({
          path: { nodeIndex, field },
          citations: node?.[field],
        })),
    ),
    ...["columns", "rows"].flatMap((collection) =>
      (Array.isArray(parsed[collection])
        ? parsed[collection].slice(0, 20)
        : []
      ).map((entry: any, entryIndex: number) => ({
        path: { collection, entryIndex, field: "labelCitations" },
        citations: entry?.labelCitations,
      })),
    ),
  ];
  for (const location of locations) {
    if (!Array.isArray(location.citations)) continue;
    for (const [citationIndex, cite] of location.citations
      .slice(0, 20)
      .entries()) {
      if (
        !cite ||
        typeof cite.quote !== "string" ||
        !cite.quote ||
        cite.quote.length > 8000
      )
        continue;
      const p = passages.find((p) => p.id === cite.passageId);
      if (!p) continue;
      const first = p.text.indexOf(cite.quote);
      if (first < 0) continue;
      const second = p.text.indexOf(cite.quote, first + 1);
      if (second < 0)
        hints.push({
          ...location.path,
          citationIndex,
          passageId: p.id,
          start: points(p.text.slice(0, first)).length,
          end: points(p.text.slice(0, first + cite.quote.length)).length,
        });
    }
  }
  return hints;
}
