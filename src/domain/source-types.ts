export const fileTypes = {
  pdf: { kind: "pdf", label: "PDF document", badge: "PDF" },
  png: { kind: "image", label: "Image with English OCR", badge: "OCR" },
  jpg: { kind: "image", label: "Image with English OCR", badge: "OCR" },
  jpeg: { kind: "image", label: "Image with English OCR", badge: "OCR" },
  webp: { kind: "image", label: "Image with English OCR", badge: "OCR" },
  wav: { kind: "audio", label: "Automatic English transcript", badge: "AUD" },
  mp3: { kind: "audio", label: "Automatic English transcript", badge: "AUD" },
  m4a: { kind: "audio", label: "Automatic English transcript", badge: "AUD" },
  aac: { kind: "audio", label: "Automatic English transcript", badge: "AUD" },
  flac: { kind: "audio", label: "Automatic English transcript", badge: "AUD" },
  ogg: { kind: "audio", label: "Automatic English transcript", badge: "AUD" },
  oga: { kind: "audio", label: "Automatic English transcript", badge: "AUD" },
  opus: { kind: "audio", label: "Automatic English transcript", badge: "AUD" },
  md: { kind: "markdown", label: "Markdown source", badge: "MD" },
  txt: { kind: "text", label: "Text source", badge: "TXT" },
  srt: { kind: "srt", label: "Caption transcript", badge: "CAP" },
  vtt: { kind: "vtt", label: "Caption transcript", badge: "CAP" },
  docx: { kind: "docx", label: "Word document", badge: "DOC" },
  pptx: { kind: "pptx", label: "Presentation", badge: "PPT" },
  xlsx: { kind: "xlsx", label: "Workbook", badge: "XLS" },
  csv: { kind: "csv", label: "CSV spreadsheet", badge: "CSV" },
  tsv: { kind: "tsv", label: "TSV spreadsheet", badge: "TSV" },
} as const;
export const fileAccept = Object.keys(fileTypes)
  .map((ext) => "." + ext)
  .join(",");
export const fileKinds: readonly string[] = Object.values(fileTypes).map(
  (type) => type.kind,
);
export const importKinds: readonly string[] = [
  ...fileKinds,
  "paste",
  "url",
  "drive",
];
export function fileType(name: string) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return Object.hasOwn(fileTypes, extension)
    ? fileTypes[extension as keyof typeof fileTypes]
    : undefined;
}
export function sourceType(kind: string) {
  return Object.values(fileTypes).find((type) => type.kind === kind);
}
