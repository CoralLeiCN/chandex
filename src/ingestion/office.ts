import type { Extracted } from "./extract.ts";
import { columnName } from "./delimited.ts";
import {
  officePackage,
  FormatError,
  is,
  attr,
  children,
  descendants,
  text,
  normalize,
  short,
  type XmlNode,
  type OfficePackage,
} from "./office-package.ts";

const mainTypes = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
};
function collector(pkg: OfficePackage) {
  const sections: Extracted["sections"] = [];
  let count = 0;
  return {
    sections,
    add: (locator: string, value: string) => {
      const normalized = normalize(value);
      if (!normalized) return;
      count += Array.from(normalized).length + (sections.length ? 1 : 0);
      if (count > 500000)
        throw new FormatError("Source exceeds 500,000 extracted characters.");
      sections.push({ locator: short(locator), text: normalized });
    },
    warnings: pkg.warnings,
  };
}
type Collector = ReturnType<typeof collector>;
function wordText(node: XmlNode): string {
  if (is(node, "w", "del") || is(node, "w", "moveFrom")) return "";
  if (is(node, "w", "t")) return text(node);
  if (is(node, "w", "tab")) return "\t";
  if (is(node, "w", "br") || is(node, "w", "cr")) return "\n";
  if (is(node, "w", "footnoteReference"))
    return ` [Footnote ${attr(node, "id", "w") ?? "unknown"}] `;
  if (is(node, "w", "endnoteReference"))
    return ` [Endnote ${attr(node, "id", "w") ?? "unknown"}] `;
  if (is(node, "w", "commentReference"))
    return ` [Comment ${attr(node, "id", "w") ?? "unknown"}] `;
  const result = children(node).map(wordText).join("");
  return is(node, "w", "p") ? result + "\n" : result;
}
function directWithin(node: XmlNode, name: string): XmlNode[] {
  return children(node).flatMap((child) =>
    is(child, "w", "del") || is(child, "w", "moveFrom")
      ? []
      : is(child, "w", name)
        ? [child]
        : directWithin(child, name),
  );
}
function readWord(pkg: OfficePackage, out: Collector) {
  const doc = pkg.xml(pkg.main);
  if (!is(doc, "w", "document"))
    throw new FormatError("DOCX document namespace is invalid.");
  const body = children(doc).find((n) => is(n, "w", "body"));
  if (!body) throw new FormatError("DOCX document has no body.");
  const rels = pkg.relationships(pkg.main),
    headingStyles = new Set<string>();
  let usable = false;
  for (const relation of rels.values())
    if (relation.type.endsWith("/styles") && relation.target) {
      const styles = pkg.xml(relation.target);
      if (!is(styles, "w", "styles"))
        throw new FormatError("DOCX style namespace is invalid.");
      for (const style of descendants(styles, "w", "style"))
        if (
          descendants(style, "w", "outlineLvl").length ||
          /^heading\s*\d/i.test(
            attr(descendants(style, "w", "name")[0] ?? style, "val", "w") ?? "",
          )
        )
          headingStyles.add(attr(style, "styleId", "w") ?? "");
    }
  const readBody = (root: XmlNode, prefix: string) => {
    let paragraph = 0,
      table = 0;
    const visit = (node: XmlNode) => {
      if (is(node, "w", "del") || is(node, "w", "moveFrom")) return;
      if (is(node, "w", "p")) {
        const value = normalize(wordText(node));
        if (value) usable = true;
        paragraph++;
        const style = descendants(node, "w", "pStyle")[0],
          styleId = style ? attr(style, "val", "w") : "";
        const heading =
          headingStyles.has(styleId ?? "") ||
          /^Heading\d$/i.test(styleId ?? "") ||
          descendants(node, "w", "outlineLvl").length > 0;
        out.add(
          `${prefix} · Paragraph ${paragraph}${heading ? " · " + short(value) : ""}`,
          value,
        );
      } else if (is(node, "w", "tbl")) {
        table++;
        for (const [i, row] of directWithin(node, "tr").entries())
          out.add(
            `${prefix} · Table ${table} · Row ${i + 1}`,
            directWithin(row, "tc")
              .map((cell, j) => {
                const value = normalize(wordText(cell));
                if (value) usable = true;
                return `Cell ${j + 1}: ${value || "[empty]"}`;
              })
              .join("\n"),
          );
      } else for (const child of children(node)) visit(child);
    };
    for (const child of children(root)) visit(child);
  };
  readBody(body, "Body");
  for (const [type, label, entryName] of [
    ["header", "Header", ""],
    ["footer", "Footer", ""],
    ["footnotes", "Footnotes", "footnote"],
    ["endnotes", "Endnotes", "endnote"],
    ["comments", "Comments", "comment"],
  ]) {
    let index = 0;
    const seen = new Set<string>();
    for (const relation of rels.values())
      if (
        relation.type.endsWith("/" + type) &&
        relation.target &&
        !seen.has(relation.target)
      ) {
        seen.add(relation.target);
        index++;
        const part = pkg.xml(relation.target);
        if (
          !is(
            part,
            "w",
            type === "header" ? "hdr" : type === "footer" ? "ftr" : type,
          )
        )
          throw new FormatError("DOCX related content namespace is invalid.");
        if (entryName) {
          for (const entry of children(part))
            if (
              is(entry, "w", entryName) &&
              !/^(separator|continuationSeparator)$/.test(
                attr(entry, "type", "w") ?? "",
              ) &&
              !(Number(attr(entry, "id", "w")) < 0)
            ) {
              const id = attr(entry, "id", "w") ?? "unknown",
                author = attr(entry, "author", "w");
              if (normalize(wordText(entry)) || author) usable = true;
              out.add(
                `${label} · ${entryName} ${id}`,
                (author ? `Author: ${author}\n` : "") + wordText(entry),
              );
            }
        }
        // Header/footer are separate structural parts, not rendered page assignments.
        if (!entryName) readBody(part, `${label} ${index}`);
      }
  }
  if (!usable)
    throw new FormatError(
      "DOCX has no usable text; images and empty tables cannot supply text evidence.",
    );
  if (
    descendants(doc, "w", "del").length ||
    descendants(doc, "w", "moveFrom").length
  )
    out.warnings.add(
      "Tracked deletions and moved-from text are excluded; tracked insertions are retained. Formatting revisions are not applied.",
    );
  if (descendants(doc, "w", "vanish").length)
    out.warnings.add(
      "Hidden Word text is retained; hidden formatting is not applied.",
    );
  if (descendants(doc, "w", "instrText").length)
    out.warnings.add(
      "Word field display text is a stored snapshot; field instructions are not executed or updated.",
    );
  if (descendants(doc, "w", "altChunk").length)
    out.warnings.add("Embedded alternate document content is not decoded.");
  out.warnings.add(
    "DOCX preserves structural paragraphs and table cells, not rendered pages. Headers/footers are separate parts; images, diagrams, charts and visual layout are not decoded. Table merges retain stored cells without filling absent values.",
  );
}
function drawingParagraph(node: XmlNode): string {
  if (is(node, "a", "t")) return text(node);
  if (is(node, "a", "br")) return "\n";
  return children(node).map(drawingParagraph).join("");
}
function slideText(root: XmlNode, notes = false): string {
  const read = (node: XmlNode): string => {
    if (is(node, "a", "tbl"))
      return children(node)
        .filter((n) => is(n, "a", "tr"))
        .filter((row) => descendants(row, "a", "t").some((n) => text(n).trim()))
        .map((row) =>
          children(row)
            .filter((n) => is(n, "a", "tc"))
            .map(
              (cell, i) =>
                `Cell ${i + 1}: ${descendants(cell, "a", "p").map(drawingParagraph).join("\n") || "[empty]"}`,
            )
            .join("\n"),
        )
        .join("\n");
    if (is(node, "p", "sp")) {
      const placeholder = descendants(node, "p", "ph")[0],
        type = placeholder ? attr(placeholder, "type") : "";
      if (
        notes &&
        ["sldImg", "sldNum", "hdr", "ftr", "dt"].includes(type ?? "")
      )
        return "";
      return descendants(node, "a", "p").map(drawingParagraph).join("\n");
    }
    return children(node).map(read).filter(Boolean).join("\n");
  };
  return read(root);
}
function readSlides(pkg: OfficePackage, out: Collector) {
  const doc = pkg.xml(pkg.main);
  if (!is(doc, "p", "presentation"))
    throw new FormatError("PPTX presentation namespace is invalid.");
  const list = descendants(doc, "p", "sldId"),
    rels = pkg.relationships(pkg.main),
    seen = new Set<string>();
  if (list.length > 1000)
    throw new FormatError("Presentation exceeds 1,000 slides.");
  for (const [index, slideId] of list.entries()) {
    const id = attr(slideId, "id", "r") ?? "",
      relation = rels.get(id);
    if (
      !relation?.target ||
      !relation.type.endsWith("/slide") ||
      seen.has(relation.target)
    )
      throw new FormatError(
        "Presentation slide references are missing, duplicated or external.",
      );
    seen.add(relation.target);
    const slide = pkg.xml(relation.target);
    if (!is(slide, "p", "sld"))
      throw new FormatError("PPTX slide namespace is invalid.");
    const hidden = ["0", "false"].includes(attr(slide, "show") ?? ""),
      prefix = `Slide ${index + 1}${hidden ? " (hidden)" : ""}`;
    if (hidden)
      out.warnings.add("Hidden presentation slides are retained and labeled.");
    const value = slideText(slide);
    if (value.trim()) out.add(prefix, value);
    else
      out.warnings.add(
        `Slide ${index + 1} contains no extractable text; visual content is not decoded.`,
      );
    for (const note of pkg.relationships(relation.target).values())
      if (note.type.endsWith("/notesSlide") && note.target) {
        const root = pkg.xml(note.target);
        if (!is(root, "p", "notes"))
          throw new FormatError("PPTX speaker notes namespace is invalid.");
        out.add(prefix + " · Speaker notes", slideText(root, true));
      }
  }
  out.warnings.add(
    "Slide order follows the presentation; text follows saved shape/paragraph order, not spatial reading order. Images, diagrams, chart graphics, animation and embedded objects are not decoded. Speaker notes are included separately.",
  );
}
const enabled = (value: string | undefined) =>
  value === "1" || value === "true";
