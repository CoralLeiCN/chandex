import type { Answer, Passage } from "./evidence.ts";
import { isStudyKind } from "./study.ts";
import { documentGroups } from "./artifacts.ts";
import { isStructuredKind, orderedMapNodes } from "./structured.ts";
import { isRichNote, richMarkdown, type RichNote } from "./notes.ts";
export type ExportContent = ({ text?: string } & Partial<Answer>) | RichNote;
export type ExportResolver = (id: string) =>
  | (Passage & {
      derivation?: {
        artifactId: string;
        revisionId: string | null;
        origin: string;
      } | null;
    })
  | null;
export function exportMarkdown(
  title: string,
  content: ExportContent,
  resolve: ExportResolver,
): string {
  const lines = [
    "# " +
      (isRichNote(content)
        ? title
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/([\\`*_[\]{}()#+.!|~-])/g, "\\$1")
        : title),
    "",
  ];
  let index = 0;
  const notes: string[] = [];
  const references = (citations: Answer["blocks"][number]["citations"]) =>
    citations
      .map((c) => {
        const label = ++index,
          p = resolve(c.passageId);
        notes.push(
          "[^" +
            label +
            "]: " +
            (p
              ? p.title +
                " — " +
                p.locator +
                "; revision " +
                p.revisionId +
                (p.origin
                  ? " (" + p.origin + "). Evidence: "
                  : " (local notebook source). Evidence: ") +
                c.quote
              : "Evidence unavailable."),
        );
        if (p?.derivation)
          notes[notes.length - 1] +=
            " Derived from note " +
            p.derivation.artifactId +
            "; note revision " +
            (p.derivation.revisionId ?? "not recorded") +
            "; " +
            p.derivation.origin +
            " origin. This is derived evidence, not independent corroboration.";
        return "[^" + label + "]";
      })
      .join("");
  if (isRichNote(content)) {
    lines.push(
      richMarkdown(content, (c) => references([c])),
      "",
    );
    // Evidence text/origin is untrusted in exported Markdown too.
    return [
      ...lines,
      ...notes.map((note) => {
        const separator = note.indexOf(": ");
        return (
          note.slice(0, separator + 2) +
          note
            .slice(separator + 2)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/([\\`*_[\]{}()#+.!|~-])/g, "\\$1")
            .replace(/\r?\n/g, " ")
        );
      }),
      "",
    ].join("\n");
  }
  if (content.text) lines.push(content.text, "");
  const cellText = (text: string) =>
    text
      .replace(/([\\|`*_[\]])/g, "\\$1")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\r?\n/g, "<br>");
  if (content.kind === "mind-map") {
    const depths = new Map<string, number>();
    const labels = new Map(
      (content.nodes ?? []).map((node) => [node.id, node.label]),
    );
    for (const node of orderedMapNodes(content.nodes ?? [])) {
      const depth = node.parentId ? (depths.get(node.parentId) ?? 0) + 1 : 0;
      depths.set(node.id, depth);
      const indent = "  ".repeat(depth);
      lines.push(
        indent + "- " + cellText(node.label) + references(node.labelCitations),
      );
      if (node.parentId)
        lines.push(
          indent +
            "  - Relationship to " +
            cellText(labels.get(node.parentId) ?? "") +
            ": " +
            cellText(node.relation) +
            references(node.relationCitations),
        );
      for (const index of node.blockIndexes) {
        const block = content.blocks![index];
        lines.push(
          indent +
            "  - " +
            (block.kind === "inference" ? "Inference: " : "") +
            cellText(block.text) +
            references(block.citations),
        );
      }
    }
    lines.push("");
  } else if (content.kind === "data-table" && content.columns?.length) {
    lines.push(
      "| Item | " +
        content.columns
          .map(
            (column) =>
              cellText(column.label) + references(column.labelCitations),
          )
          .join(" | ") +
        " |",
      "| --- | " + content.columns.map(() => "---").join(" | ") + " |",
    );
    for (const row of content.rows ?? [])
      lines.push(
        "| " +
          cellText(row.label) +
          references(row.labelCitations) +
          " | " +
          row.cells
            .map((cell) =>
              cell.blockIndexes.length
                ? cell.blockIndexes
                    .map((index) => {
                      const block = content.blocks![index];
                      return (
                        (block.kind === "inference" ? "Inference: " : "") +
                        cellText(block.text) +
                        references(block.citations)
                      );
                    })
                    .join("<br>")
                : "Not stated",
            )
            .join(" | ") +
          " |",
      );
    lines.push("");
  }
  const groups = isStudyKind(content.kind)
    ? [
        ...(content.items ?? []).map((item, i) => ({
          title: `${content.kind === "quiz" ? "Question" : "Card"} ${i + 1}`,
          blocks: [
            {
              text: item.question,
              kind: "fact",
              citations: item.questionCitations,
            },
            ...(content.kind === "quiz"
              ? (item.options ?? []).map((option) => ({
                  text: `Candidate answer${option.id === item.correctOptionId ? " (correct)" : " (distractor)"}: ${option.text}`,
                  kind: "notice",
                  citations: [],
                }))
              : []),
            ...item.answerBlockIndexes.map((index) => ({
              ...content.blocks![index],
              text: `${content.kind === "quiz" ? "Correct answer" : "Answer"}: ${content.blocks![index].text}`,
            })),
            ...(item.explanationBlockIndexes ?? []).map((index) => ({
              ...content.blocks![index],
              text: `Explanation: ${content.blocks![index].text}`,
            })),
          ],
        })),
        {
          title: "Evidence gaps",
          blocks: (content.blocks ?? []).filter(
            (block) => block.kind === "notice",
          ),
        },
      ]
    : isStructuredKind(content.kind)
      ? [
          {
            title: "Evidence gaps",
            blocks: (content.blocks ?? []).filter(
              (block) => block.kind === "notice",
            ),
          },
        ]
      : documentGroups(content);
  for (const group of groups) {
    if (group.title) lines.push("## " + group.title, "");
    if (
      group.title &&
      !group.blocks.length &&
      !isStudyKind(content.kind) &&
      !isStructuredKind(content.kind)
    )
      lines.push("No supported content was produced for this section.", "");
    for (const block of group.blocks) {
      lines.push(
        (block.kind === "inference" ? "Inference: " : "") +
          block.text +
          references(block.citations),
        "",
      );
    }
  }
  if (content.coverageWarnings?.length)
    lines.push(
      "## Coverage",
      "",
      ...content.coverageWarnings.map((w) => "- " + w),
      "",
    );
  if (content.coverage?.length) {
    lines.push(
      "## Evidence coverage",
      "",
      "Counts show passages returned by evidence tools in this run; they do not establish claim support.",
      "",
    );
    for (const source of content.coverage) {
      lines.push(
        "- " +
          source.title +
          "; revision " +
          source.revisionId +
          ": " +
          source.readPassages +
          " of " +
          source.totalPassages +
          " passages read.",
        ...source.omittedSections.map(
          (section) =>
            "  - " +
            section.locator +
            ": " +
            section.unreadPassages +
            " of " +
            section.totalPassages +
            " passages not read.",
        ),
      );
    }
    lines.push("");
  }
  return [...lines, ...notes, ""].join("\n");
}
