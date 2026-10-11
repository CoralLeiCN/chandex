// Redistributable, deterministic PDF fixture with headings, tabular rows and
// multiple pages. Text is ASCII because the built-in Helvetica font is used.
export function textPdf(pages: string[][]): Buffer {
  const objects = [
    "",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const pageIds: number[] = [];
  for (const lines of pages) {
    const pageId = objects.length + 1;
    const streamId = pageId + 1;
    pageIds.push(pageId);
    const escape = (text: string) => text.replace(/[\\()]/g, "\\$&");
    const stream =
      "BT /F1 12 Tf 72 750 Td 16 TL\n" +
      lines.map((line) => "(" + escape(line) + ") Tj T*").join("\n") +
      "\nET";
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => id + " 0 R").join(" ")}] /Count ${pages.length} >>`;
  let data = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(data));
    data += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(data);
  data +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .map((offset) => String(offset).padStart(10, "0") + " 00000 n \n")
      .join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(data);
}
