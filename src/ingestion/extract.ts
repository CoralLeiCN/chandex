import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { MAX_BYTES } from "./url.ts";
import { extractOffice } from "./office.ts";
import { extractDelimited } from "./delimited.ts";
import { extractImage } from "./ocr.ts";
import { extractPdf } from "./pdf.ts";
import { extractCaptions } from "./captions.ts";
import type { AudioProgress } from "./audio-progress.ts";
export { EXTRACTION_VERSION } from "./version.ts";
export interface Extracted {
  sections: { locator: string; text: string }[];
  warnings: string[];
  title?: string;
}
const normalize = (s: string) =>
  s.replace(/\r\n?/g, "\n").normalize("NFC").trim();
export async function extract(
  bytes: Buffer,
  kind: string,
  onAudioProgress?: AudioProgress,
): Promise<Extracted> {
  if (bytes.length > MAX_BYTES) throw new Error("Source exceeds 25 MiB.");
  let sections: { locator: string; text: string }[] = [];
  const warnings: string[] = [];
  if (kind === "srt" || kind === "vtt") {
    const result = extractCaptions(bytes, kind);
    validateExtracted(result);
    return result;
  }
  if (["docx", "pptx", "xlsx", "csv", "tsv"].includes(kind)) {
    const result =
      kind === "csv" || kind === "tsv"
        ? extractDelimited(bytes, kind)
        : await extractOffice(bytes, kind as "docx" | "pptx" | "xlsx");
    validateExtracted(result);
    return result;
  }
  if (kind === "audio") {
    const { extractAudio } = await import("./audio.ts");
    const result = await extractAudio(bytes, onAudioProgress);
    validateExtracted(result);
    return result;
  }
  if (kind === "pdf" || kind === "image") {
    const result =
      kind === "pdf" ? await extractPdf(bytes) : await extractImage(bytes);
    validateExtracted(result);
    return result;
  } else {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (kind === "html") {
      const dom = new JSDOM(text); // No scripts or subresource loading.
      try {
        const result = new Readability(dom.window.document).parse();
        if (!result?.textContent?.trim())
          throw new Error("No readable article text found.");
        sections = [
          { locator: "Article", text: normalize(result.textContent) },
        ];
        warnings.push(
          "Main article text only; images, embedded media, and navigation are excluded.",
        );
        const extracted = {
          sections,
          warnings,
          title: result.title ?? undefined,
        };
        validateExtracted(extracted);
        return extracted;
      } finally {
        dom.window.close();
      }
    } else if (kind === "markdown") {
      const lines = normalize(text).split("\n");
      let locator = "Introduction",
        body: string[] = [];
      const flush = () => {
        if (body.join("\n").trim())
          sections.push({ locator, text: normalize(body.join("\n")) });
        body = [];
      };
      for (const line of lines) {
        if (/^#{1,6}\s/.test(line)) {
          flush();
          locator = line.replace(/^#+\s*/, "");
          if (Array.from(locator).length > 256) {
            locator = Array.from(locator).slice(0, 255).join("") + "…";
            const warning =
              "Long Markdown heading labels are shortened to 256 characters; the complete headings remain in the source text.";
            if (!warnings.includes(warning)) warnings.push(warning);
          }
        }
        body.push(line);
      }
      flush();
    } else if (["text", "paste", "note"].includes(kind))
      sections = [{ locator: "Text", text: normalize(text) }];
    else
      throw new Error(
        "Unsupported source type. Use PDF, PNG, JPEG, WebP, Markdown, TXT, DOCX, PPTX, XLSX, CSV, TSV, SRT, WebVTT, supported audio, pasted text, or a public URL.",
      );
  }
  const result = { sections, warnings };
  validateExtracted(result);
  return result;
}
function validateExtracted(value: Extracted) {
  const text = value.sections.map((s) => s.text).join("\n");
  if (!text.trim())
    throw new Error(
      "No usable text found. Provide an upright printed English scan or a text copy.",
    );
  if (Array.from(text).length > 500000)
    throw new Error("Source exceeds 500,000 extracted characters.");
  if (text.includes("\0"))
    throw new Error("Binary content cannot be imported as text.");
}
