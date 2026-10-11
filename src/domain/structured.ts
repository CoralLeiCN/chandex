import type { Answer, Citation } from "./evidence.ts";

export type StructuredKind = "mind-map" | "data-table";
export interface MapNode {
  id: string;
  parentId: string | null;
  label: string;
  labelCitations: Citation[];
  relation: string;
  relationCitations: Citation[];
  blockIndexes: number[];
}
export interface TableColumn {
  id: string;
  label: string;
  labelCitations: Citation[];
}
export interface TableRow extends TableColumn {
  cells: { columnId: string; blockIndexes: number[] }[];
}
export const isStructuredKind = (kind: unknown): kind is StructuredKind =>
  kind === "mind-map" || kind === "data-table";
const id = { type: "string", minLength: 1, maxLength: 100 };
const label = { type: "string", minLength: 1, maxLength: 120 };
const indexes = {
  type: "array",
  maxItems: 8,
  items: { type: "integer", minimum: 0, maximum: 79 },
};
export function structuredProperties(kind: StructuredKind, citations: object) {
  if (kind === "mind-map")
    return {
      nodes: {
        type: "array",
        maxItems: 40,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "parentId",
            "label",
            "labelCitations",
            "relation",
            "relationCitations",
            "blockIndexes",
          ],
          properties: {
            id,
            parentId: { anyOf: [id, { type: "null" }] },
            label,
            labelCitations: citations,
            relation: { type: "string", maxLength: 120 },
            relationCitations: citations,
            blockIndexes: indexes,
          },
        },
      },
    };
  return {
    columns: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "labelCitations"],
        properties: { id, label, labelCitations: citations },
      },
    },
    rows: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "labelCitations", "cells"],
        properties: {
          id,
          label,
          labelCitations: citations,
          cells: {
            type: "array",
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["columnId", "blockIndexes"],
              properties: { columnId: id, blockIndexes: indexes },
            },
          },
        },
      },
    },
  };
}
export function structuredCitations(content: Partial<Answer>): Citation[] {
  return [
    ...(content.nodes ?? []).flatMap((node) => [
      ...node.labelCitations,
      ...node.relationCitations,
    ]),
    ...(content.columns ?? []).flatMap((col) => col.labelCitations),
    ...(content.rows ?? []).flatMap((row) => row.labelCitations),
  ];
}
export function orderedMapNodes(nodes: MapNode[]): MapNode[] {
  const visit = (node: MapNode): MapNode[] => [
    node,
    ...nodes.filter((child) => child.parentId === node.id).flatMap(visit),
  ];
  return nodes[0] ? visit(nodes[0]) : [];
}
export function validateStructured(answer: Answer) {
  if (!isStructuredKind(answer.kind) || answer.sections || answer.items)
    throw new Error(
      "Structured outputs cannot contain document sections or study items.",
    );
  const supported = answer.blocks.flatMap((b, i) =>
    b.kind === "notice" ? [] : [i],
  );
  let assigned: number[] = [];
  const distinctLabels = (values: TableColumn[]) => {
    if (
      values.some((v) => !v.id.trim() || !v.label.trim()) ||
      new Set(values.map((v) => v.id)).size !== values.length
    )
      throw new Error(
        "Structured IDs and labels must be nonempty with distinct IDs.",
      );
  };
  if (answer.kind === "mind-map") {
    if (!answer.nodes || answer.columns || answer.rows)
      throw new Error("A mind map requires nodes only.");
    distinctLabels(answer.nodes);
    if (answer.status === "insufficient_evidence") {
      if (answer.nodes.length)
        throw new Error("Insufficient evidence cannot populate a mind map.");
    } else {
      if (
        !answer.nodes.length ||
        answer.nodes[0].parentId !== null ||
        answer.nodes.filter((n) => n.parentId === null).length !== 1
      )
        throw new Error(
          "A mind map requires exactly one root, first in traversal order.",
        );
      const depths = new Map<string, number>();
      for (const node of answer.nodes) {
        if (node.parentId === null) {
          if (node.relation || node.relationCitations.length)
            throw new Error("The root cannot assert a parent relationship.");
          depths.set(node.id, 1);
        } else {
          const parentDepth = depths.get(node.parentId);
          if (!parentDepth || node.id === node.parentId)
            throw new Error(
              "Mind map parents must precede their children; cycles and orphan nodes are forbidden.",
            );
          if (parentDepth >= 6)
            throw new Error("Mind maps are limited to six levels.");
          if (!node.relation.trim() || !node.relationCitations.length)
            throw new Error(
              "Every map relationship requires named, cited evidence.",
            );
          depths.set(node.id, parentDepth + 1);
        }
      }
    }
    assigned = answer.nodes.flatMap((node) => node.blockIndexes);
  } else {
    if (!answer.columns || !answer.rows || answer.nodes)
      throw new Error("A data table requires columns and rows only.");
    distinctLabels(answer.columns);
    distinctLabels(answer.rows);
    if (answer.status === "insufficient_evidence") {
      if (answer.columns.length || answer.rows.length)
        throw new Error("Insufficient evidence cannot populate a data table.");
    } else if (!answer.columns.length || !answer.rows.length)
      throw new Error("A data table requires nonempty columns and rows.");
    for (const row of answer.rows) {
      if (
        row.cells.length !== answer.columns.length ||
        row.cells.some((cell, i) => cell.columnId !== answer.columns![i].id)
      )
        throw new Error(
          "Every table row requires exactly one cell for each column, in column order.",
        );
      assigned.push(...row.cells.flatMap((cell) => cell.blockIndexes));
    }
  }
  if (
    assigned.some(
      (i) => !answer.blocks[i] || answer.blocks[i].kind === "notice",
    ) ||
    assigned.length !== supported.length ||
    new Set(assigned).size !== assigned.length ||
    supported.some((i) => !assigned.includes(i))
  )
    throw new Error(
      "Every supported structured block must be assigned exactly once; empty cells represent missing evidence.",
    );
}
export function structuredText(content: Partial<Answer>): string {
  const lines = [content.title ?? ""];
  const text = (index: number) =>
    `${content.blocks![index].kind === "inference" ? "Inference: " : ""}${content.blocks![index].text}`;
  if (content.kind === "mind-map") {
    const byId = new Map((content.nodes ?? []).map((node) => [node.id, node]));
    for (const node of orderedMapNodes(content.nodes ?? []))
      lines.push(
        node.parentId
          ? `${byId.get(node.parentId)?.label} → ${node.relation} → ${node.label}`
          : node.label,
        ...node.blockIndexes.map(text),
      );
  } else
    for (const row of content.rows ?? []) {
      lines.push(row.label);
      row.cells.forEach((cell, i) =>
        lines.push(
          `${content.columns![i].label}: ${cell.blockIndexes.length ? cell.blockIndexes.map(text).join("; ") : "Not stated"}`,
        ),
      );
    }
  lines.push(
    ...(content.blocks ?? [])
      .filter((b) => b.kind === "notice")
      .map((b) => b.text),
    ...(content.coverageWarnings ?? []),
  );
  return lines.filter(Boolean).join("\n\n");
}
