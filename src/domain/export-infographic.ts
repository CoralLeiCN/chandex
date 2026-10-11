import { createCanvas } from "@napi-rs/canvas";
import { crc32 } from "node:zlib";
import { validateAnswer, type Answer, type Citation } from "./evidence.ts";
import type { ExportResolver } from "./export.ts";
import type { ExportRevision } from "./export-html.ts";

export type InfographicFormat = "svg" | "png";
export const INFOGRAPHIC_WIDTH = 1200,
  INFOGRAPHIC_MAX_HEIGHT = 4000;
type Primitive =
  | {
      kind: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      color: string;
    }
  | {
      kind: "line";
      x: number;
      y: number;
      x2: number;
      y2: number;
      color: string;
    }
  | {
      kind: "text";
      x: number;
      y: number;
      text: string;
      size: number;
      bold: boolean;
      color: string;
    };
const measure = createCanvas(1, 1).getContext("2d"),
  graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
export function infographicLines(
  value: string,
  size: number,
  width: number,
  bold = false,
): string[] {
  if (
    Array.from(value).some(
      (c) =>
        c.length === 1 &&
        c.charCodeAt(0) >= 0xd800 &&
        c.charCodeAt(0) <= 0xdfff,
    ) ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ufffe\uffff]/u.test(value)
  )
    throw Error(
      "Image text contains unsupported controls or malformed Unicode.",
    );
  measure.font = `${bold ? "bold " : ""}${size}px Arial`;
  const result: string[] = [];
  const fits = (s: string) => measure.measureText(s).width <= width;
  for (const paragraph of value.split(/\r?\n/u)) {
    let line = "";
    for (const token of paragraph.match(/\s+|[^\s]+/gu) ?? []) {
      if (/^\s+$/u.test(token)) {
        if (line) line += token;
        continue;
      }
      if (line && !fits(line + token)) {
        result.push(line.trimEnd());
        line = "";
      }
      if (fits(token)) {
        line += token;
        continue;
      }
      for (const { segment } of graphemes.segment(token)) {
        if (!fits(segment))
          throw Error("Image glyph does not fit its readable layout.");
        if (line && !fits(line + segment)) {
          result.push(line);
          line = "";
        }
        line += segment;
      }
    }
    result.push(line.trimEnd());
  }
  return result;
}
const xml = (value: string) =>
  value.replace(
    /[&<>"']/gu,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );

// iTXt contains keyword/NUL, compression flag/method, language/NUL,
// translated keyword/NUL, then uncompressed UTF-8 JSON. Only native PNG bytes enter here.
function pngProvenance(bytes: Buffer, json: string): Buffer {
  const end = bytes.length - 12;
  if (
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(end) !== 0 ||
    bytes.toString("ascii", end + 4, end + 8) !== "IEND"
  )
    throw Error("Native image encoder returned an invalid PNG.");
  const payload = Buffer.concat([
      Buffer.from("Codeboom provenance\0\0\0en\0Codeboom provenance\0", "utf8"),
      Buffer.from(json, "utf8"),
    ]),
    chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length, 0);
  chunk.write("iTXt", 4, "ascii");
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(chunk.subarray(4, chunk.length - 4)),
    chunk.length - 4,
  );
  return Buffer.concat([bytes.subarray(0, end), chunk, bytes.subarray(end)]);
}

