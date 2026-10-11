import type { Extracted } from "./extract.ts";
export function columnName(value: number): string {
  let result = "";
  for (; value > 0; value = Math.floor((value - 1) / 26))
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  return result;
}
export function extractDelimited(
  bytes: Buffer,
  kind: "csv" | "tsv",
): Extracted {
  let input: string;
  try {
    input = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Delimited spreadsheets require valid UTF-8 text.");
  }
  const delimiter = kind === "csv" ? "," : "\t",
    rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false,
    started = false,
    characters = 0;
  const append = (value: string) => {
    field += value;
    if (++characters > 500000)
      throw new Error("Spreadsheet exceeds 500,000 extracted characters.");
  };
  const endField = () => {
    row.push(field);
    if (row.length > 256)
      throw new Error("Delimited spreadsheet exceeds 256 columns.");
    field = "";
    closed = false;
    started = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    if (rows.length > 10000)
      throw new Error("Delimited spreadsheet exceeds 10,000 rows.");
    row = [];
  };
  for (let i = 0; i < input.length; i++) {
    const char = String.fromCodePoint(input.codePointAt(i)!);
    if (char.length === 2) i++;
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          append('"');
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else if (char === "\r") {
        if (input[i + 1] === "\n") i++;
        append("\n");
      } else append(char);
      continue;
    }
    if (char === delimiter) {
      endField();
      continue;
    }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      endRow();
      continue;
    }
    if (closed)
      throw new Error(
        "Delimited spreadsheet contains text after a closing quote.",
      );
    if (char === '"') {
      if (started)
        throw new Error("Delimited spreadsheet contains an invalid quote.");
      quoted = true;
      started = true;
    } else {
      started = true;
      append(char);
    }
  }
  if (quoted)
    throw new Error("Delimited spreadsheet contains an unclosed quoted cell.");
  if (field || row.length || started || closed) endRow();
  if (!rows.some((row) => row.some((cell) => cell.trim())))
    throw new Error("Spreadsheet contains no populated cells.");
  return {
    sections: rows.map((row, i) => ({
      locator: `Row ${i + 1}`,
      text: row
        .map(
          (cell, j) =>
            `${columnName(j + 1)}${i + 1} = ${cell ? "Text: " + cell.replace(/\r\n?/g, "\n").normalize("NFC") : "[empty]"}`,
        )
        .join("\n"),
    })),
    warnings: [
      "Delimited cells are text, including formula-looking values; no formulas are executed. Empty cells are explicit. Header meaning, types and units are not inferred.",
    ],
  };
}
