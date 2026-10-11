import type { Answer, Citation, Passage } from "./evidence.ts";
import { documentGroups } from "./artifacts.ts";
import { isStudyKind } from "./study.ts";
import { orderedMapNodes } from "./structured.ts";

export interface NoteNode {
  type: string;
  text?: string;
  attrs?: Record<string, any>;
  marks?: { type: string; attrs?: Record<string, any> }[];
  content?: NoteNode[];
}
export interface RichNote {
  format: "rich-note";
  version: 1;
  doc: NoteNode;
}
export const authoredReferenceNotice =
  "User-authored note. Attached references have not been revalidated against the edited text.";
export const isRichNote = (value: any): value is RichNote =>
  value?.format === "rich-note" && value.version === 1;
const object = (v: any) =>
  v !== null && typeof v === "object" && !Array.isArray(v);
function keys(v: any, allowed: string[]) {
  if (!object(v) || Object.keys(v).some((key) => !allowed.includes(key)))
    throw new Error("Unsupported note structure.");
}
export function noteLink(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\u0000-\u0020\u007f]/u.test(value)
  )
    throw new Error("Use an explicit HTTP or HTTPS link.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid note link.");
  }
  if (
    !/^https?:$/.test(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  )
    throw new Error("Use an HTTP or HTTPS link without credentials.");
  return url.href;
}
export function noteCitations(value: any): Citation[] {
  if (isRichNote(value)) {
    const found: Citation[] = [],
      stack = [value.doc];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.type === "citation") found.push(node.attrs!.citation);
      stack.push(...(node.content ?? []).slice().reverse());
    }
    return found;
  }
  return [
    ...(value.blocks ?? []).flatMap((b: any) => b.citations ?? []),
    ...(value.items ?? []).flatMap((i: any) => i.questionCitations ?? []),
    ...(value.nodes ?? []).flatMap((n: any) => [
      ...n.labelCitations,
      ...n.relationCitations,
    ]),
    ...(value.columns ?? []).flatMap((c: any) => c.labelCitations),
    ...(value.rows ?? []).flatMap((r: any) => r.labelCitations),
  ];
}
/** Validate separately from the visual editor. No HTML or extension attributes are authority. */
export function richNote(
  value: unknown,
  resolve?: (id: string) => Passage | null,
  inherited: Citation[] = [],
): RichNote {
  keys(value, ["format", "version", "doc"]);
  if (!isRichNote(value)) throw new Error("Unsupported rich note version.");
  const old = new Set(
    inherited.map((c) =>
      JSON.stringify([c.passageId, c.quote, c.start, c.end]),
    ),
  );
  const seen = new WeakSet(),
    inline = ["text", "hardBreak", "citation"],
    blocks = [
      "paragraph",
      "heading",
      "bulletList",
      "orderedList",
      "blockquote",
      "codeBlock",
      "horizontalRule",
    ];
  let count = 0,
    characters = 0;
  function node(v: any, depth: number, parent = ""): NoteNode {
    if (++count > 5000 || depth > 12 || !object(v) || seen.has(v))
      throw new Error("Note node or nesting limit exceeded.");
    seen.add(v);
    keys(v, ["type", "text", "attrs", "marks", "content"]);
    const allowed =
      parent === "doc" || parent === "blockquote" || parent === "listItem"
        ? blocks
        : parent === "bulletList" || parent === "orderedList"
          ? ["listItem"]
          : parent === "paragraph" || parent === "heading"
            ? inline
            : parent === "codeBlock"
              ? ["text"]
              : parent === ""
                ? ["doc"]
                : [];
    if (!allowed.includes(v.type))
      throw new Error("Invalid note node location.");
    const result: NoteNode = { type: v.type };
    if (v.type === "text") {
      if (typeof v.text !== "string" || !v.text || v.text.includes("\0"))
        throw new Error("Invalid note text.");
      characters += Array.from(v.text).length;
      result.text = v.text;
    } else if (v.text !== undefined) throw new Error("Unexpected node text.");
    const attrs = v.attrs ?? {};
    if (v.type === "citation") {
      keys(attrs, ["citation"]);
      keys(attrs.citation, ["passageId", "quote", "start", "end"]);
      const c = attrs.citation;
      if (
        typeof c.passageId !== "string" ||
        !c.passageId ||
        c.passageId.length > 100 ||
        typeof c.quote !== "string" ||
        !c.quote ||
        c.quote.includes("\0") ||
        Array.from(c.quote).length > 8000 ||
        !Number.isSafeInteger(c.start) ||
        !Number.isSafeInteger(c.end) ||
        c.start < 0 ||
        c.end <= c.start
      )
        throw new Error("Invalid attached reference.");
      characters += Array.from(c.quote).length;
      if (resolve) {
        const p = resolve(c.passageId);
        if (
          p
            ? Array.from(p.text).slice(c.start, c.end).join("") !== c.quote ||
              c.end > Array.from(p.text).length
            : !old.has(JSON.stringify([c.passageId, c.quote, c.start, c.end]))
        )
          throw new Error(
            "Attached reference does not match notebook evidence.",
          );
      }
      result.attrs = {
        citation: {
          passageId: c.passageId,
          quote: c.quote,
          start: c.start,
          end: c.end,
        },
      };
    } else if (v.type === "heading") {
      keys(attrs, ["level"]);
      if (![1, 2, 3].includes(attrs.level))
        throw new Error("Invalid heading level.");
      result.attrs = { level: attrs.level };
    } else if (v.type === "orderedList") {
      keys(attrs, ["start", "type"]);
      const start = attrs.start ?? 1;
      if (
        !Number.isSafeInteger(start) ||
        start < 1 ||
        start > 10000 ||
        attrs.type != null
      )
        throw new Error("Invalid ordered list.");
      result.attrs = { start };
    } else if (v.type === "codeBlock") {
      keys(attrs, ["language"]);
      if (attrs.language != null)
        throw new Error("Code execution/language plugins are unsupported.");
    } else keys(attrs, []);
    if (v.marks !== undefined) {
      if (
        !["text", "hardBreak"].includes(v.type) ||
        parent === "codeBlock" ||
        !Array.isArray(v.marks) ||
        v.marks.length > 6
      )
        throw new Error("Invalid note formatting.");
      const types = new Set<string>();
      result.marks = v.marks.map((m: any) => {
        keys(m, ["type", "attrs"]);
        if (
          !["bold", "italic", "underline", "strike", "code", "link"].includes(
            m.type,
          ) ||
          types.has(m.type)
        )
          throw new Error("Unsupported note formatting.");
        types.add(m.type);
        if (m.type === "link") {
          keys(m.attrs, ["href", "target", "rel", "class", "title"]);
          if (
            m.attrs.class != null ||
            m.attrs.title != null ||
            (m.attrs.target != null && m.attrs.target !== "_blank") ||
            (m.attrs.rel != null &&
              m.attrs.rel !== "noopener noreferrer nofollow")
          )
            throw new Error("Unsupported link attributes.");
          return {
            type: "link",
            attrs: {
              href: noteLink(m.attrs.href),
              target: "_blank",
              rel: "noopener noreferrer nofollow",
              class: null,
            },
          };
        }
        keys(m.attrs ?? {}, []);
        return { type: m.type };
      });
      if (types.has("code") && types.size > 1)
        throw new Error("Inline code cannot carry other formatting.");
      const order = ["link", "bold", "code", "italic", "strike", "underline"];
      result.marks!.sort(
        (a, b) => order.indexOf(a.type) - order.indexOf(b.type),
      );
    }
    if (v.content !== undefined) {
      if (
        !Array.isArray(v.content) ||
        inline.includes(v.type) ||
        v.type === "horizontalRule"
      )
        throw new Error("Unexpected note children.");
      result.content = v.content.map((child: any) =>
        node(child, depth + 1, v.type),
      );
    }
    if (
      ["doc", "bulletList", "orderedList", "blockquote", "listItem"].includes(
        v.type,
      ) &&
      !result.content?.length
    )
      throw new Error("Note container is empty.");
    if (v.type === "listItem" && result.content?.[0]?.type !== "paragraph")
      throw new Error("List items must start with a paragraph.");
    if (characters > 100000) throw new Error("Note text limit exceeded.");
    return result;
  }
  const result: RichNote = {
    format: "rich-note",
    version: 1,
    doc: node(value.doc, 0),
  };
  if (new TextEncoder().encode(JSON.stringify(result)).length > 1024 * 1024)
    throw new Error("Note JSON limit exceeded.");
  return result;
}
const textNode = (text: string): NoteNode[] =>
  text ? [{ type: "text", text }] : [];