function address(value: string) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value);
  if (!match)
    throw new FormatError("Workbook contains invalid cell addresses.");
  const column = Array.from(match[1]).reduce(
      (n, c) => n * 26 + c.charCodeAt(0) - 64,
      0,
    ),
    row = Number(match[2]);
  if (column > 16384 || row > 1048576)
    throw new FormatError("Workbook cell address exceeds XLSX dimensions.");
  return { column, row };
}
function workbookString(value: string) {
  // ST_Xstring escapes are UTF-16 code units. Replace once so an escaped
  // underscore in _x005F_x0041_ stays the literal text _x0041_.
  const decoded = value.replace(/_x([\da-fA-F]{4})_/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
  if (decoded.includes("\0"))
    throw new FormatError("Binary content cannot be imported as text.");
  if (/[\uD800-\uDFFF]/u.test(decoded))
    throw new FormatError("Workbook contains invalid escaped text encoding.");
  return decoded;
}
const workbookText = (node: XmlNode) => workbookString(text(node));
function readWorkbook(pkg: OfficePackage, out: Collector) {
  const doc = pkg.xml(pkg.main);
  if (!is(doc, "x", "workbook"))
    throw new FormatError("XLSX workbook namespace is invalid.");
  const rels = pkg.relationships(pkg.main),
    sheets = descendants(doc, "x", "sheet"),
    strings: string[] = [],
    formats = new Map<number, string>(),
    styles: number[] = [];
  const dateSystem = enabled(
    attr(descendants(doc, "x", "workbookPr")[0] ?? doc, "date1904"),
  )
    ? "1904"
    : "1900";
  if (sheets.length > 256)
    throw new FormatError("Workbook exceeds 256 sheets.");
  for (const relation of rels.values())
    if (relation.target && relation.type.endsWith("/sharedStrings")) {
      const root = pkg.xml(relation.target);
      if (!is(root, "x", "sst"))
        throw new FormatError("Workbook shared string namespace is invalid.");
      for (const item of children(root).filter((n) => is(n, "x", "si")))
        strings.push(
          children(item)
            .filter((n) => is(n, "x", "t") || is(n, "x", "r"))
            .map((n) =>
              is(n, "x", "t")
                ? workbookText(n)
                : children(n)
                    .filter((t) => is(t, "x", "t"))
                    .map(workbookText)
                    .join(""),
            )
            .join(""),
        );
    } else if (relation.target && relation.type.endsWith("/styles")) {
      const root = pkg.xml(relation.target);
      if (!is(root, "x", "styleSheet"))
        throw new FormatError("Workbook style namespace is invalid.");
      for (const format of descendants(root, "x", "numFmt")) {
        const id = Number(attr(format, "numFmtId")),
          code = attr(format, "formatCode");
        if (
          !Number.isSafeInteger(id) ||
          id < 0 ||
          code === undefined ||
          formats.has(id)
        )
          throw new FormatError("Workbook number formats are invalid.");
        formats.set(id, workbookString(code));
      }
      for (const group of children(root).filter((n) => is(n, "x", "cellXfs")))
        for (const style of children(group).filter((n) => is(n, "x", "xf"))) {
          const id = Number(attr(style, "numFmtId") ?? 0);
          if (!Number.isSafeInteger(id) || id < 0)
            throw new FormatError("Workbook number formats are invalid.");
          styles.push(id);
        }
    }
  const numeric = (value: string, cell: XmlNode) => {
    if (
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(value) ||
      !Number.isFinite(Number(value))
    )
      throw new FormatError("Workbook contains an invalid numeric cell.");
    const styleIndex = Number(attr(cell, "s") ?? 0);
    if (
      !Number.isSafeInteger(styleIndex) ||
      styleIndex < 0 ||
      (styles.length && styleIndex >= styles.length) ||
      (!styles.length && styleIndex !== 0)
    )
      throw new FormatError("Workbook cell style is invalid.");
    const formatId = styles[styleIndex] ?? 0,
      format =
        formats.get(formatId) ??
        (formatId === 0 ? "General" : "built-in format " + formatId);
    return `Numeric: ${value}; number format: ${format}; workbook date system: ${dateSystem}`;
  };
  let populated = 0,
    cellsCount = 0;
  const seenSheets = new Set<string>();
  for (const [sheetIndex, sheet] of sheets.entries()) {
    const name = workbookString(attr(sheet, "name") ?? ""),
      relation = rels.get(attr(sheet, "id", "r") ?? "");
    if (!name || seenSheets.has(name) || !relation?.target)
      throw new FormatError(
        "Workbook sheet names or references are missing, duplicate or external.",
      );
    seenSheets.add(name);
    const state = attr(sheet, "state") ?? "visible",
      prefix = `Sheet ${sheetIndex + 1} · ${short(name)}${state !== "visible" ? " (" + state + ")" : ""}`;
    if (state !== "visible")
      out.warnings.add(
        "Hidden workbook sheets, rows and columns are retained and labeled.",
      );
    if (!relation.type.endsWith("/worksheet")) {
      out.warnings.add(
        "Non-worksheet sheets, including chart sheets, are not decoded.",
      );
      continue;
    }
    const worksheet = pkg.xml(relation.target);
    if (!is(worksheet, "x", "worksheet"))
      throw new FormatError("XLSX worksheet namespace is invalid.");
    const hiddenColumns = descendants(worksheet, "x", "col")
      .filter((n) => enabled(attr(n, "hidden")))
      .map((n) => ({
        min: Number(attr(n, "min")),
        max: Number(attr(n, "max")),
      }));
    if (
      hiddenColumns.some(
        (c) =>
          !Number.isInteger(c.min) ||
          !Number.isInteger(c.max) ||
          c.min < 1 ||
          c.max < c.min ||
          c.max > 16384,
      )
    )
      throw new FormatError("Workbook column metadata is invalid.");
    const data = children(worksheet).find((n) => is(n, "x", "sheetData")),
      rows = data ? children(data).filter((n) => is(n, "x", "row")) : [],
      shared = new Map<string, { address: string; formula: string }>(),
      seenCells = new Set<string>(),
      seenRows = new Set<number>();
    const rowCoordinates = new Map<XmlNode, number>(),
      cellCoordinates = new Map<XmlNode, string>();
    let previousRow = 0;
    for (const row of rows) {
      const cells = children(row).filter((n) => is(n, "x", "c")),
        first = attr(cells[0] ?? row, "r");
      const rowIndex =
        attr(row, "r") !== undefined
          ? Number(attr(row, "r"))
          : cells.length && first
            ? address(first).row
            : previousRow + 1;
      if (
        !Number.isInteger(rowIndex) ||
        rowIndex < 1 ||
        rowIndex > 1048576 ||
        seenRows.has(rowIndex)
      )
        throw new FormatError("Workbook row identities are invalid.");
      seenRows.add(rowIndex);
      rowCoordinates.set(row, rowIndex);
      previousRow = rowIndex;
      let previousColumn = 0;
      for (const cell of cells) {
        if (++cellsCount > 25000)
          throw new FormatError("Workbook exceeds 25,000 stored cells.");
        const ref =
            attr(cell, "r") ?? columnName(previousColumn + 1) + rowIndex,
          location = address(ref);
        if (location.row !== rowIndex || seenCells.has(ref))
          throw new FormatError(
            "Workbook cells have duplicate or mismatched row identities.",
          );
        seenCells.add(ref);
        cellCoordinates.set(cell, ref);
        previousColumn = location.column;
        const formula = children(cell).find((n) => is(n, "x", "f"));
        if (formula && attr(formula, "t") === "shared" && text(formula)) {
          const group = attr(formula, "si") ?? "";
          if (!group || shared.has(group))
            throw new FormatError(
              "Workbook shared formula definitions are invalid.",
            );
          shared.set(group, {
            address: ref,
            formula: workbookText(formula),
          });
        }
      }
    }
    for (const row of rows) {
      const rowIndex = rowCoordinates.get(row)!;
      const hidden = enabled(attr(row, "hidden"));
      if (hidden || hiddenColumns.length)
        out.warnings.add(
          "Hidden workbook sheets, rows and columns are retained and labeled.",
        );
      const values: string[] = [];
      for (const cell of children(row).filter((n) => is(n, "x", "c"))) {
        const ref = cellCoordinates.get(cell)!,
          location = address(ref);
        const type = attr(cell, "t") ?? "n",
          value = children(cell).find((n) => is(n, "x", "v")),
          formula = children(cell).find((n) => is(n, "x", "f"));
        let result = "[empty]";
        if (type === "inlineStr")
          result =
            "Text: " +
            children(cell)
              .filter((n) => is(n, "x", "is"))
              .flatMap((n) => children(n))
              .filter((n) => is(n, "x", "t") || is(n, "x", "r"))
              .map((n) =>
                is(n, "x", "t")
                  ? workbookText(n)
                  : children(n)
                      .filter((t) => is(t, "x", "t"))
                      .map(workbookText)
                      .join(""),
              )
              .join("");
        else if (value && (text(value) !== "" || type === "str")) {
          const raw = workbookText(value);
          if (type === "s") {
            const index = Number(raw);
            if (
              !/^\d+$/.test(raw) ||
              !Number.isSafeInteger(index) ||
              index >= strings.length
            )
              throw new FormatError(
                "Workbook shared string reference is invalid.",
              );
            result = "Text: " + strings[index];
          } else if (type === "b") {
            if (!["0", "1"].includes(raw))
              throw new FormatError("Workbook Boolean value is invalid.");
            result = "Boolean: " + (raw === "1" ? "true" : "false");
          } else if (type === "e") result = "Error: " + raw;
          else if (type === "d") result = "Stored date: " + raw;
          else if (type === "str") result = "Text: " + raw;
          else if (type === "n") result = numeric(raw, cell);
          else throw new FormatError("Workbook cell type is unsupported.");
        } else if (!["n", "s", "b", "e", "d", "str"].includes(type))
          throw new FormatError("Workbook cell type is unsupported.");
        if (formula) {
          const group = attr(formula, "si") ?? "",
            definition = shared.get(group),
            stored = workbookText(formula);
          const formulaText = stored
            ? stored
            : attr(formula, "t") === "shared"
              ? `shared group ${group}${definition ? "; definition at " + definition.address + ": " + definition.formula : "; definition unavailable"}`
              : "formula text unavailable";
          result = `Formula (not executed): ${formulaText}; ${value && result !== "[empty]" ? "Cached snapshot, not recalculated: " + result : "Cached result unavailable"}`;
          out.warnings.add(
            "Formulas are retained without execution; cached results are stored snapshots and may be stale. Missing cached results are unavailable.",
          );
        }
        if (result !== "[empty]") populated++;
        const hiddenColumn = hiddenColumns.some(
          (c) => location.column >= c.min && location.column <= c.max,
        );
        values.push(
          `${ref}${hiddenColumn ? " (hidden column)" : ""} = ${result}`,
        );
      }
      if (values.length)
        out.add(
          `${prefix} · Row ${rowIndex}${hidden ? " (hidden row)" : ""}`,
          values.join("\n"),
        );
    }
    const merges = descendants(worksheet, "x", "mergeCell");
    if (merges.length)
      out.add(
        prefix + " · Merged cells",
        merges
          .map((n) => {
            const range = attr(n, "ref") ?? "",
              ends = range.split(":");
            if (ends.length !== 2)
              throw new FormatError("Workbook merged range is invalid.");
            const a = address(ends[0]),
              b = address(ends[1]);
            if (a.row > b.row || a.column > b.column)
              throw new FormatError("Workbook merged range is invalid.");
            return `Merged range ${range}; only explicitly stored cell values are retained. Absent cells are not inferred.`;
          })
          .join("\n"),
      );
  }
  if (!populated)
    throw new FormatError(
      "Workbook has no populated worksheet cells; chart-only or empty workbooks cannot supply text values.",
    );
  out.warnings.add(
    "Workbook values preserve stored representations and number-format metadata, not a rendered spreadsheet. Currency, units and dates are not guessed from numeric values. Absent cells are not zero. Charts, drawings, pivot caches, external data connections and embedded objects are not decoded or refreshed.",
  );
}
export async function extractOffice(
  bytes: Buffer,
  kind: "docx" | "pptx" | "xlsx",
): Promise<Extracted> {
  try {
    const pkg = await officePackage(bytes),
      out = collector(pkg);
    if (pkg.contentTypes.get(pkg.main) !== mainTypes[kind])
      throw new FormatError(
        "Office package content does not match the selected DOCX, PPTX or XLSX type.",
      );
    if (kind === "docx") readWord(pkg, out);
    else if (kind === "pptx") readSlides(pkg, out);
    else readWorkbook(pkg, out);
    return { sections: out.sections, warnings: [...out.warnings] };
  } catch (error) {
    if (error instanceof FormatError) throw error;
    throw new FormatError("Office document could not be extracted safely.");
  }
}
