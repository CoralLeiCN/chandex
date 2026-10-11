import { createHash } from "node:crypto";
import type { Answer, Citation } from "./evidence.ts";
import type { ExportContent, ExportResolver } from "./export.ts";
import { documentGroups } from "./artifacts.ts";
import { orderedMapNodes } from "./structured.ts";
import { isStudyKind } from "./study.ts";
import {
  authoredReferenceNotice,
  isRichNote,
  noteLink,
  richNote,
  type NoteNode,
} from "./notes.ts";

export interface ExportRevision {
  revisionId: string;
  created: string;
  authored: boolean;
  historical: boolean;
  titleRecorded?: boolean;
  available?: boolean;
}
const escape = (value: string | number) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
const style = `
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#fff;color:#202c26;font:17px/1.65 system-ui,-apple-system,sans-serif;overflow-wrap:anywhere}main{max-width:76ch;margin:0 auto;padding:3rem 1.5rem}h1,h2,h3{line-height:1.25;color:#193e30}h1{font-size:2.2rem;margin:0 0 1rem}h2{font-size:1.5rem;margin:2rem 0 1rem}h3{font-size:1.2rem}p{white-space:pre-wrap}a{color:#235c47;text-underline-offset:.15em}a:focus-visible{outline:3px solid #947122;outline-offset:3px}.metadata,.qualification,footer{font-size:.85rem;color:#526057}.qualification{padding:.8rem 1rem;background:#f5f6ef;border-left:3px solid #8b9870}.document{margin-top:2rem}blockquote{margin:1rem 0;padding:0 1rem;border-left:3px solid #91a393}pre{padding:1rem;background:#f4f5f0;white-space:pre-wrap;overflow-wrap:anywhere}code{font-family:ui-monospace,monospace;font-size:.9em}hr{border:0;border-top:1px solid #ccd4ca;margin:2rem 0}li{margin:.5rem 0}.reference{font-size:.8em;white-space:nowrap}.footnotes{font-size:.85rem}.footnotes li{margin:1.2rem 0}.evidence-quote{white-space:pre-wrap;margin:.4rem 0}.table-wrap{max-width:100%;overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{padding:.65rem;border:1px solid #ccd4ca;text-align:left;vertical-align:top;min-width:8rem}th{background:#f4f5f0}td p{margin:0 0 .5rem}.missing{color:#626b64;font-style:italic}.map-relation{font-size:.9em}.block-notice{border-left:3px solid #ac9b66;padding-left:.8rem}footer{margin-top:2rem;padding-top:1rem;border-top:1px solid #ccd4ca}
.slide{border-left:4px solid #527347;padding:1rem;margin:1.5rem 0;background:#fbfcf7}.slide aside{font-size:.9em;border-top:1px solid #ccd4ca}
@media(max-width:480px){main{padding:1.5rem 1rem}h1{font-size:1.8rem}}
@media print{body{font:11pt/1.5 Georgia,serif;color:#000}main{max-width:none;padding:0}h1,h2,h3{color:#000;break-after:avoid}pre,blockquote,tr{break-inside:avoid}.table-wrap{overflow:visible}table{table-layout:fixed}th,td{min-width:0}a{color:#000}.qualification,th,pre{background:transparent}.slide{break-before:page;background:transparent}@page{margin:18mm}}
`;

