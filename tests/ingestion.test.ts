import test from "node:test";
import assert from "node:assert/strict";
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
