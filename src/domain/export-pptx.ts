import pptxgen from "pptxgenjs";
import { createCanvas } from "@napi-rs/canvas";
import { validateAnswer, type Answer } from "./evidence.ts";
import { slideIndexes } from "./slides.ts";
import type { ExportResolver } from "./export.ts";
import type { ExportRevision } from "./export-html.ts";

export const PPTX_LIMIT = 8 * 1024 * 1024;
const context = createCanvas(1, 1).getContext("2d");
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
// Explicit line breaks from measured Arial text avoid exporter fit/shrink
// silently changing readability. Original claim text is also kept in notes.
export function slideLines(
  text: string,
  points: number,
  width = 11.8,
): string[] {
  context.font = `${(points * 96) / 72}px Arial`;
  const lines: string[] = [];
  let line = "";
  const fits = (value: string) =>
    context.measureText(value).width <= width * 96;
  for (const token of text.match(/\s+|[^\s]+/gu) ?? []) {
    if (/^\s+$/u.test(token)) {
      if (line) line += token;
      continue;
    }
    if (line && !fits(line + token)) {
      lines.push(line.trimEnd());
      line = "";
    }
    if (fits(token)) {
      line += token;
      continue;
    }
    // A long unbroken word may wrap; never split combining marks or an emoji.
    for (const { segment } of graphemes.segment(token)) {
      if (line && !fits(line + segment)) {
        lines.push(line);
        line = "";
      }
      line += segment;
    }
  }
  if (line) lines.push(line.trimEnd());
  return lines;
}
export async function exportPptx(
  title: string,
  content: Answer,
  resolve: ExportResolver,
  revision: ExportRevision,
): Promise<Buffer> {
  if (
    revision.authored ||
    revision.available === false ||
    content.kind !== "slides" ||
    content.status !== "answered"
  )
    throw Error(
      "PowerPoint export requires an available generated slide revision.",
    );
  if (Buffer.byteLength(JSON.stringify(content)) > 1024 * 1024)
    throw Error("Slide export input exceeds one MiB.");
  const evidence = new Map<string, NonNullable<ReturnType<ExportResolver>>>();
  for (const block of content.blocks)
    for (const citation of block.citations) {
      const passage =
        evidence.get(citation.passageId) ?? resolve(citation.passageId);
      if (!passage)
        throw Error("Slide evidence is unavailable. Export was not created.");
      evidence.set(passage.id, passage);
    }
  validateAnswer(content, [...evidence.values()], "slides");
  const deck = new pptxgen();
  deck.layout = "LAYOUT_WIDE";
  deck.author = "Codeboom";
  deck.subject = "Cited notebook slides";
  deck.title = title;
  deck.company = "Codeboom";
  deck.theme = { headFontFace: "Arial", bodyFontFace: "Arial" };
  const common = {
    fontFace: "Arial",
    color: "29372D",
    margin: 0,
    breakLine: false,
    valign: "top" as const,
    fit: "none" as const,
  };
  const provenance = `Codeboom generated slide deck\nTitle: ${title}\nArtifact revision: ${revision.revisionId}\nSaved: ${revision.created}\n${revision.historical ? "Historical saved revision" : "Current saved revision"}\nGenerated from selected notebook snapshots; citations locate evidence, not independent semantic certification.\nDownloaded copies are separate; later edits or purges do not update them.`;
  for (const [position, item] of content.slides!.entries()) {
    const slide = deck.addSlide();
    slide.background = { color: "FBFCF7" };
    slide.addShape(deck.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 0.17,
      h: 7.5,
      fill: { color: "527347" },
      line: { color: "527347", transparency: 100 },
    });
    let reference = 0;
    const notes = [
      provenance,
      `Slide ${position + 1}/${content.slides!.length}`,
    ];
    const visible = new Map<number, string>();
    for (const index of slideIndexes(item)) {
      const block = content.blocks[index];
      const numbers: number[] = [];
      notes.push(
        `\n${index === item.headlineBlockIndex ? "Headline" : item.noteBlockIndexes.includes(index) ? "Speaker note" : "Body"}${block.kind === "inference" ? " (inference)" : ""}: ${block.text}`,
      );
      for (const citation of block.citations) {
        const number = ++reference;
        numbers.push(number);
        const p = evidence.get(citation.passageId)!;
        notes.push(
          `[${number}] ${p.title} — ${p.locator}; source revision ${p.revisionId}; Unicode span ${citation.start}–${citation.end}.\nEvidence: ${citation.quote}\nOrigin: ${p.origin ?? "Local notebook source"}`,
        );
        if (p.derivation)
          notes.push(
            `Derived from note ${p.derivation.artifactId}; note revision ${p.derivation.revisionId ?? "not recorded"}; ${p.derivation.origin} origin. This is derived evidence, not independent corroboration.`,
          );
      }
      visible.set(
        index,
        `${block.kind === "inference" ? "Inference: " : ""}${block.text} [${numbers.join(", ")}]`,
      );
    }
    const headline = slideLines(visible.get(item.headlineBlockIndex)!, 28);
    if (headline.length > 4)
      throw Error(
        "Slide headline does not fit the readable PowerPoint layout.",
      );
    slide.addText(headline.join("\n"), {
      ...common,
      x: 0.75,
      y: 0.55,
      w: 11.8,
      h: 1.6,
      fontSize: 28,
      bold: true,
      lineSpacingMultiple: 1,
    });
    let y = 2.3;
    for (const index of item.bodyBlockIndexes) {
      const lines = slideLines(visible.get(index)!, 17, 11.35),
        h = lines.length * 0.29 + 0.08;
      if (y + h > 6.82)
        throw Error("Slide body does not fit the readable PowerPoint layout.");
      slide.addText("•", {
        ...common,
        x: 0.75,
        y,
        w: 0.3,
        h: 0.3,
        fontSize: 17,
        color: "527347",
      });
      slide.addText(lines.join("\n"), {
        ...common,
        x: 1.15,
        y,
        w: 11.35,
        h,
        fontSize: 17,
        lineSpacingMultiple: 1,
      });
      y += h + 0.16;
    }
    slide.addText(
      `CODEBOOM  ·  ${position + 1}/${content.slides!.length}  ·  References and speaker notes retained`,
      {
        ...common,
        x: 0.75,
        y: 7.07,
        w: 11.8,
        h: 0.22,
        fontSize: 9,
        color: "667061",
      },
    );
    slide.addNotes(notes.join("\n"));
  }
  const limitations = [
    ...content.blocks.filter((b) => b.kind === "notice").map((b) => b.text),
    ...content.coverageWarnings,
  ];
  const appendix = deck.addSlide();
  appendix.background = { color: "FBFCF7" };
  appendix.addText("Evidence and export notes", {
    ...common,
    x: 0.75,
    y: 0.6,
    w: 11.8,
    h: 0.65,
    fontSize: 28,
    bold: true,
  });
  const summary = [
    `Content slides: ${content.slides!.length}. Generated from saved notebook snapshots.`,
    "Exact references, quotes, source revisions and speaker notes accompany each slide.",
    `Evidence/coverage notices: ${limitations.length}. Full text retained in this slide’s speaker notes.`,
    "Read those notices before presenting. Inspect original source passages to check important claims.",
    `Artifact revision: ${revision.revisionId}`,
    revision.historical
      ? "Exported from historical revision."
      : "Exported from current saved revision.",
  ];
  appendix.addText(summary.join("\n\n"), {
    ...common,
    x: 0.75,
    y: 1.65,
    w: 11.8,
    h: 4.6,
    fontSize: 18,
  });
  appendix.addNotes(
    [
      provenance,
      "Evidence limitations",
      ...limitations,
      ...(content.coverage?.map(
        (s) =>
          `${s.title}; revision ${s.revisionId}: ${s.readPassages}/${s.totalPassages} passages read.\n${s.omittedSections.map((section) => `${section.locator}: ${section.unreadPassages} unread of ${section.totalPassages}`).join("\n")}`,
      ) ?? []),
    ].join("\n\n"),
  );
  const output = await deck.write({
    outputType: "nodebuffer",
    compression: true,
  });
  if (!(output instanceof Uint8Array) || output.length > PPTX_LIMIT)
    throw Error("PowerPoint export exceeds its eight MiB limit.");
  return Buffer.from(output);
}
