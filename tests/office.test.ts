import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { extract } from "../src/ingestion/extract.ts";
import { extractIsolated } from "../src/ingestion/service.ts";
import { Store } from "../src/storage/store.ts";
import { backup, restore } from "../src/storage/backup.ts";
import { validateAnswer, type Answer } from "../src/domain/evidence.ts";
import {
  wordFixture,
  wordParts,
  slidesFixture,
  workbookFixture,
  workbookParts,
  csvFixture,
  tsvFixture,
  packageParts,
  relationships,
  zip,
  ns,
} from "./fixtures/office.ts";
const contents = (result: Awaited<ReturnType<typeof extract>>) =>
  result.sections.map((s) => s.text).join("\n");
export const imports = [
  { kind: "docx", bytes: wordFixture() },
  { kind: "pptx", bytes: slidesFixture() },
  { kind: "xlsx", bytes: workbookFixture() },
  { kind: "csv", bytes: csvFixture() },
  { kind: "tsv", bytes: tsvFixture() },
];
test("DOCX preserves heading, paragraph, table, reference and related-part evidence without tracked deletions", async () => {
  const result = await extract(wordFixture(), "docx"),
    value = contents(result);
  assert.deepEqual(
    result.sections.map((s) => s.locator),
    [
      "Body · Paragraph 1 · Pilot 🦉",
      "Body · Paragraph 2",
      "Body · Table 1 · Row 1",
      "Header 1 · Paragraph 1",
      "Footnotes · footnote 1",
      "Comments · comment 0",
    ],
  );
  assert.match(
    value,
    /Budget is provisional: €240\. \[Footnote 1\]  Subject to approval\./,
  );
  assert.match(value, /Cell 1: Owner\nCell 2: Zoë/);
  assert.match(value, /Estimate excludes VAT/);
  assert.match(value, /Author: Ana\nReview remains pending/);
  assert.doesNotMatch(value, /DELETED_CANARY|SEPARATOR_CANARY|127\.0\.0\.1/);
  assert.match(result.warnings.join(" "), /Tracked deletions.*rendered pages/);
  assert.match(result.warnings.join(" "), /External relationships/);
});
test("PPTX follows declared order, includes tables and notes, and labels hidden slides", async () => {
  const result = await extract(slidesFixture(), "pptx");
  assert.deepEqual(
    result.sections.map((s) => s.locator),
    ["Slide 1 (hidden)", "Slide 1 (hidden) · Speaker notes", "Slide 2"],
  );
  assert.match(
    result.sections[0].text,
    /First in presentation 🦉\nCell 1: Budget: €240, provisional/,
  );
  assert.equal(result.sections[1].text, "Subject to approval.");
  assert.equal(result.sections[2].text, "Second in presentation");
  assert.doesNotMatch(contents(result), /SLIDE_NUMBER_CANARY/);
  assert.match(result.warnings.join(" "), /not spatial reading order/);
});
test("DOCX supports strict namespaces and UTF-16 text while keeping stored field results and one alternate representation", async () => {
  const body =
    '<w:p><w:r><w:instrText>PRIVATE_FIELD_COMMAND</w:instrText><w:t>Stored result é 🦉</w:t></w:r></w:p><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="w"><w:p><w:r><w:t>CHOICE_CANARY</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>Fallback evidence</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>';
  const parts = wordParts(body).map((part) => ({
    ...part,
    value: part.name.endsWith(".xml")
      ? Buffer.from(
          "\ufeff" +
            String(part.value).replaceAll(
              ns.w,
              "http://purl.oclc.org/ooxml/wordprocessingml/main",
            ),
          "utf16le",
        )
      : part.value,
  }));
  const result = await extract(zip(parts), "docx");
  assert.match(contents(result), /Stored result é 🦉\nFallback evidence/);
  assert.doesNotMatch(contents(result), /PRIVATE_FIELD_COMMAND|CHOICE_CANARY/);
  assert.match(result.warnings.join(" "), /stored snapshot/);
  assert.match(result.warnings.join(" "), /fallback text/);
});
test("empty Office tables and image-only documents cannot publish structural labels as evidence", async () => {
  const word = zip(
    packageParts(
      "docx",
      "word/document.xml",
      `<w:document xmlns:w="${ns.w}"><w:body><w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl></w:body></w:document>`,
    ),
  );
  await assert.rejects(extract(word, "docx"), /no usable text/);
  const workbook = zip(
    packageParts(
      "xlsx",
      "xl/workbook.xml",
      `<workbook xmlns="${ns.x}" xmlns:r="${ns.r}"><sheets><sheet name="Empty" r:id="s"/></sheets></workbook>`,
      [
        {
          name: "xl/_rels/workbook.xml.rels",
          value: relationships([
            { id: "s", type: "worksheet", target: "worksheets/sheet1.xml" },
          ]),
        },
        {
          name: "xl/worksheets/sheet1.xml",
          value: `<worksheet xmlns="${ns.x}"><sheetData><row r="1"><c r="A1"/></row></sheetData></worksheet>`,
        },
      ],
    ),
  );
  await assert.rejects(extract(workbook, "xlsx"), /no populated/);
});
test("XLSX preserves sheet order, coordinates, typed cells, raw formats, formulas, missing caches, hidden and merged annotations", async () => {
  const result = await extract(workbookFixture(), "xlsx"),
    value = contents(result);
  assert.equal(
    result.sections[0].locator,
    "Sheet 1 · Pilot 🦉 (hidden) · Row 1 (hidden row)",
  );
  for (const pattern of [
    /A1 = Text: Zoë 🦉/,
    /B1 = Text: Provisional/,
    /C1 \(hidden column\) = Numeric: 240.00; number format: 0.00" units"; workbook date system: 1904/,
    /D1 = Boolean: true/,
    /E1 = Error: #N\/A/,
    /F1 = Stored date: 2026-10-10/,
    /G1 = Formula \(not executed\): C1\*2; Cached snapshot, not recalculated: Numeric: 480/,
    /H1 = Formula \(not executed\): NOW\(\); Cached result unavailable/,
    /I1 = \[empty\]/,
    /A4 = Formula \(not executed\): shared group 0; definition at A3: C1\+1/,
    /Merged range B1:B2/,
  ])
    assert.match(value, pattern);
  assert.equal(result.sections.at(-1)?.locator, "Sheet 2 · Other · Row 1");
  assert.doesNotMatch(value, /PHONETIC_CANARY|Row 2|127\.0\.0\.1/);
  assert.match(result.warnings.join(" "), /cached results.*may be stale/);
});
test("XLSX decodes escaped inline, shared and cached strings once before normalization", async () => {
  const encoded = "First_x000D_Second_x005F_x0041_ _xd83e__xdd89_ e_x0301_",
    expected = "First\nSecond_x0041_ 🦉 é",
    parts = workbookParts(
      `<row r="1"><c r="A1" t="inlineStr"><is><t>${encoded}</t></is></c><c r="B1" t="inlineStr"><is><r><t>Rich: </t></r><r><t>${encoded}</t></r><rPh><t>PHONETIC_CANARY</t></rPh></is></c><c r="C1" t="s"><v>0</v></c><c r="D1" t="s"><v>1</v></c><c r="E1" t="str"><f>A1</f><v>${encoded}</v></c></row>`,
    ).map((part) =>
      part.name === "xl/sharedStrings.xml"
        ? {
            ...part,
            value: `<sst xmlns="${ns.x}"><si><t>${encoded}</t></si><si><r><t>Rich: </t></r><r><t>${encoded}</t></r><rPh><t>PHONETIC_CANARY</t></rPh></si></sst>`,
          }
        : part,
    ),
    bytes = zip(parts),
    result = await extract(bytes, "xlsx");
  assert.equal(
    result.sections[0].text,
    `A1 = Text: ${expected}\nB1 = Text: Rich: ${expected}\nC1 (hidden column) = Text: ${expected}\nD1 = Text: Rich: ${expected}\nE1 = Formula (not executed): A1; Cached snapshot, not recalculated: Text: ${expected}`,
  );
  assert.deepEqual(await extractIsolated(bytes, "xlsx"), result);
});
test("XLSX preserves escaped underscores and incomplete escapes across rich text runs", async () => {
  const result = await extract(
    zip(
      workbookParts(
        '<row><c t="inlineStr"><is><r><t>_x005f_x000D_</t></r><r><t> _x00</t></r><r><t>41_ _xQQQQ_ _x041_</t></r></is></c></row>',
      ),
    ),
    "xlsx",
  );
  assert.equal(
    result.sections[0].text,
    "A1 = Text: _x000D_ _x0041_ _xQQQQ_ _x041_",
  );
});
test("XLSX rejects escaped NULs and unpaired surrogates in text cells", async () => {
  for (const encoded of ["_x0000_", "_xD83E_", "_xDD89_", "_xD83E_x_xDD89_"]) {
    for (const type of ["inlineStr", "s", "str"]) {
      const cell =
          type === "inlineStr"
            ? `<is><t>PRIVATE_CANARY${encoded}</t></is>`
            : `<v>${type === "s" ? "0" : "PRIVATE_CANARY" + encoded}</v>`,
        parts = workbookParts(`<row><c t="${type}">${cell}</c></row>`).map(
          (part) =>
            type === "s" && part.name === "xl/sharedStrings.xml"
              ? {
                  ...part,
                  value: `<sst xmlns="${ns.x}"><si><t>PRIVATE_CANARY${encoded}</t></si></sst>`,
                }
              : part,
        );
      await assert.rejects(
        extract(zip(parts), "xlsx"),
        (error: Error) =>
          !error.message.includes("PRIVATE_CANARY") &&
          /Binary content|invalid escaped text encoding/.test(error.message),
      );
    }
  }
});
test("XLSX decodes escaped sheet names and number-format metadata", async () => {
  const parts = workbookParts().map((part) => ({
      ...part,
      value:
        part.name === "xl/workbook.xml"
          ? String(part.value).replace(
              "Pilot 🦉",
              "_x005F_x0041_ _xD83E__xDD89_",
            )
          : part.name === "xl/styles.xml"
            ? String(part.value).replace(" units", " _x005F_x0041_ units")
            : part.value,
    })),
    result = await extract(zip(parts), "xlsx");
  assert.equal(
    result.sections[0].locator,
    "Sheet 1 · _x0041_ 🦉 (hidden) · Row 1 (hidden row)",
  );
  assert.match(result.sections[0].text, /number format: 0.00" _x0041_ units"/);
  const invalid = parts.map((part) => ({
    ...part,
    value:
      part.name === "xl/workbook.xml"
        ? String(part.value).replace("_x005F_x0041_", "_x0000_")
        : part.value,
  }));
  await assert.rejects(extract(zip(invalid), "xlsx"), /Binary content/);
});
test("XLSX decodes formulas and their shared definitions without executing or decoding twice", async () => {
  const formula = "&quot;_x005F_x0041_&quot;";
  const result = await extract(
    zip(
      workbookParts(
        `<row><c t="str"><f t="shared" si="0">${formula}</f><v>_x005F_x0041_</v></c><c t="str"><f t="shared" si="0"/><v>_x005F_x0041_</v></c><c t="str"><f>${formula}</f><v>_x005F_x0041_</v></c></row>`,
      ),
    ),
    "xlsx",
  );
  assert.equal(
    result.sections[0].text,
    'A1 = Formula (not executed): "_x0041_"; Cached snapshot, not recalculated: Text: _x0041_\nB1 = Formula (not executed): shared group 0; definition at A1: "_x0041_"; Cached snapshot, not recalculated: Text: _x0041_\nC1 (hidden column) = Formula (not executed): "_x0041_"; Cached snapshot, not recalculated: Text: _x0041_',
  );
});
test("CSV and TSV preserve quoted delimiters, multiline, escaped quotes, Unicode, explicit empty and formula-looking text", async () => {
  const csv = await extract(csvFixture(), "csv"),
    tsv = await extract(tsvFixture(), "tsv");
  assert.equal(csv.sections.length, 3);
  assert.equal(csv.sections[1].locator, "Row 2");
  assert.equal(
    csv.sections[1].text,
    "A2 = Text: Zoë 🦉\nB2 = Text: 240\nC2 = Text: Provisional, subject to approval\nD2 = [empty]",
  );
  assert.match(
    csv.sections[2].text,
    /A3 = Text: Two\nlines\nB3 = Text: =1\+2\nC3 = Text: She said "yes"\nD3 = \[empty\]/,
  );
  assert.match(
    tsv.sections[1].text,
    /B2 = Text: Provisional\tapproval\nC2 = \[empty\]/,
  );
  const nfc = await extract(Buffer.from('\ufeff"e\u0301 🦉",x'), "csv");
  assert.match(contents(nfc), /é 🦉/);
});
test("delimited parsing refuses malformed quotes, invalid encodings, empty sources and bounded dimensions atomically", async () => {
  for (const value of ['"unclosed', 'a"b,c', '"a"x,b', " ,\r\n,"])
    await assert.rejects(extract(Buffer.from(value), "csv"));
  await assert.rejects(extract(Buffer.from([0xc3, 0x28]), "csv"), /UTF-8/);
  await assert.rejects(
    extract(Buffer.from(Array(257).fill("x").join(",")), "csv"),
    /256 columns/,
  );
  await assert.rejects(
    extract(Buffer.from("x\n".repeat(10001)), "csv"),
    /10,000 rows/,
  );
  await assert.rejects(
    extract(Buffer.from("x".repeat(500001)), "csv"),
    /500,000/,
  );
});
test("Office packages reject corrupt ZIPs, duplicate/unsafe names, CRC/size mismatch, encrypted and macro files with sanitized errors", async () => {
  const good = wordParts();
  const fixtures = [
    Buffer.from("PRIVATE_CANARY not a zip"),
    zip([...good, { name: "word/../evil.xml", value: "PRIVATE_CANARY" }]),
    zip([...good, good[2]]),
    zip(good.map((p, i) => (i === 2 ? { ...p, crc: 0 } : p))),
    zip(good.map((p, i) => (i === 2 ? { ...p, size: 1 } : p))),
    zip(good.map((p, i) => (i === 2 ? { ...p, flags: 0x801 } : p))),
    zip([...good, { name: "word/vbaProject.bin", value: "PRIVATE_CANARY" }]),
    zip(
      good.map((p, i) =>
        i === 0
          ? {
              ...p,
              value: String(p.value).replace(
                "wordprocessingml.document.main",
                "wordprocessingml.document.macroEnabled.main",
              ),
            }
          : p,
      ),
    ),
    zip(
      good.map((p, i) => (i === 2 ? { ...p, size: 8 * 1024 * 1024 + 1 } : p)),
    ),
  ];
  for (const bytes of fixtures)
    await assert.rejects(
      extract(bytes, "docx"),
      (error: Error) => !error.message.includes("PRIVATE_CANARY"),
    );
  await assert.rejects(extract(wordFixture(), "xlsx"), /does not match/);
});
test("Office required XML rejects DTD/entities, unsafe internal targets, wrong namespaces, depth and element floods", async () => {
  const root = (value: string) =>
    zip(packageParts("docx", "word/document.xml", value));
  for (const value of [
    `<!DOCTYPE document [<!ENTITY x SYSTEM "file:///PRIVATE_CANARY">]><w:document xmlns:w="${ns.w}"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>`,
    `<w:document xmlns:w="${ns.w}"><w:body>&PRIVATE_CANARY;</w:body></w:document>`,
    `<w:document xmlns:w="urn:PRIVATE_CANARY"><w:body/></w:document>`,
    `<w:document xmlns:w="${ns.w}"><w:body>${"<w:sdt>".repeat(65)}PRIVATE_CANARY${"</w:sdt>".repeat(65)}</w:body></w:document>`,
    `<w:document xmlns:w="${ns.w}"><w:body>${"<w:p/>".repeat(100001)}</w:body></w:document>`,
  ])
    await assert.rejects(
      extract(root(value), "docx"),
      (e: Error) => !e.message.includes("PRIVATE_CANARY"),
    );
  await assert.rejects(
    extract(
      zip([
        ...wordParts(),
        {
          name: "word/_rels/header1.xml.rels",
          value: relationships([
            { id: "evil", type: "image", target: "../../../../PRIVATE_CANARY" },
          ]),
        },
      ]),
      "docx",
    ),
    /escapes the package/,
  );
});
test("Office decoded XML and final-output budgets fail before publication", async () => {
  const good = wordParts(),
    chunk = " ".repeat(8 * 1024 * 1024);
  await assert.rejects(
    extract(
      zip([
        ...good,
        ...Array.from({ length: 9 }, (_, i) => ({
          name: `unused${i}.xml`,
          value: chunk,
        })),
      ]),
      "docx",
    ),
    /decoded size budget/,
  );
  await assert.rejects(
    extract(
      zip([
        ...good,
        ...Array.from({ length: 10001 }, (_, i) => ({
          name: `unused${i}.bin`,
          value: "",
        })),
      ]),
      "docx",
    ),
    /10,000 entries/,
  );
  const body = "<w:p><w:r><w:t>" + "🦉".repeat(500001) + "</w:t></w:r></w:p>";
  await assert.rejects(extract(zip(wordParts(body)), "docx"), /500,000/);
});
test("XLSX rejects invalid coordinates, duplicate identities, invalid string indexes and cells instead of silently inventing values", async () => {
  for (const cells of [
    '<row r="1"><c r="XFE1"><v>1</v></c></row>',
    '<row r="1"><c r="A2"><v>1</v></c></row>',
    '<row r="1"><c r="A1"/><c r="A1"/></row>',
    '<row r="1"><c r="A1" t="s"><v>99</v></c></row>',
    '<row r="1"><c r="A1" t="b"><v>2</v></c></row>',
    '<row r="1"><c r="A1"><v>PRIVATE_CANARY</v></c></row>',
  ])
    await assert.rejects(
      extract(zip(workbookParts(cells)), "xlsx"),
      (e: Error) => !e.message.includes("PRIVATE_CANARY"),
    );
});
test("XLSX resolves optional row/cell coordinates by stored sequence and keeps sparse explicit coordinates", async () => {
  const cells =
    '<row><c t="inlineStr"><is><t>First</t></is></c><c><v>12</v></c><c r="F1"><f t="shared" si="2">B1+1</f><v>13</v></c></row><row><c r="C3" t="inlineStr"><is><t>Sparse</t></is></c><c><f t="shared" si="2"/><v/></c></row>';
  const result = await extract(zip(workbookParts(cells)), "xlsx"),
    value = contents(result);
  assert.match(value, /A1 = Text: First\nB1 = Numeric: 12/);
  assert.match(
    value,
    /C3 \(hidden column\) = Text: Sparse\nD3 = Formula \(not executed\): shared group 2; definition at F1: B1\+1; Cached result unavailable/,
  );
  assert.doesNotMatch(value, /A2 =|B3 =/);
});
test("all five new formats extract through real isolated workers and settle cancellation/deadline", async () => {
  for (const fixture of imports) {
    const isolated = await extractIsolated(fixture.bytes, fixture.kind);
    assert.deepEqual(isolated, await extract(fixture.bytes, fixture.kind));
  }
  for (const kind of ["docx", "pptx", "xlsx", "csv", "tsv"]) {
    const controller = new AbortController();
    const pending = extractIsolated(
      imports.find((x) => x.kind === kind)!.bytes,
      kind,
      { signal: controller.signal },
    );
    controller.abort();
    await assert.rejects(pending, /cancelled/);
  }
  await assert.rejects(
    extractIsolated(wordFixture(), "docx", { timeoutMs: 1 }),
    /deadline/,
  );
});
test("Office/delimited immutable original bytes, Unicode evidence and exact citations survive restart, backup and purge", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-office-")),
    snap = root + "-backup",
    restored = root + "-restore";
  let store = new Store(root);
  try {
    const notebook = store.createNotebook("Office provenance").id,
      ids: string[] = [];
    const oldBytes = Buffer.from("Earlier extraction evidence"),
      oldJob = store.beginImport(notebook, "Earlier", "earlier-extraction");
    const oldSource = store.publishImport(
      notebook,
      oldJob.id,
      "Earlier",
      "text",
      null,
      oldBytes,
      await extract(oldBytes, "text"),
    );
    store.run(
      "UPDATE revisions SET extractor='2' WHERE source_id=?",
      oldSource,
    );
    for (const fixture of imports) {
      const job = store.beginImport(notebook, fixture.kind, fixture.kind, {
        kind: fixture.kind,
      });
      store.publishImport(
        notebook,
        job.id,
        fixture.kind,
        fixture.kind,
        null,
        fixture.bytes,
        await extract(fixture.bytes, fixture.kind),
      );
      ids.push(store.importJob(notebook, job.id).source_id);
    }
    const conversation = store.view(notebook).conversations[0].id;
    const passages = store.selectedPassages(notebook, conversation);
    const refs = ids.map((id) => {
      const passage = passages.find(
        (p) => p.sourceId === id && p.text.includes("🦉"),
      )!;
      const start = Array.from(
        passage.text.slice(0, passage.text.indexOf("🦉")),
      ).length;
      return { passageId: passage.id, start, end: start + 1, quote: "🦉" };
    });
    const answer: Answer = {
      status: "answered",
      title: "Unicode evidence",
      blocks: refs.map((ref) => ({
        kind: "fact",
        text: "🦉",
        citations: [ref],
      })),
      coverageWarnings: [],
    };
    // The fixture is controlled exact-span evidence, not a semantic human review.
    assert.ok(passages.every((p) => p.sourceId));
    assert.deepEqual(validateAnswer(answer, passages), answer);
    const run = store.createRun(
      notebook,
      conversation,
      "Who is named?",
      "answer",
      "fixture",
      "office-citation",
    );
    store.completeRun(run.id, answer);
    for (const [i, id] of ids.entries()) {
      const source = store.one(
          "SELECT current_revision FROM sources WHERE id=?",
          id,
        ),
        revision = store.one(
          "SELECT * FROM revisions WHERE id=?",
          source.current_revision,
        );
      assert.equal(revision.extractor, "7");
      assert.deepEqual(
        readFileSync(path.join(root, "blobs", revision.blob)),
        imports[i].bytes,
      );
    }
    store.close();
    backup(root, snap);
    restore(snap, restored);
    store = new Store(restored);
    assert.equal(
      store.one("SELECT extractor FROM revisions WHERE source_id=?", oldSource)
        .extractor,
      "2",
    );
    assert.deepEqual(
      store.selectedPassages(notebook, conversation).map((p) => p.text),
      passages.map((p) => p.text),
    );
    assert.deepEqual(
      validateAnswer(
        JSON.parse(
          store.one("SELECT output FROM runs WHERE id=?", run.id).output,
        ),
        store.selectedPassages(notebook, conversation),
      ),
      answer,
    );
    store.purgeSource(notebook, ids[0]);
    assert.equal(
      store
        .selectedPassages(notebook, conversation)
        .some((p) => p.sourceId === ids[0]),
      false,
    );
    const purged = store.one(
      "SELECT blob,sections,warnings FROM revisions WHERE source_id=?",
      ids[0],
    );
    assert.equal(purged.blob, null);
    assert.equal(purged.sections, "[]");
    assert.deepEqual(JSON.parse(purged.warnings), ["Evidence purged"]);
    assert.equal(
      store.one("SELECT output FROM runs WHERE id=?", run.id).output,
      null,
    );
  } finally {
    store.close();
    for (const p of [root, snap, restored])
      rmSync(p, { recursive: true, force: true });
  }
});
