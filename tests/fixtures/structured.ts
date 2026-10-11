import type { Answer, Passage } from "../../src/domain/evidence.ts";
import type { StructuredKind } from "../../src/domain/structured.ts";
export function structuredAnswer(p: Passage, kind: StructuredKind): Answer {
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
    title: "Selected proposal",
    blocks: [{ text: p.text, kind: "fact", citations }],
    coverageWarnings: ["Budget is not stated in this source."],
    ...(kind === "mind-map"
      ? {
          nodes: [
            {
              id: "root",
              parentId: null,
              label: "Evidence",
              labelCitations: [],
              relation: "",
              relationCitations: [],
              blockIndexes: [],
            },
            {
              id: "database",
              parentId: "root",
              label: "SQLite 😀",
              labelCitations: citations,
              relation: "states",
              relationCitations: citations,
              blockIndexes: [0],
            },
          ],
        }
      : {
          columns: [
            { id: "database", label: "Database", labelCitations: citations },
            { id: "budget", label: "Budget", labelCitations: [] },
          ],
          rows: [
            {
              id: "proposal",
              label: "Proposal",
              labelCitations: citations,
              cells: [
                { columnId: "database", blockIndexes: [0] },
                { columnId: "budget", blockIndexes: [] },
              ],
            },
          ],
        }),
  };
}