export async function exportInfographic(
  title: string,
  content: Answer,
  resolve: ExportResolver,
  revision: ExportRevision,
  format: InfographicFormat,
): Promise<Buffer> {
  if (
    !(["svg", "png"] as string[]).includes(format) ||
    revision.authored ||
    revision.available === false ||
    content.kind !== "infographic" ||
    content.status !== "answered"
  )
    throw Error(
      "Image export requires an available generated infographic revision.",
    );
  if (
    Buffer.byteLength(JSON.stringify(content)) > 1024 * 1024 ||
    Array.from(title).length > 200
  )
    throw Error("Infographic export input exceeds its bounds.");
  const evidence = new Map<string, NonNullable<ReturnType<ExportResolver>>>();
  for (const block of content.blocks)
    for (const cite of block.citations) {
      const passage = evidence.get(cite.passageId) ?? resolve(cite.passageId);
      if (!passage) throw Error("Infographic evidence is unavailable.");
      evidence.set(cite.passageId, passage);
    }
  validateAnswer(content, [...evidence.values()], "infographic");
  const refs: {
      citation: Citation;
      passage: NonNullable<ReturnType<ExportResolver>>;
    }[] = [],
    labels = new Map<string, number>();
  const references = (cites: Citation[]) =>
    cites.map((c) => {
      const key = JSON.stringify(c),
        cached = labels.get(key);
      if (cached) return cached;
      const number = refs.length + 1;
      labels.set(key, number);
      refs.push({ citation: c, passage: evidence.get(c.passageId)! });
      return number;
    });
  const claim = (index: number) => {
    const b = content.blocks[index];
    return `${b.kind === "inference" ? "Inference: " : ""}${b.text} [${references(b.citations).join(", ")}]`;
  };
  const shapes: Primitive[] = [];
  const text = (
    value: string,
    x: number,
    y: number,
    width: number,
    size: number,
    bold = false,
    color = "#29372d",
  ) => {
    const lines = infographicLines(value, size, width, bold),
      leading = Math.ceil(size * 1.35);
    const ascent = Math.ceil(measure.measureText("Mg").fontBoundingBoxAscent);
    lines.forEach((line, i) => {
      const metrics = measure.measureText(line);
      if (
        metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent >
          leading ||
        metrics.actualBoundingBoxRight > width
      )
        throw Error("Image glyphs exceed the readable text layout.");
      shapes.push({
        kind: "text",
        x,
        y: y + i * leading + ascent,
        text: line,
        size,
        bold,
        color,
      });
    });
    return lines.length * leading;
  };
  let y = 40;
  y +=
    text("CODEBOOM · SAVED EVIDENCE", 48, y, 1104, 18, false, "#527347") + 16;
  y += text(title, 48, y, 1104, 36, true) + 28;
  const data = content.infographic!;
  if (data.orderBlockIndex !== null)
    y +=
      text(
        `Source-supported order: ${claim(data.orderBlockIndex)}`,
        48,
        y,
        1104,
        22,
      ) + 26;
  const twoColumns = data.layout !== "steps" && data.cards.length > 1,
    cardWidth = twoColumns ? 540 : 1104,
    gap = 24;
  for (
    let offset = 0;
    offset < data.cards.length;
    offset += twoColumns ? 2 : 1
  ) {
    const row = data.cards.slice(offset, offset + (twoColumns ? 2 : 1)),
      cells: Primitive[][] = [],
      heights: number[] = [];
    for (const [column, card] of row.entries()) {
      const start = shapes.length,
        x = 48 + column * (cardWidth + gap);
      let cy = y + 28;
      if (data.layout === "steps")
        cy +=
          text(
            `Step ${offset + 1}`,
            x + 26,
            cy,
            cardWidth - 52,
            18,
            true,
            "#527347",
          ) + 12;
      cy +=
        text(
          claim(card.headlineBlockIndex),
          x + 26,
          cy,
          cardWidth - 52,
          27,
          true,
        ) + 18;
      for (const index of card.bodyBlockIndexes)
        cy += text(claim(index), x + 26, cy, cardWidth - 52, 22) + 16;
      heights.push(cy - y + 12);
      cells.push(shapes.splice(start));
    }
    const height = Math.max(...heights);
    for (const [column, cell] of cells.entries()) {
      const x = 48 + column * (cardWidth + gap);
      shapes.push({
        kind: "rect",
        x,
        y,
        width: cardWidth,
        height,
        color:
          column === 1 && data.layout === "comparison" ? "#eef2ec" : "#f0f3e8",
      });
      shapes.push(
        { kind: "rect", x, y, width: 6, height, color: "#527347" },
        ...cell,
      );
    }
    y += height + 28;
    if (data.layout === "steps" && offset + 1 < data.cards.length)
      shapes.push({
        kind: "line",
        x: 600,
        y: y - 28,
        x2: 600,
        y2: y,
        color: "#527347",
      });
  }
  const notices = [
    ...content.blocks
      .filter((b) => b.kind === "notice")
      .map(
        (b) =>
          b.text +
          (b.citations.length
            ? ` [${references(b.citations).join(", ")}]`
            : ""),
      ),
    ...content.coverageWarnings,
  ];
  if (notices.length) {
    y += text("Evidence and coverage limitations", 48, y, 1104, 24, true) + 12;
    for (const notice of notices) y += text(notice, 48, y, 1104, 19) + 14;
  }
  if (content.coverage?.length)
    for (const c of content.coverage)
      y +=
        text(
          `${c.title}; source revision ${c.revisionId}: ${c.readPassages}/${c.totalPassages} passages read. ${c.omittedSections.map((s) => `${s.locator}: ${s.unreadPassages} unread of ${s.totalPassages}.`).join(" ")}`,
          48,
          y,
          1104,
          18,
        ) + 12;
  y +=
    text(
      "References · exact quotes retained in image provenance",
      48,
      y + 8,
      1104,
      22,
      true,
    ) + 20;
  for (const [i, { citation: c, passage: p }] of refs.entries()) {
    y +=
      text(
        `[${i + 1}] ${p.title} — ${p.locator}; source revision ${p.revisionId}; Unicode span ${c.start}–${c.end}.${p.derivation ? " Derived note evidence; not independent corroboration." : ""}`,
        48,
        y,
        1104,
        18,
      ) + 12;
  }
  y +=
    text(
      `Artifact revision: ${revision.revisionId}. ${revision.historical ? "Historical saved revision." : "Current saved revision."} Generated from selected notebook snapshots. Downloaded copies do not update after edits or purges.`,
      48,
      y + 8,
      1104,
      18,
    ) + 56;
  const height = Math.ceil(y);
  if (height > INFOGRAPHIC_MAX_HEIGHT)
    throw Error("Infographic does not fit its readable image layout.");
  const provenance = JSON.stringify({
    format: "codeboom-infographic-provenance",
    version: 1,
    title,
    revision,
    content,
    references: refs.map(({ citation, passage: p }) => ({
      citation,
      sourceId: p.sourceId,
      revisionId: p.revisionId,
      title: p.title,
      locator: p.locator,
      origin: p.origin ?? null,
      derivedFrom: p.derivedFrom ?? null,
      derivation: p.derivation ?? null,
      drive: p.drive ?? null,
    })),
  }).replace(/[\ufffe\uffff]/gu, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
  if (Buffer.byteLength(provenance) > 1024 * 1024)
    throw Error("Infographic provenance exceeds one MiB.");
  let output: Buffer;
  if (format === "svg") {
    const body = shapes
      .map((s) =>
        s.kind === "text"
          ? `<text x="${s.x}" y="${s.y}" font-family="Arial, sans-serif" font-size="${s.size}" font-weight="${s.bold ? 700 : 400}" fill="${s.color}">${xml(s.text)}</text>`
          : s.kind === "rect"
            ? `<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" fill="${s.color}"/>`
            : `<line x1="${s.x}" y1="${s.y}" x2="${s.x2}" y2="${s.y2}" stroke="${s.color}" stroke-width="3"/>`,
      )
      .join("");
    output = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${INFOGRAPHIC_WIDTH}" height="${height}" viewBox="0 0 ${INFOGRAPHIC_WIDTH} ${height}" role="img" aria-labelledby="title description"><title id="title">${xml(title)}</title><desc id="description">${xml(content.blocks.map((b) => (b.kind === "inference" ? "Inference: " : "") + b.text).join("\n"))}</desc><metadata>${xml(provenance)}</metadata><rect width="1200" height="${height}" fill="#fbfcf7"/>${body}</svg>`,
      "utf8",
    );
  } else {
    const canvas = createCanvas(INFOGRAPHIC_WIDTH, height),
      ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fbfcf7";
    ctx.fillRect(0, 0, INFOGRAPHIC_WIDTH, height);
    ctx.textBaseline = "alphabetic";
    for (const s of shapes) {
      if (s.kind === "rect") {
        ctx.fillStyle = s.color;
        ctx.fillRect(s.x, s.y, s.width, s.height);
      } else if (s.kind === "text") {
        ctx.font = `${s.bold ? "bold " : ""}${s.size}px Arial`;
        ctx.fillStyle = s.color;
        ctx.fillText(s.text, s.x, s.y);
      } else {
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
      }
    }
    output = pngProvenance(await canvas.encode("png"), provenance);
  }
  if (output.length > (format === "svg" ? 2 : 8) * 1024 * 1024)
    throw Error("Infographic export exceeds its byte limit.");
  return output;
}
