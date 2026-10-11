import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { createRequire } from "node:module";
import path from "node:path";
import { deflateSync } from "node:zlib";
const require = createRequire(import.meta.url);
GlobalFonts.registerFromPath(
  path.join(
    path.dirname(require.resolve("pdfjs-dist/package.json")),
    "standard_fonts/LiberationSans-Regular.ttf",
  ),
  "OCR Fixture Sans",
);
export const scanLines = [
  "Pilot budget: 240 units.",
  "Approval remains pending.",
  "Delivery: 12 October 2026.",
];
export function scanCanvas(lines = scanLines, noisy = false) {
  const canvas = createCanvas(1100, 300),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 1100, 300);
  if (noisy) {
    ctx.fillStyle = "#ddd";
    for (let i = 0; i < 3000; i++)
      ctx.fillRect((i * 197) % 1100, (i * 103) % 300, 1, 1);
  }
  ctx.fillStyle = "#111";
  ctx.font = "40px OCR Fixture Sans";
  lines.forEach((line, i) => ctx.fillText(line, 35, 70 + i * 80));
  return canvas;
}
export function scanImage(
  format: "png" | "jpeg" | "webp" = "png",
  noisy = false,
) {
  const canvas = scanCanvas(scanLines, noisy);
  return format === "png"
    ? canvas.toBuffer("image/png")
    : format === "jpeg"
      ? canvas.toBuffer("image/jpeg", 95)
      : canvas.toBuffer("image/webp", 95);
}
export function exifRotatedJpeg() {
  const source = scanCanvas(),
    rotated = createCanvas(source.height, source.width),
    ctx = rotated.getContext("2d");
  ctx.translate(0, source.width);
  ctx.rotate(-Math.PI / 2);
  ctx.drawImage(source, 0, 0);
  const jpeg = rotated.toBuffer("image/jpeg", 95);
  // EXIF orientation 6 rotates the encoded scan 90 degrees clockwise for display.
  const exif = Buffer.from(
    "45786966000049492a0008000000010012010300010000000600000000000000",
    "hex",
  );
  const marker = Buffer.alloc(4);
  marker[0] = 0xff;
  marker[1] = 0xe1;
  marker.writeUInt16BE(exif.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), marker, exif, jpeg.subarray(2)]);
}
export type ScanPage = {
  lines?: string[];
  native?: string;
  blank?: boolean;
  rotate?: number;
  width?: number;
  height?: number;
  imageWidth?: number;
  imageHeight?: number;
};
export function scanPdf(pages: ScanPage[]) {
  const objects: Buffer[] = [
    Buffer.alloc(0),
    Buffer.alloc(0),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];
  const ids: number[] = [];
  for (const page of pages) {
    const pageId = objects.length + 1,
      streamId = pageId + 1,
      imageId = pageId + 2;
    ids.push(pageId);
    const width = page.width ?? 550,
      height = page.height ?? 200;
    const image = page.blank ? undefined : scanCanvas(page.lines ?? scanLines);
    const pixelData = image
      ?.getContext("2d")
      .getImageData(0, 0, image.width, image.height).data;
    const rgb = pixelData && Buffer.alloc(image!.width * image!.height * 3);
    if (rgb)
      for (let p = 0, i = 0; p < pixelData!.length; p += 4) {
        rgb[i++] = pixelData![p];
        rgb[i++] = pixelData![p + 1];
        rgb[i++] = pixelData![p + 2];
      }
    const imageData = rgb ? deflateSync(rgb) : Buffer.alloc(0);
    const escaped = page.native?.replace(/[\\()]/g, "\\$&");
    const stream = Buffer.from(
      (image ? "q 550 0 0 150 0 0 cm /Scan Do Q\n" : "") +
        (escaped ? `BT /F1 14 Tf 10 180 Td (${escaped}) Tj ET` : ""),
    );
    objects.push(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Rotate ${page.rotate ?? 0} /Resources << /Font << /F1 3 0 R >> ${image ? `/XObject << /Scan ${imageId} 0 R >>` : ""} >> /Contents ${streamId} 0 R >>`,
      ),
      Buffer.concat([
        Buffer.from(`<< /Length ${stream.length} >>\nstream\n`),
        stream,
        Buffer.from("\nendstream"),
      ]),
      Buffer.concat([
        Buffer.from(
          `<< /Type /XObject /Subtype /Image /Width ${page.imageWidth ?? image?.width ?? 1} /Height ${page.imageHeight ?? image?.height ?? 1} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${imageData.length} >>\nstream\n`,
        ),
        imageData,
        Buffer.from("\nendstream"),
      ]),
    );
  }
  objects[0] = Buffer.from("<< /Type /Catalog /Pages 2 0 R >>");
  objects[1] = Buffer.from(
    `<< /Type /Pages /Kids [${ids.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  );
  const chunks = [Buffer.from("%PDF-1.4\n")],
    offsets: number[] = [];
  let size = chunks[0].length;
  objects.forEach((object, i) => {
    offsets.push(size);
    const part = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
    chunks.push(part);
    size += part.length;
  });
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
        offsets
          .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
          .join("") +
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF`,
    ),
  );
  return Buffer.concat(chunks);
}