/** A detached, inert document over stored structures; never an HTML parser. */
export function exportHtml(
  title: string,
  content: ExportContent,
  resolve: ExportResolver,
  revision: ExportRevision,
): string {
  if (revision.available === false && !revision.authored)
    throw Error("This generated revision is unavailable after evidence purge.");
  const footnotes: string[] = [];
  const link = (url: string, label: string) => {
    try {
      return `<a href="${escape(noteLink(url))}" rel="noopener noreferrer nofollow">${escape(label)}</a>`;
    } catch {
      return escape(label);
    }
  };
  const references = (citations: Citation[] = []) =>
    citations
      .map((citation) => {
        const number = footnotes.length + 1,
          passage = resolve(citation.passageId),
          available =
            passage?.id === citation.passageId &&
            Number.isSafeInteger(citation.start) &&
            Number.isSafeInteger(citation.end) &&
            citation.start >= 0 &&
            citation.end > citation.start &&
            citation.end <= Array.from(passage.text).length &&
            Array.from(passage.text)
              .slice(citation.start, citation.end)
              .join("") === citation.quote;
        let detail = "Evidence unavailable.";
        if (available && passage) {
          detail = `<strong>${escape(passage.title)}</strong> — ${escape(passage.locator)}; source revision ${escape(passage.revisionId)}; Unicode span ${citation.start}–${citation.end}.`;
          detail += passage.origin
            ? `<br>Origin: ${link(passage.origin, passage.origin)}`
            : "<br>Local notebook source.";
          detail += `<blockquote class="evidence-quote">${escape(citation.quote)}</blockquote>`;
          if (passage.derivation)
            detail += `Derived from note ${escape(passage.derivation.artifactId)}; note revision ${escape(passage.derivation.revisionId ?? "not recorded")}; ${escape(passage.derivation.origin)} origin. This is derived evidence, not independent corroboration.`;
        }
        footnotes.push(
          `<li id="reference-${number}">${detail} <a href="#citation-${number}" aria-label="Return to reference ${number}">↩</a></li>`,
        );
        return `<sup class="reference" id="citation-${number}"><a href="#reference-${number}" aria-label="Read reference ${number}${available ? "" : ": evidence unavailable"}">[${number}${available ? "" : " · unavailable"}]</a></sup>`;
      })
      .join("");
  const block = (value: Answer["blocks"][number], prefix = "") =>
    `<p${value.kind === "notice" ? ' class="block-notice"' : ""}>${value.kind === "inference" ? "<strong>Inference:</strong> " : value.kind === "notice" ? "<strong>Evidence limitation:</strong> " : ""}${escape(prefix + value.text)}${references(value.citations)}</p>`;
  function rich(node: NoteNode): string {
    if (node.type === "text") {
      let text = escape(node.text!);
      for (const mark of node.marks ?? []) {
        if (mark.type === "link")
          text = `<a href="${escape(noteLink(mark.attrs!.href))}" rel="noopener noreferrer nofollow">${text}</a>`;
        else {
          const tag = {
            bold: "strong",
            italic: "em",
            underline: "u",
            strike: "s",
            code: "code",
          }[mark.type];
          if (!tag) throw Error("Unsupported note formatting.");
          text = `<${tag}>${text}</${tag}>`;
        }
      }
      return text;
    }
    if (node.type === "citation") return references([node.attrs!.citation]);
    const children = (node.content ?? []).map(rich).join("");
    if (node.type === "doc") return children;
    if (node.type === "hardBreak") return "<br>";
    if (node.type === "horizontalRule") return "<hr>";
    if (node.type === "codeBlock") return `<pre><code>${children}</code></pre>`;
    if (node.type === "orderedList")
      return `<ol start="${node.attrs?.start ?? 1}">${children}</ol>`;
    const tag =
      node.type === "heading"
        ? `h${node.attrs!.level}`
        : {
            paragraph: "p",
            bulletList: "ul",
            listItem: "li",
            blockquote: "blockquote",
          }[node.type];
    if (!tag) throw Error("Unsupported note structure.");
    return `<${tag}>${children}</${tag}>`;
  }
  let body = "";
  if (isRichNote(content)) body = rich(richNote(content).doc);
  else {
    const blocks = content.blocks ?? [];
    if (content.status === "insufficient_evidence")
      body +=
        '<p class="qualification">The selected evidence was insufficient for this material.</p>';
    if (content.text !== undefined) body += `<p>${escape(content.text)}</p>`;
    if (content.kind === "mind-map") {
      const nodes = orderedMapNodes(content.nodes ?? []),
        labels = new Map(nodes.map((node) => [node.id, node.label]));
      function branch(parentId: string | null): string {
        return `<ul>${nodes
          .filter((node) => node.parentId === parentId)
          .map(
            (node) =>
              `<li><strong>${escape(node.label)}</strong>${references(node.labelCitations)}${node.parentId ? `<p class="map-relation">Relationship to ${escape(labels.get(node.parentId) ?? "")}: ${escape(node.relation)}${references(node.relationCitations)}</p>` : ""}${node.blockIndexes.map((index) => block(blocks[index])).join("")}${nodes.some((child) => child.parentId === node.id) ? branch(node.id) : ""}</li>`,
          )
          .join("")}</ul>`;
      }
      if (nodes.length) body += branch(null);
    } else if (content.kind === "data-table") {
      if (content.columns?.length)
        body += `<div class="table-wrap" role="region" aria-label="Data table" tabindex="0"><table><thead><tr><th scope="col">Item</th>${content.columns.map((column) => `<th scope="col">${escape(column.label)}${references(column.labelCitations)}</th>`).join("")}</tr></thead><tbody>${(content.rows ?? []).map((row) => `<tr><th scope="row">${escape(row.label)}${references(row.labelCitations)}</th>${row.cells.map((cell) => `<td>${cell.blockIndexes.length ? cell.blockIndexes.map((index) => block(content.blocks![index])).join("") : '<span class="missing">Not stated</span>'}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    } else if (isStudyKind(content.kind)) {
      body += (content.items ?? [])
        .map(
          (item, index) =>
            `<section><h2>${content.kind === "quiz" ? "Question" : "Card"} ${index + 1}</h2><p>${escape(item.question)}${references(item.questionCitations)}</p>${content.kind === "quiz" ? `<ul>${(item.options ?? []).map((option) => `<li><strong>Candidate answer (${option.id === item.correctOptionId ? "correct" : "distractor"}):</strong> ${escape(option.text)}</li>`).join("")}</ul>` : ""}${item.answerBlockIndexes.map((index) => block(content.blocks![index], content.kind === "quiz" ? "Correct answer: " : "Answer: ")).join("")}${(item.explanationBlockIndexes ?? []).map((index) => block(content.blocks![index], "Explanation: ")).join("")}</section>`,
        )
        .join("");
    } else if (content.kind === "slides") {
      body += (content.slides ?? [])
        .map(
          (slide, i) =>
            `<section class="slide"><p>Slide ${i + 1}</p><h2>${content.blocks![slide.headlineBlockIndex].kind === "inference" ? "Inference: " : ""}${escape(content.blocks![slide.headlineBlockIndex].text)}${references(content.blocks![slide.headlineBlockIndex].citations)}</h2><ul>${slide.bodyBlockIndexes.map((index) => `<li>${block(content.blocks![index])}</li>`).join("")}</ul>${slide.noteBlockIndexes.length ? `<aside aria-label="Speaker notes"><h3>Speaker notes</h3>${slide.noteBlockIndexes.map((index) => block(content.blocks![index])).join("")}</aside>` : ""}</section>`,
        )
        .join("");
    } else {
      for (const group of documentGroups(content)) {
        if (group.title) body += `<h2>${escape(group.title)}</h2>`;
        if (group.title && !group.blocks.length)
          body += "<p>No supported content was produced for this section.</p>";
        body += group.blocks.map((value) => block(value)).join("");
      }
    }
    if (
      isStudyKind(content.kind) ||
      content.kind === "mind-map" ||
      content.kind === "data-table" ||
      content.kind === "slides"
    ) {
      const notices = (content.blocks ?? []).filter(
        (value) => value.kind === "notice",
      );
      if (notices.length)
        body +=
          "<h2>Evidence gaps</h2>" +
          notices.map((value) => block(value)).join("");
    }
    if (content.coverageWarnings?.length)
      body += `<h2>Coverage</h2><ul>${content.coverageWarnings.map((text) => `<li>${escape(text)}</li>`).join("")}</ul>`;
    if (content.coverage?.length)
      body += `<h2>Evidence coverage</h2><p>Counts show passages returned by evidence tools in this run; they do not establish claim support.</p><ul>${content.coverage.map((source) => `<li>${escape(source.title)}; revision ${escape(source.revisionId)}: ${source.readPassages} of ${source.totalPassages} passages read.${source.omittedSections.length ? `<ul>${source.omittedSections.map((section) => `<li>${escape(section.locator)}: ${section.unreadPassages} of ${section.totalPassages} passages not read.</li>`).join("")}</ul>` : ""}</li>`).join("")}</ul>`;
  }
  const policy = `default-src 'none'; style-src 'sha256-${createHash("sha256").update(style).digest("base64")}'; base-uri 'none'; form-action 'none'`,
    qualification =
      revision.authored || isRichNote(content)
        ? authoredReferenceNotice
        : "Generated material. Inspect the supporting references and evidence limitations before reuse.",
    html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${escape(policy)}"><title>${escape(title)}</title><style>${style}</style></head><body><main><header><h1>${escape(title)}</h1><p class="metadata">${revision.historical ? "Historical revision" : "Saved revision"} · ${escape(revision.created)}<br>Revision ${escape(revision.revisionId)}${revision.titleRecorded === false ? "<br>Historical title was not recorded; the current note title is shown." : ""}</p><p class="qualification">${qualification}</p></header><article class="document" aria-label="Note content">${body}</article>${footnotes.length ? `<section class="footnotes" aria-label="References"><h2>References</h2><ol>${footnotes.join("")}</ol></section>` : ""}<footer>Exported from Codeboom. Downloaded files are separate copies; later edits or purges do not update them.</footer></main></body></html>\n`;
  if (Buffer.byteLength(html, "utf8") > 5 * 1024 * 1024)
    throw Error("Formatted export exceeds five MiB. Export a smaller note.");
  return html;
}
