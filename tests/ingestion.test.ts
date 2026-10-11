import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extract } from "../src/ingestion/extract.ts";
import { extractIsolated } from "../src/ingestion/service.ts";
import { publicAddress, fetchPublic } from "../src/ingestion/url.ts";
test("only public unicast IP addresses pass the URL boundary", () => {
  for (const ip of [
    "127.0.0.1",
    "::1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "172.16.0.1",
    "0.0.0.0",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "224.0.0.1",
    "100.64.1.1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("1.1.1.1"), true);
});
test("URLs reject loopback, encoded loopback, credentials and unsupported schemes", async () => {
  for (const url of [
    "http://127.0.0.1",
    "http://2130706433",
    "http://[::1]",
    "http://a:b@example.com",
    "file:///etc/passwd",
  ])
    await assert.rejects(fetchPublic(url));
});
test("Markdown preserves sections, CRLF normalizes, and empty/binary input fails", async () => {
  const result = await extract(
    Buffer.from("# One\r\nA\r\n# Two\r\nB"),
    "markdown",
  );
  assert.deepEqual(
    result.sections.map((s) => s.locator),
    ["One", "Two"],
  );
  await assert.rejects(extract(Buffer.from("   "), "text"));
  await assert.rejects(extract(Buffer.from("hello\0world"), "text"));
});
test("HTML extraction retains article text and does not execute scripts", async () => {
  const html =
    "<html><head><title>Fixture</title></head><body><article><h1>Fixture</h1>" +
    "<p>Evidence belongs in a notebook. This paragraph explains how to understand a source and keep its provenance.</p>".repeat(
      8,
    ) +
    '</article><script>throw new Error("EXECUTED")</script></body></html>';
  const r = await extract(Buffer.from(html), "html");
  assert.match(r.sections[0].text, /Evidence belongs/);
  assert.ok(!r.sections[0].text.includes("EXECUTED"));
});
test("very long Markdown headings keep full evidence without multiplying locator size", async () => {
  const heading = "🦉".repeat(12000);
  const text = "# " + heading + "\nFull heading evidence.";
  const result = await extract(Buffer.from(text), "markdown");
  assert.equal(result.sections[0].text, text);
  assert.equal(Array.from(result.sections[0].locator).length, 256);
  assert.equal(result.sections[0].locator.endsWith("…"), true);
  assert.match(result.warnings[0], /complete headings remain/);
});
test("isolated parser diagnostics do not forward document canaries to application output", async () => {
  const script = `import {extractIsolated} from './src/ingestion/service.ts';
    try { await extractIsolated(Buffer.from('%PDF-SRC42XY\\n'), 'pdf'); }
    catch(error) { console.log('IMPORT_FAILED: ' + error.message); }`;
  const control = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs'; const task=getDocument({data:new Uint8Array(Buffer.from('%PDF-SRC42XY\\n'))});try{await task.promise}catch{}finally{await task.destroy()}`,
    ],
    { cwd: process.cwd() },
  );
  assert.match(control.stdout + control.stderr, /SRC42XY/);
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { cwd: process.cwd() },
  );
  assert.match(stdout, /IMPORT_FAILED/);
  assert.doesNotMatch(stdout + stderr, /SRC42XY/);
});
test("isolated extraction worker handles a real text import", async () => {
  const result = await extractIsolated(
    Buffer.from("Worker evidence 🦉"),
    "text",
  );
  assert.equal(result.sections[0].text, "Worker evidence 🦉");
});
function pdf(text: string) {
  const stream = "BT /F1 12 Tf 72 720 Td (" + text + ") Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Length " + stream.length + " >>\nstream\n" + stream + "\nendstream",
  ];
  let data = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(data));
    data += i + 1 + " 0 obj\n" + o + "\nendobj\n";
  });
  const start = Buffer.byteLength(data);
  data +=
    "xref\n0 6\n0000000000 65535 f \n" +
    offsets
      .slice(1)
      .map((x) => String(x).padStart(10, "0") + " 00000 n \n")
      .join("") +
    "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" +
    start +
    "\n%%EOF";
  return Buffer.from(data);
}
test("text PDF extraction preserves page locator and rejects pages with no text", async () => {
  const result = await extract(pdf("PDF source evidence"), "pdf");
  assert.equal(result.sections[0].locator, "Page 1");
  assert.match(result.sections[0].text, /PDF source evidence/);
  await assert.rejects(extract(pdf(""), "pdf"), /No usable text/);
});

test("malformed UTF-8, hostile binary and extraction size limits fail explicitly", async () => {
  await assert.rejects(
    extract(Buffer.from([0xc3, 0x28]), "text"),
    /encoded data/,
  );
  await assert.rejects(
    extract(Buffer.alloc(25 * 1024 * 1024 + 1), "text"),
    /25 MiB/,
  );
  await assert.rejects(
    extract(Buffer.from("🦉".repeat(500001)), "text"),
    /500,000/,
  );
  const unicode = await extract(Buffer.from("e\u0301\r\n🦉"), "text");
  assert.equal(unicode.sections[0].text, "é\n🦉");
  await assert.rejects(extract(Buffer.from("%PDF-broken"), "pdf"));
});

import { textPdf } from "./fixtures/pdf.ts";
test("multi-page PDF retains ordered page text, headings and tabular evidence", async () => {
  const pages = Array.from({ length: 12 }, (_, index) => [
    `Report page ${index + 1}`,
    "Database | Budget | Delivery",
    `SQLite | ${100 + index} units | October ${index + 1}`,
    "A paragraph about citations and reproducible source evidence.",
    "Appendix (qualifiers): budgets are provisional, not commitments.",
  ]);
  const result = await extractIsolated(textPdf(pages), "pdf");
  assert.equal(result.sections.length, pages.length);
  assert.deepEqual(result.warnings, []);
  for (const [index, page] of pages.entries()) {
    assert.equal(result.sections[index].locator, `Page ${index + 1}`);
    for (const line of page)
      assert.ok(result.sections[index].text.includes(line), line);
    assert.ok(
      result.sections[index].text.indexOf(page[0]) <
        result.sections[index].text.indexOf(page[4]),
    );
  }
});

test("HTML keeps qualifiers and Unicode but excludes executable and navigational content", async () => {
  const paragraphs = Array.from(
    { length: 8 },
    (_, index) =>
      `<p>Finding ${index}: Evidence 🦉 supports the pilot, subject to review and a provisional budget. This is a synthetic research article with enough context for extraction.</p>`,
  );
  const html = `<html><head><title>Qualified report</title></head><body><nav>UNRELATED_NAVIGATION</nav><article><h1>Qualified report</h1>${paragraphs.join("")}<script>EXECUTABLE_PAYLOAD</script><iframe src="http://127.0.0.1/private"></iframe></article></body></html>`;
  const result = await extractIsolated(Buffer.from(html), "html");
  const text = result.sections.map((s) => s.text).join("\n");
  for (let index = 0; index < 8; index++)
    assert.ok(text.includes(`Finding ${index}: Evidence 🦉`));
  assert.ok(text.includes("subject to review and a provisional budget"));
  assert.ok(!text.includes("EXECUTABLE_PAYLOAD"));
  assert.ok(!text.includes("UNRELATED_NAVIGATION"));
});