const paragraph = (text: string, citations: Citation[] = []): NoteNode => ({
  type: "paragraph",
  content: [
    ...textNode(text),
    ...citations.map((citation) => ({ type: "citation", attrs: { citation } })),
  ],
});
/** Convert saved output without Markdown parsing, dropping neither attached spans nor qualifications. */
export function editableNote(value: any): RichNote {
  if (isRichNote(value)) return richNote(value);
  const nodes: NoteNode[] = [];
  const heading = (title: string) =>
    nodes.push({
      type: "heading",
      attrs: { level: 2 },
      content: textNode(title),
    });
  const block = (b: any) =>
    nodes.push(
      paragraph(
        (b.kind === "inference" ? "Inference: " : "") + b.text,
        b.citations ?? [],
      ),
    );
  if (value.text !== undefined)
    nodes.push(
      ...String(value.text)
        .split(/\n\n/)
        .map((t) => paragraph(t)),
    );
  else {
    if (value.title) heading(value.title);
    if (isStudyKind(value.kind)) {
      for (const [i, item] of (value.items ?? []).entries()) {
        heading(`${value.kind === "quiz" ? "Question" : "Card"} ${i + 1}`);
        nodes.push(paragraph(item.question, item.questionCitations));
        for (const option of item.options ?? [])
          nodes.push(
            paragraph(
              `Candidate answer (${option.id === item.correctOptionId ? "correct" : "distractor"}): ${option.text}`,
            ),
          );
        heading("Answer");
        for (const i of item.answerBlockIndexes) block(value.blocks[i]);
        if (item.explanationBlockIndexes?.length) {
          heading("Explanation");
          for (const i of item.explanationBlockIndexes) block(value.blocks[i]);
        }
      }
      for (const b of value.blocks ?? []) if (b.kind === "notice") block(b);
    } else if (value.kind === "mind-map") {
      const labels = new Map<string, string>(
        (value.nodes ?? []).map((n: any) => [n.id, n.label]),
      );
      for (const n of orderedMapNodes(value.nodes ?? [])) {
        nodes.push(paragraph(n.label, n.labelCitations));
        if (n.parentId)
          nodes.push(
            paragraph(
              `Relationship to ${labels.get(n.parentId)}: ${n.relation}`,
              n.relationCitations,
            ),
          );
        for (const i of n.blockIndexes) block(value.blocks[i]);
      }
      for (const b of value.blocks ?? []) if (b.kind === "notice") block(b);
    } else if (value.kind === "data-table") {
      for (const column of value.columns ?? [])
        nodes.push(paragraph(`Column: ${column.label}`, column.labelCitations));
      for (const row of value.rows ?? []) {
        nodes.push(paragraph(`Row: ${row.label}`, row.labelCitations));
        for (const cell of row.cells) {
          heading(
            value.columns.find((c: any) => c.id === cell.columnId)?.label ??
              "Value",
          );
          if (!cell.blockIndexes.length) nodes.push(paragraph("Not stated"));
          for (const i of cell.blockIndexes) block(value.blocks[i]);
        }
      }
      for (const b of value.blocks ?? []) if (b.kind === "notice") block(b);
    } else
      for (const group of documentGroups<Answer["blocks"][number]>(value)) {
        if (group.title) heading(group.title);
        if (group.title && !group.blocks.length)
          nodes.push(
            paragraph("No supported content was produced for this section."),
          );
        group.blocks.forEach(block);
      }
    if (value.coverageWarnings?.length) {
      heading("Coverage notes");
      value.coverageWarnings.forEach((w: string) => nodes.push(paragraph(w)));
    }
    if (value.coverage?.length) {
      heading("Evidence coverage");
      nodes.push(
        paragraph(
          "Counts show returned passages; they do not establish claim support.",
        ),
      );
      for (const s of value.coverage) {
        nodes.push(
          paragraph(
            `${s.title}; revision ${s.revisionId}: ${s.readPassages} of ${s.totalPassages} passages read.`,
          ),
        );
        for (const o of s.omittedSections)
          nodes.push(
            paragraph(
              `${o.locator}: ${o.unreadPassages} of ${o.totalPassages} passages not read.`,
            ),
          );
      }
    }
  }
  return richNote({
    format: "rich-note",
    version: 1,
    doc: { type: "doc", content: nodes.length ? nodes : [paragraph("")] },
  });
}
export function richText(note: RichNote): string {
  function visit(n: NoteNode): string {
    if (n.type === "text") return n.text!;
    if (n.type === "citation")
      return ` [Attached reference: ${n.attrs!.citation.quote}]`;
    if (n.type === "hardBreak") return "\n";
    if (n.type === "horizontalRule") return "---";
    const separator = ["paragraph", "heading", "codeBlock"].includes(n.type)
      ? ""
      : "\n\n";
    return (n.content ?? []).map(visit).join(separator);
  }
  return authoredReferenceNotice + "\n\n" + visit(note.doc);
}
const escapeMarkdown = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]{}()#+.!|~-])/g, "\\$1");
export function richMarkdown(
  note: RichNote,
  cite: (c: Citation) => string,
): string {
  function visit(n: NoteNode): string {
    if (n.type === "citation") return cite(n.attrs!.citation);
    if (n.type === "hardBreak") return "  \n";
    if (n.type === "horizontalRule") return "---";
    if (n.type === "text") {
      let text = escapeMarkdown(n.text!);
      for (const m of n.marks ?? []) {
        if (m.type === "code") {
          const fence = "`".repeat(
            Math.max(0, ...(n.text!.match(/`+/g) ?? []).map((x) => x.length)) +
              1,
          );
          text = `${fence} ${n.text} ${fence}`;
        } else if (m.type === "link")
          text = `[${text}](<${noteLink(m.attrs!.href).replace(/</g, "%3C").replace(/>/g, "%3E")}>)`;
        else if (m.type === "underline") text = `<u>${text}</u>`;
        else {
          const marker =
            m.type === "bold" ? "**" : m.type === "italic" ? "*" : "~~";
          text = marker + text + marker;
        }
      }
      return text;
    }
    if (n.type === "codeBlock") {
      const raw = (n.content ?? []).map((c) => c.text!).join("");
      const fence = "`".repeat(
        Math.max(2, ...(raw.match(/`+/g) ?? []).map((x) => x.length)) + 1,
      );
      return `${fence}\n${raw}\n${fence}`;
    }
    if (n.type === "bulletList" || n.type === "orderedList")
      return (n.content ?? [])
        .map((item, i) => {
          const marker =
            n.type === "bulletList" ? "- " : `${(n.attrs?.start ?? 1) + i}. `;
          return (
            marker +
            visit(item).replace(/\n/g, "\n" + " ".repeat(marker.length))
          );
        })
        .join("\n");
    const text = (n.content ?? [])
      .map(visit)
      .join(["paragraph", "heading"].includes(n.type) ? "" : "\n\n");
    if (n.type === "heading") return "#".repeat(n.attrs!.level) + " " + text;
    if (n.type === "blockquote")
      return text
        .split("\n")
        .map((line) => "> " + line)
        .join("\n");
    return text;
  }
  return authoredReferenceNotice + "\n\n" + visit(note.doc);
}
