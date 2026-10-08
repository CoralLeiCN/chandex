import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { MAX_BYTES } from "./url.ts";
export interface Extracted {
  sections: { locator: string; text: string }[];
  warnings: string[];
  title?: string;
}
const normalize = (s: string) =>
  s.replace(/\r\n?/g, "\n").normalize("NFC").trim();
export async function extract(bytes: Buffer, kind: string): Promise<Extracted> {
  if (bytes.length > MAX_BYTES) throw new Error("Source exceeds 25 MiB.");
  let sections: { locator: string; text: string }[] = [];
  const warnings: string[] = [];
  if (kind === "pdf") {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      disableFontFace: true,
    });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 1000) throw new Error("PDF exceeds 1,000 pages.");
      for (let page = 1; page <= pdf.numPages; page++) {
        const content = await (await pdf.getPage(page)).getTextContent();
        const text = normalize(
          content.items
            .map((item) =>
              "str" in item
                ? item.str + ("hasEOL" in item && item.hasEOL ? "\n" : " ")
                : "",
            )
            .join(""),
        );
        if (!text)
          warnings.push("Page " + page + " contains no extractable text.");
        else sections.push({ locator: "Page " + page, text });
      }
    } finally {
      await task.destroy();
    }
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
        }
        body.push(line);
      }
      flush();
    } else if (["text", "paste", "note"].includes(kind))
      sections = [{ locator: "Text", text: normalize(text) }];
    else
      throw new Error(
        "Unsupported source type. Use PDF, Markdown, TXT, pasted text, or a public URL.",
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
      "No usable text found. Scanned documents require OCR, which is not supported yet.",
    );
  if (Array.from(text).length > 500000)
    throw new Error("Source exceeds 500,000 extracted characters.");
  if (text.includes("\0"))
    throw new Error("Binary content cannot be imported as text.");
}
