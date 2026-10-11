import { createRequire } from "node:module";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createCanvas, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import type { Extracted } from "./extract.ts";
import {
  checkDimensions,
  createOcrEngine,
  confidenceWarning,
  whiteCanvas,
  OCR_NOTICE,
  MAX_PIXELS,
  type OcrEngine,
} from "./ocr.ts";
export const MAX_OCR_PAGES = 20;
export const MAX_OCR_PIXELS = 60_000_000;
export class OcrBudget {
  pages = 0;
  pixels = 0;
  add(width: number, height: number) {
    checkDimensions(width, height);
    if (++this.pages > MAX_OCR_PAGES)
      throw new Error(
        "PDF exceeds twenty rendered OCR pages. Split it into smaller files.",
      );
    this.pixels += width * height;
    if (this.pixels > MAX_OCR_PIXELS)
      throw new Error(
        "PDF exceeds sixty million rendered OCR pixels. Split it into smaller files.",
      );
  }
}
// PDF.js uses this factory for intermediate image canvases as well as renders.
class BoundedCanvasFactory {
  create(width: number, height: number) {
    checkDimensions(width, height);
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext("2d") };
  }
  reset(
    target: { canvas: Canvas; context: SKRSContext2D },
    width: number,
    height: number,
  ) {
    checkDimensions(width, height);
    target.canvas.width = width;
    target.canvas.height = height;
  }
  destroy(target: { canvas: Canvas | null; context: SKRSContext2D | null }) {
    if (target.canvas) target.canvas.width = target.canvas.height = 1;
    target.canvas = null;
    target.context = null;
  }
}
const diagnostics = new AsyncLocalStorage<{ recovery: boolean }>();
let activeParsers = 0;
const pendingDiagnostics = new Set<{ recovery: boolean }>();
let originalWarn: typeof console.warn;
async function checkedPdf(work: () => Promise<Extracted>): Promise<Extracted> {
  // Pinned PDF.js 6.4.299 can finish an empty operator list after a strict-mode
  // image failure. Recovery mode emits a diagnostic instead; reject every such
  // recovery rather than accepting omitted evidence as a blank page. Scope the
  // hook to active parsers. PDF.js message-port callbacks can lose async context;
  // in that case fail all active parses conservatively. Production has exactly
  // one parser per Worker. Unrelated logs without the Warning prefix pass through.
  if (activeParsers++ === 0) {
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      const current = diagnostics.getStore();
      if (typeof args[0] === "string" && args[0].startsWith("Warning:")) {
        if (current) current.recovery = true;
        else for (const state of pendingDiagnostics) state.recovery = true;
        return;
      }
      originalWarn(...args);
    };
  }
  const state = { recovery: false };
  pendingDiagnostics.add(state);
  try {
    const result = await diagnostics.run(state, work);
    if (state.recovery)
      throw new Error(
        "PDF parsing or rendering required recovery. A malformed, unsupported or oversized image/font/content may have been omitted; provide a corrected PDF or text copy.",
      );
    return result;
  } finally {
    pendingDiagnostics.delete(state);
    if (--activeParsers === 0) console.warn = originalWarn;
  }
}
export function extractPdf(bytes: Buffer): Promise<Extracted> {
  return checkedPdf(() => parsePdf(bytes));
}
async function parsePdf(bytes: Buffer): Promise<Extracted> {
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const require = createRequire(import.meta.url),
    pdfPath = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const task = getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    stopAtErrors: false,
    maxImageSize: MAX_PIXELS,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    CanvasFactory: BoundedCanvasFactory,
    standardFontDataUrl: path.join(pdfPath, "standard_fonts") + path.sep,
    cMapUrl: path.join(pdfPath, "cmaps") + path.sep,
    cMapPacked: true,
    wasmUrl: path.join(pdfPath, "wasm") + path.sep,
  });
  const imageOps = new Set([
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintInlineImageXObjectGroup,
    OPS.paintImageXObjectRepeat,
    OPS.paintImageMaskXObject,
    OPS.paintImageMaskXObjectGroup,
    OPS.paintImageMaskXObjectRepeat,
    OPS.paintSolidColorImageMask,
  ]);
  const sections: Extracted["sections"] = [],
    warnings: string[] = [];
  const budget = new OcrBudget();
  let engine: OcrEngine | undefined,
    characters = 0;
  const add = (locator: string, text: string) => {
    characters += Array.from(text).length + (sections.length ? 1 : 0);
    if (characters > 500000)
      throw new Error("Source exceeds 500,000 extracted characters.");
    sections.push({ locator, text });
  };
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 1000) throw new Error("PDF exceeds 1,000 pages.");
    if (pdf.isPureXfa)
      throw new Error(
        "XFA PDFs are unsupported. Export a static PDF or a text copy.",
      );
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const text = content.items
          .map((item) =>
            "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "",
          )
          .join("")
          .replace(/\r\n?/g, "\n")
          .normalize("NFC")
          .trim();
        const operators = await page.getOperatorList();
        const hasImages = operators.fnArray.some((op) => imageOps.has(op));
        if (text && !hasImages) {
          add("Page " + pageNumber, text);
          continue;
        }
        const viewport = page.getViewport({ scale: 2 });
        const width = Math.ceil(viewport.width),
          height = Math.ceil(viewport.height);
        budget.add(width, height);
        const canvas = createCanvas(width, height),
          context = canvas.getContext("2d");
        try {
          await page.render({
            canvas: canvas as unknown as HTMLCanvasElement,
            canvasContext: context as unknown as CanvasRenderingContext2D,
            viewport,
            background: "rgb(255,255,255)",
          }).promise;
          if (whiteCanvas(canvas)) {
            if (text) add("Page " + pageNumber, text);
            warnings.push(
              `Page ${pageNumber}: rendered page is entirely white; no OCR text added${text ? "; text layer retained" : ""}.`,
            );
            continue;
          }
          if (!engine) {
            engine = await createOcrEngine();
            warnings.push(OCR_NOTICE);
          }
          const recognized = engine.recognize(canvas);
          if (!recognized.text)
            throw new Error(
              `Page ${pageNumber}: nonblank page yielded no usable English OCR text. Provide a text copy.`,
            );
          if (text) {
            add(`Page ${pageNumber} · Text layer`, text);
            warnings.push(
              `Page ${pageNumber}: native text and full-page OCR are both retained; repeated text and different reading order are possible.`,
            );
          }
          add(`Page ${pageNumber} · OCR`, recognized.text);
          warnings.push(
            confidenceWarning(`Page ${pageNumber}`, recognized.confidence),
          );
        } finally {
          canvas.width = canvas.height = 1;
        }
      } finally {
        page.cleanup();
      }
    }
    return { sections, warnings };
  } catch (error) {
    // Known bounded/quality failures carry only fixed diagnostics and page numbers.
    const message = error instanceof Error ? error.message : "";
    if (
      /^(PDF exceeds |Image\/render exceeds |Invalid image dimensions\.|Source exceeds |Page \d+: nonblank|Local English OCR|Local OCR|XFA PDFs)/.test(
        message,
      )
    )
      throw error;
    throw new Error(
      "PDF parsing or rendering failed. The file may be malformed, encrypted, unsupported or contain an oversized image.",
    );
  } finally {
    engine?.close();
    await task.destroy();
  }
}
