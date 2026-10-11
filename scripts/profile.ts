import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { extractIsolated } from "../src/ingestion/service.ts";
import { Store } from "../src/storage/store.ts";
import { textPdf } from "../tests/fixtures/pdf.ts";

const output = path.resolve(".codeboom/profiling");
mkdirSync(output, { recursive: true });
const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-profile-"));
const store = new Store(root);
const nb = store.createNotebook("Synthetic resource profile").id;
const fixtures = [
  {
    name: "long-text",
    kind: "text",
    bytes: Buffer.from(
      "Evidence and qualifications must remain inspectable. 🦉\n".repeat(8500),
    ),
  },
  {
    name: "sectioned-markdown",
    kind: "markdown",
    bytes: Buffer.from(
      Array.from(
        { length: 200 },
        (_, index) =>
          `# Section ${index}\n` +
          "The pilot budget is provisional. Citations preserve qualifications.\n".repeat(
            25,
          ),
      ).join("\n"),
    ),
  },
  {
    name: "25-page-report",
    kind: "pdf",
    bytes: textPdf(
      Array.from({ length: 25 }, (_, index) => [
        `Report ${index + 1}`,
        "Database | Budget | Owner",
        "SQLite | 100 units | Morgan",
        ...Array.from(
          { length: 35 },
          (_, line) =>
            `Section ${line}: This synthetic report retains qualifications and page provenance.`,
        ),
      ]),
    ),
  },
  {
    name: "long-html-article",
    kind: "html",
    bytes: Buffer.from(
      "<html><body><article><h1>Research report</h1>" +
        "<p>The research pilot has a provisional budget and citations must retain relevant qualifications.</p>".repeat(
          3000,
        ) +
        "</article></body></html>",
    ),
  },
];
const results: unknown[] = [];
async function ingest(fixture: (typeof fixtures)[number], attempt: string) {
  const started = performance.now();
  let peakRssBytes = process.memoryUsage().rss;
  const baselineRssBytes = peakRssBytes;
  const timer = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }, 10);
  try {
    const extracted = await extractIsolated(fixture.bytes, fixture.kind);
    const extractionMs = performance.now() - started;
    const job = store.beginImport(nb, fixture.name, attempt);
    store.publishImport(
      nb,
      job.id,
      fixture.name,
      fixture.kind,
      null,
      fixture.bytes,
      extracted,
    );
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
    return {
      name: fixture.name,
      bytes: fixture.bytes.length,
      characters: extracted.sections.reduce(
        (sum, section) => sum + Array.from(section.text).length,
        0,
      ),
      sections: extracted.sections.length,
      extractionMs,
      ingestionMs: performance.now() - started,
      baselineRssBytes,
      peakRssBytes,
      warnings: extracted.warnings,
    };
  } finally {
    clearInterval(timer);
  }
}
try {
  for (const [index, fixture] of fixtures.entries())
    results.push(await ingest(fixture, "sequential-" + index));
  const concurrent = await Promise.all(
    fixtures
      .slice(0, 2)
      .map((fixture, index) => ingest(fixture, "concurrent-" + index)),
  );
  const report = {
    date: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    note: "Synthetic bounded corpus, 10 ms RSS sampling of the server process including extraction workers. Peak samples can miss short spikes. This is a baseline, not a guarantee or production-load qualification.",
    sequential: results,
    twoConcurrentImports: concurrent,
  };
  const destination = path.join(output, "results.json");
  writeFileSync(destination, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}
