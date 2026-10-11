import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { gunzipSync, crc32 } from "node:zlib";
import path from "node:path";
import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import type { Extracted } from "./extract.ts";

const require = createRequire(import.meta.url);
export const MAX_PIXELS = 12_000_000;
export const MAX_SIDE = 8000;
export const OCR_NOTICE =
  "OCR: Tesseract core 6.1.2, bundled English model 1.0.0 (best_int). Recognition may misread numbers, names, punctuation and layout; check the original. Confidence is an engine estimate, not an accuracy guarantee. Upright printed English is supported; other languages and handwriting are not qualified.";
export function checkDimensions(width: number, height: number) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  )
    throw new Error("Invalid image dimensions.");
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS)
    throw new Error(
      "Image/render exceeds 8,000 pixels per side or 12 million pixels.",
    );
  return { width, height };
}
// Read dimensions before native decoding; neither strings nor URLs are accepted.
export function imageDimensions(bytes: Buffer) {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    if (
      bytes.length < 33 ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString("ascii", 12, 16) !== "IHDR"
    )
      throw new Error("Malformed PNG image.");
    const dimensions = checkDimensions(
      bytes.readUInt32BE(16),
      bytes.readUInt32BE(20),
    );
    let cursor = 8,
      ended = false;
    while (cursor + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(cursor),
        end = cursor + size + 12;
      if (end > bytes.length) throw new Error("Truncated PNG image.");
      const type = bytes.toString("ascii", cursor + 4, cursor + 8);
      if (type === "acTL")
        throw new Error(
          "Animated images are unsupported. Use a static PNG, JPEG or WebP.",
        );
      if (
        crc32(bytes.subarray(cursor + 4, end - 4)) !==
        bytes.readUInt32BE(end - 4)
      )
        throw new Error("Malformed PNG image checksum.");
      cursor = end;
      if (type === "IEND") {
        ended = true;
        break;
      }
    }
    if (!ended || cursor !== bytes.length)
      throw new Error("Malformed PNG image.");
    return dimensions;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let cursor = 2;
    while (cursor < bytes.length) {
      if (bytes[cursor++] !== 0xff) break;
      while (bytes[cursor] === 0xff) cursor++;
      const marker = bytes[cursor++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (cursor + 2 > bytes.length) break;
      const size = bytes.readUInt16BE(cursor);
      if (size < 2 || cursor + size > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (size < 8) break;
        return checkDimensions(
          bytes.readUInt16BE(cursor + 5),
          bytes.readUInt16BE(cursor + 3),
        );
      }
      cursor += size;
    }
    throw new Error("Malformed or unsupported JPEG image.");
  }
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    if (bytes.length < 30 || bytes.readUInt32LE(4) + 8 !== bytes.length)
      throw new Error("Malformed WebP image.");
    let cursor = 12,
      dimensions: { width: number; height: number } | undefined;
    while (cursor + 8 <= bytes.length) {
      const type = bytes.toString("ascii", cursor, cursor + 4),
        size = bytes.readUInt32LE(cursor + 4),
        start = cursor + 8;
      if (start + size > bytes.length) throw new Error("Truncated WebP image.");
      if (
        type === "ANIM" ||
        type === "ANMF" ||
        (type === "VP8X" && bytes[start] & 2)
      )
        throw new Error(
          "Animated images are unsupported. Use a static PNG, JPEG or WebP.",
        );
      let candidate;
      if (type === "VP8X" && size >= 10)
        candidate = checkDimensions(
          1 + bytes.readUIntLE(start + 4, 3),
          1 + bytes.readUIntLE(start + 7, 3),
        );
      else if (
        type === "VP8 " &&
        size >= 10 &&
        bytes
          .subarray(start + 3, start + 6)
          .equals(Buffer.from([0x9d, 0x01, 0x2a]))
      )
        candidate = checkDimensions(
          bytes.readUInt16LE(start + 6) & 0x3fff,
          bytes.readUInt16LE(start + 8) & 0x3fff,
        );
      else if (type === "VP8L" && size >= 5 && bytes[start] === 0x2f) {
        const bits = bytes.readUInt32LE(start + 1);
        candidate = checkDimensions(
          (bits & 0x3fff) + 1,
          ((bits >>> 14) & 0x3fff) + 1,
        );
      }
      if (candidate) {
        if (
          dimensions &&
          (dimensions.width !== candidate.width ||
            dimensions.height !== candidate.height)
        )
          throw new Error("Inconsistent WebP image dimensions.");
        dimensions = candidate;
      }
      cursor = start + size + (size % 2);
    }
    if (!dimensions || cursor !== bytes.length)
      throw new Error("Malformed WebP image.");
    return dimensions;
  }
  throw new Error("Unsupported image. Use a static PNG, JPEG or WebP.");
}
export async function imageCanvas(bytes: Buffer): Promise<Canvas> {
  const dimensions = imageDimensions(bytes);
  let image;
  try {
    image = await loadImage(bytes);
  } catch {
    throw new Error(
      "Image decoding failed. Use a valid static PNG, JPEG or WebP.",
    );
  }
  checkDimensions(image.width, image.height);
  // EXIF can swap width/height but cannot change the decoded pixel count.
  if (image.width * image.height !== dimensions.width * dimensions.height)
    throw new Error("Decoded image dimensions do not match the header.");
  const canvas = createCanvas(image.width, image.height),
    context = canvas.getContext("2d");
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  return canvas;
}
export function whiteCanvas(canvas: Canvas) {
  // Inspect in strips so blank detection does not allocate a second full bitmap.
  const context = canvas.getContext("2d");
  for (let row = 0; row < canvas.height; row += 64) {
    const data = context.getImageData(
      0,
      row,
      canvas.width,
      Math.min(64, canvas.height - row),
    ).data;
    for (let i = 0; i < data.length; i += 4)
      if (
        data[i] !== 255 ||
        data[i + 1] !== 255 ||
        data[i + 2] !== 255 ||
        data[i + 3] !== 255
      )
        return false;
  }
  return true;
}
interface TessApi {
  Init(path: null, lang: string, engine: number): number;
  SetVariable(name: string, value: string): boolean;
  SetPageSegMode(mode: number): void;
  SetImageFile(exif: number, angle: number): number;
  SetSourceResolution(dpi: number): void;
  Recognize(monitor: null): number;
  GetUTF8Text(): string;
  MeanTextConf(): number;
  Clear(): void;
  End(): void;
}
interface TessModule {
  TessBaseAPI: new () => TessApi;
  FS: {
    writeFile(name: string, bytes: Uint8Array): void;
    unlink(name: string): void;
  };
  destroy(api: TessApi): void;
}
export interface OcrEngine {
  recognize(canvas: Canvas): { text: string; confidence: number };
  close(): void;
}
export async function createOcrEngine(): Promise<OcrEngine> {
  let core: TessModule, api: TessApi | undefined;
  try {
    const factory = require("tesseract.js-core/tesseract-core-simd-lstm.wasm.js");
    core = await factory({
      wasmBinary: readFileSync(
        require.resolve("tesseract.js-core/tesseract-core-simd-lstm.wasm"),
      ),
      print: () => {},
      printErr: () => {},
    });
    const modelPath = path.join(
      path.dirname(require.resolve("@tesseract.js-data/eng")),
      "4.0.0_best_int/eng.traineddata.gz",
    );
    core.FS.writeFile(
      "/eng.traineddata",
      gunzipSync(readFileSync(modelPath), {
        maxOutputLength: 32 * 1024 * 1024,
      }),
    );
    api = new core.TessBaseAPI();
    if (api.Init(null, "eng", 1) !== 0) throw new Error();
    api.SetPageSegMode(3);
    api.SetVariable("debug_file", "/ocr-debug.txt");
  } catch {
    if (api) {
      api.End();
      core!.destroy(api);
    }
    throw new Error(
      "Local English OCR could not initialize. Reinstall the pinned dependencies.",
    );
  }
  const instance = api;
  return {
    recognize(canvas) {
      try {
        core.FS.writeFile("/input", canvas.toBuffer("image/png"));
        if (instance.SetImageFile(1, 0) !== 0) throw new Error();
        instance.SetSourceResolution(144);
        if (instance.Recognize(null) !== 0) throw new Error();
        return {
          text: instance
            .GetUTF8Text()
            .replace(/\r\n?/g, "\n")
            .normalize("NFC")
            .trim(),
          confidence: instance.MeanTextConf(),
        };
      } catch {
        throw new Error("Local OCR recognition failed.");
      } finally {
        instance.Clear();
        core.FS.unlink("/input");
      }
    },
    close() {
      instance.End();
      core.destroy(instance);
    },
  };
}
export function confidenceWarning(locator: string, confidence: number) {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100)
    return `${locator}: OCR confidence unavailable; compare with the original.`;
  return `${locator}: OCR mean confidence ${Math.round(confidence)}/100${confidence < 70 ? " (low; review carefully)" : ""}.`;
}
export async function extractImage(bytes: Buffer): Promise<Extracted> {
  const canvas = await imageCanvas(bytes);
  try {
    if (whiteCanvas(canvas))
      throw new Error("No usable text found in this image.");
    const engine = await createOcrEngine();
    try {
      const { text, confidence } = engine.recognize(canvas);
      if (!text)
        throw new Error(
          "No usable text found in this image. Provide an upright printed English scan or a text copy.",
        );
      return {
        sections: [{ locator: "Image 1 · OCR", text }],
        warnings: [OCR_NOTICE, confidenceWarning("Image 1", confidence)],
      };
    } finally {
      engine.close();
    }
  } finally {
    canvas.width = canvas.height = 1;
  }
}
