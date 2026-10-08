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
  if (!Array.isArray(parsed.blocks)) return [];
  for (const [blockIndex, block] of parsed.blocks.slice(0, 80).entries()) {
    if (!Array.isArray(block.citations)) continue;
    for (const [citationIndex, cite] of block.citations
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
          blockIndex,
          citationIndex,
          passageId: p.id,
          start: points(p.text.slice(0, first)).length,
          end: points(p.text.slice(0, first + cite.quote.length)).length,
        });
    }
  }
  return hints;
}
