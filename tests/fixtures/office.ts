import { crc32, deflateRawSync } from "node:zlib";
export type ZipPart = {
  name: string;
  value: string | Buffer;
  flags?: number;
  crc?: number;
  size?: number;
};
// Standard central-directory ZIP fixtures, independently assembled from parser APIs.
export function zip(parts: ZipPart[]) {
  const local: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name),
      raw = Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value),
      data = deflateRawSync(raw);
    const checksum = part.crc ?? crc32(raw),
      size = part.size ?? raw.length,
      flags = part.flags ?? 0x800;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(size, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export const ns = {
  w: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  x: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
};
const types = {
  docx: "wordprocessingml.document",
  pptx: "presentationml.presentation",
  xlsx: "spreadsheetml.sheet",
};
export const xmlEscape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
export function relationships(
  entries: { id: string; type: string; target: string; external?: boolean }[],
) {
  return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map((r) => `<Relationship Id="${r.id}" Type="${ns.r}/${r.type}" Target="${xmlEscape(r.target)}"${r.external ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`;
}
export function packageParts(
  kind: "docx" | "pptx" | "xlsx",
  main: string,
  value: string,
  extra: ZipPart[] = [],
): ZipPart[] {
  return [
    {
      name: "[Content_Types].xml",
      value: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${types[kind]}.main+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      value: relationships([
        { id: "root", type: "officeDocument", target: main },
      ]),
    },
    { name: main, value },
    ...extra,
  ];
}
export function wordParts(body?: string): ZipPart[] {
  return packageParts(
    "docx",
    "word/document.xml",
    `<w:document xmlns:w="${ns.w}" xmlns:r="${ns.r}"><w:body>${body ?? '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Pilot 🦉</w:t></w:r></w:p><w:p><w:r><w:t>Budget is provisional: €240.</w:t><w:footnoteReference w:id="1"/></w:r><w:ins><w:r><w:t> Subject to approval.</w:t></w:r></w:ins><w:del><w:r><w:delText>DELETED_CANARY</w:delText></w:r></w:del></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Owner</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Zoë</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'}</w:body></w:document>`,
    [
      {
        name: "word/_rels/document.xml.rels",
        value: relationships([
          { id: "h", type: "header", target: "header1.xml" },
          { id: "f", type: "footnotes", target: "footnotes.xml" },
          { id: "c", type: "comments", target: "comments.xml" },
          { id: "link", type: "hyperlink", target: "#local-bookmark" },
          {
            id: "image",
            type: "image",
            target: "http://127.0.0.1/private",
            external: true,
          },
        ]),
      },
      {
        name: "word/header1.xml",
        value: `<w:hdr xmlns:w="${ns.w}"><w:p><w:r><w:t>Confidential pilot</w:t></w:r></w:p></w:hdr>`,
      },
      {
        name: "word/footnotes.xml",
        value: `<w:footnotes xmlns:w="${ns.w}"><w:footnote w:id="-1" w:type="separator"><w:p><w:r><w:t>SEPARATOR_CANARY</w:t></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:t>Estimate excludes VAT.</w:t></w:r></w:p></w:footnote></w:footnotes>`,
      },
      {
        name: "word/comments.xml",
        value: `<w:comments xmlns:w="${ns.w}"><w:comment w:id="0" w:author="Ana"><w:p><w:r><w:t>Review remains pending.</w:t></w:r></w:p></w:comment></w:comments>`,
      },
    ],
  );
}
export const wordFixture = () => zip(wordParts());
function shape(value: string, type = "") {
  return `<p:sp><p:nvSpPr><p:nvPr>${type ? `<p:ph type="${type}"/>` : ""}</p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${xmlEscape(value)}</a:t></a:r></a:p></p:txBody></p:sp>`;
}
const drawingNs = `xmlns:p="${ns.p}" xmlns:a="${ns.a}"`;
export function slidesFixture() {
  return zip(
    packageParts(
      "pptx",
      "ppt/presentation.xml",
      `<p:presentation xmlns:p="${ns.p}" xmlns:r="${ns.r}"><p:sldIdLst><p:sldId id="256" r:id="second"/><p:sldId id="257" r:id="first"/></p:sldIdLst></p:presentation>`,
      [
        {
          name: "ppt/_rels/presentation.xml.rels",
          value: relationships([
            { id: "second", type: "slide", target: "slides/slide2.xml" },
            { id: "first", type: "slide", target: "slides/slide1.xml" },
          ]),
        },
        {
          name: "ppt/slides/slide2.xml",
          value: `<p:sld ${drawingNs} show="0"><p:cSld><p:spTree>${shape("First in presentation 🦉")}<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Budget: €240, provisional</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`,
        },
        {
          name: "ppt/slides/slide1.xml",
          value: `<p:sld ${drawingNs}><p:cSld><p:spTree>${shape("Second in presentation")}</p:spTree></p:cSld></p:sld>`,
        },
        {
          name: "ppt/slides/_rels/slide2.xml.rels",
          value: relationships([
            {
              id: "notes",
              type: "notesSlide",
              target: "../notesSlides/notesSlide1.xml",
            },
          ]),
        },
        {
          name: "ppt/notesSlides/notesSlide1.xml",
          value: `<p:notes ${drawingNs}><p:cSld><p:spTree>${shape("Subject to approval.", "body")}${shape("SLIDE_NUMBER_CANARY", "sldNum")}</p:spTree></p:cSld></p:notes>`,
        },
      ],
    ),
  );
}
export function workbookParts(cells?: string): ZipPart[] {
  return packageParts(
    "xlsx",
    "xl/workbook.xml",
    `<workbook xmlns="${ns.x}" xmlns:r="${ns.r}"><workbookPr date1904="1"/><sheets><sheet name="Pilot 🦉" sheetId="2" r:id="second" state="hidden"/><sheet name="Other" sheetId="1" r:id="first"/></sheets></workbook>`,
    [
      {
        name: "xl/_rels/workbook.xml.rels",
        value: relationships([
          { id: "second", type: "worksheet", target: "worksheets/sheet2.xml" },
          { id: "first", type: "worksheet", target: "worksheets/sheet1.xml" },
          { id: "strings", type: "sharedStrings", target: "sharedStrings.xml" },
          { id: "styles", type: "styles", target: "styles.xml" },
          {
            id: "external",
            type: "externalLink",
            target: "http://127.0.0.1/private",
            external: true,
          },
        ]),
      },
      {
        name: "xl/sharedStrings.xml",
        value: `<sst xmlns="${ns.x}"><si><r><t>Zo</t></r><r><t>ë 🦉</t></r><rPh><t>PHONETIC_CANARY</t></rPh></si></sst>`,
      },
      {
        name: "xl/styles.xml",
        value: `<styleSheet xmlns="${ns.x}"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.00&quot; units&quot;"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
      },
      {
        name: "xl/worksheets/sheet2.xml",
        value: `<worksheet xmlns="${ns.x}"><cols><col min="3" max="3" hidden="1"/></cols><sheetData>${cells ?? '<row r="1" hidden="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Provisional</t></is></c><c r="C1" s="1"><v>240.00</v></c><c r="D1" t="b"><v>1</v></c><c r="E1" t="e"><v>#N/A</v></c><c r="F1" t="d"><v>2026-10-10</v></c><c r="G1"><f>C1*2</f><v>480</v></c><c r="H1"><f>NOW()</f><v/></c><c r="I1"/></row><row r="3"><c r="A3"><f t="shared" si="0" ref="A3:A4">C1+1</f><v>241</v></c></row><row r="4"><c r="A4"><f t="shared" si="0"/><v>242</v></c></row>'}</sheetData><mergeCells count="1"><mergeCell ref="B1:B2"/></mergeCells></worksheet>`,
      },
      {
        name: "xl/worksheets/sheet1.xml",
        value: `<worksheet xmlns="${ns.x}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Other worksheet evidence.</t></is></c></row></sheetData></worksheet>`,
      },
    ],
  );
}
export const workbookFixture = () => zip(workbookParts());
export const csvFixture = () =>
  Buffer.from(
    'Owner,Budget,Qualifier,Empty\r\n"Zoë 🦉",240,"Provisional, subject to approval",\r\n"Two\nlines","=1+2","She said ""yes""",\r\n',
  );
export const tsvFixture = () =>
  Buffer.from('Owner\tQualifier\tEmpty\nZoë 🦉\t"Provisional\tapproval"\t\n');
