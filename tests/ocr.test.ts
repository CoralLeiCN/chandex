import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Worker } from "node:worker_threads";
import { createCanvas } from "@napi-rs/canvas";
import { extract } from "../src/ingestion/extract.ts";
import { EXTRACTION_VERSION } from "../src/ingestion/version.ts";
import {
  createIsolatedExtractor,
  extractIsolated,
} from "../src/ingestion/service.ts";
import {
  checkDimensions,
  imageDimensions,
  confidenceWarning,
} from "../src/ingestion/ocr.ts";
import { OcrBudget } from "../src/ingestion/pdf.ts";
import {
  fileAccept,
  fileType,
  importKinds,
} from "../src/domain/source-types.ts";
import {
  scanImage,
  scanPdf,
  scanLines,
  exifRotatedJpeg,
} from "./fixtures/ocr.ts";
import { textPdf } from "./fixtures/pdf.ts";
import { Store } from "../src/storage/store.ts";
import { NotebookService } from "../src/server/service.ts";
import { backup, restore } from "../src/storage/backup.ts";
import { validateAnswer, type Answer } from "../src/domain/evidence.ts";

const containsScan = (text: string) =>
  scanLines.forEach((line) =>
    assert.ok(text.includes(line), JSON.stringify(text)),
  );
test("local English OCR retains numbers, qualifications and dates in PNG/JPEG/WebP, noisy and EXIF-oriented scans", async () => {
  for (const bytes of [
    scanImage(),
    scanImage("jpeg"),
    scanImage("webp"),
    scanImage("png", true),
    exifRotatedJpeg(),
  ]) {
    const result = await extractIsolated(bytes, "image");
    assert.equal(result.sections.length, 1);
    assert.equal(result.sections[0].locator, "Image 1 · OCR");
    containsScan(result.sections[0].text);
    assert.match(
      result.warnings.join(" "),
      /Tesseract core 6\.1\.2.*English model 1\.0\.0.*not an accuracy guarantee/,
    );
    assert.match(result.warnings[1], /confidence \d+\/100/);
  }
  assert.match(confidenceWarning("Image 1", 35), /low; review carefully/);
  assert.match(confidenceWarning("Image 1", NaN), /unavailable/);
  for (const extension of ["png", "jpg", "jpeg", "webp"]) {
    assert.ok(fileAccept.includes("." + extension));
    assert.equal(fileType("SCAN." + extension.toUpperCase())?.kind, "image");
  }
  assert.ok(importKinds.includes("image"));
});
test("scanned and mixed PDFs retain page order, native text, OCR warnings and explicit white-page omissions", async () => {
  const result = await extractIsolated(
    scanPdf([
      {},
      { native: "Native heading" },
      { blank: true },
      { lines: ["Final budget: 300 units.", "Approval remains pending."] },
    ]),
    "pdf",
  );
  assert.deepEqual(
    result.sections.map((s) => s.locator),
    ["Page 1 · OCR", "Page 2 · Text layer", "Page 2 · OCR", "Page 4 · OCR"],
  );
  containsScan(result.sections[0].text);
  assert.equal(result.sections[1].text, "Native heading");
  assert.match(result.sections[2].text, /Native heading/);
  containsScan(result.sections[2].text);
  assert.match(result.sections[3].text, /Final budget: 300 units/);
  assert.match(
    result.warnings.join(" "),
    /repeated text.*Page 3: rendered page is entirely white/,
  );
  const native = await extractIsolated(
    textPdf([["Ordinary text"], [], ["Final qualifier"]]),
    "pdf",
  );
  assert.deepEqual(
    native.sections.map((s) => s.locator),
    ["Page 1", "Page 3"],
  );
  assert.deepEqual(native.warnings, [
    "Page 2: rendered page is entirely white; no OCR text added.",
  ]);
});
test("invalid, animated, unsupported, empty and oversized raster inputs fail before publication with fixed diagnostics", async () => {
  const corruptChecksum = Buffer.from(scanImage());
  corruptChecksum[29] ^= 1;
  const oversized = Buffer.from(scanImage());
  oversized.writeUInt32BE(8001, 16);
  const oversizedArea = Buffer.from(scanImage());
  oversizedArea.writeUInt32BE(5000, 16);
  oversizedArea.writeUInt32BE(5000, 20);
  const chunk = Buffer.alloc(20);
  chunk.writeUInt32BE(8);
  chunk.write("acTL", 4);
  const animated = Buffer.concat([
    scanImage().subarray(0, 33),
    chunk,
    scanImage().subarray(33),
  ]);
  const animatedWebp = Buffer.from(scanImage("webp"));
  // WebP with a VP8X chunk must reject its animation flag before decode.
  const extended = Buffer.alloc(18);
  extended.write("VP8X");
  extended.writeUInt32LE(10, 4);
  extended[8] = 2;
  extended.writeUIntLE(1099, 12, 3);
  extended.writeUIntLE(299, 15, 3);
  const webp = Buffer.concat([
    animatedWebp.subarray(0, 12),
    extended,
    animatedWebp.subarray(12),
  ]);
  webp.writeUInt32LE(webp.length - 8, 4);
  const blank = createCanvas(100, 100),
    ctx = blank.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 100, 100);
  for (const [bytes, pattern] of [
    [corruptChecksum, /checksum/],
    [oversized, /8,000/],
    [oversizedArea, /12 million/],
    [animated, /Animated/],
    [webp, /Animated/],
    [scanImage().subarray(0, 50), /Truncated|Malformed/],
    [blank.toBuffer("image/png"), /No usable text/],
    [
      Buffer.from('<svg><image href="http://127.0.0.1/PRIVATE_CANARY"/></svg>'),
      /Unsupported image/,
    ],
    [Buffer.from("GIF89aPRIVATE_CANARY"), /Unsupported image/],
    [Buffer.from([255, 216, 255, 192, 0, 255]), /Malformed/],
  ] as const)
    await assert.rejects(
      extract(bytes, "image"),
      (error: Error) =>
        pattern.test(error.message) &&
        !error.message.includes("PRIVATE_CANARY"),
    );
  for (const dims of [
    [0, 1],
    [NaN, 2],
    [8001, 1],
    [4000, 4000],
  ])
    assert.throws(() => checkDimensions(dims[0], dims[1]));
  assert.deepEqual(imageDimensions(exifRotatedJpeg()), {
    width: 300,
    height: 1100,
  });
});
test("PDF render/page/pixel budgets and nonblank OCR failures reject the whole extraction", async () => {
  await assert.rejects(
    extractIsolated(
      scanPdf([{ blank: true, width: 5000, height: 100 }]),
      "pdf",
    ),
    /8,000/,
  );
  await assert.rejects(
    extractIsolated(
      scanPdf([
        { imageWidth: 5000, imageHeight: 5000 },
        { native: "Valid later text" },
      ]),
      "pdf",
    ),
    /recovery|oversized image/,
  );
  await assert.rejects(
    extractIsolated(
      scanPdf(
        Array.from({ length: 21 }, () => ({
          blank: true,
          width: 20,
          height: 20,
        })),
      ),
      "pdf",
    ),
    /twenty/,
  );
  await assert.rejects(
    extractIsolated(
      scanPdf(
        Array.from({ length: 7 }, () => ({
          blank: true,
          width: 1500,
          height: 1500,
        })),
      ),
      "pdf",
    ),
    /sixty million/,
  );
  // A short horizontal stroke is nonwhite without being usable English text.
  await assert.rejects(
    extractIsolated(scanPdf([{}, { lines: ["________________"] }]), "pdf"),
    /nonblank page/,
  );
  await assert.rejects(
    extractIsolated(scanPdf([{ blank: true }]), "pdf"),
    /No usable text/,
  );
  const budget = new OcrBudget();
  for (let i = 0; i < 5; i++) budget.add(3000, 4000);
  assert.throws(() => budget.add(1, 1), /sixty million/);
});
test("OCR workers use only bundled assets, keep diagnostics private and terminate on cancellation/deadline", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-ocr-offline-"));
  try {
    const guard = path.join(root, "guard.mjs");
    writeFileSync(
      guard,
      `import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
      const forbidden = () => { throw new Error('RUNTIME_NETWORK_FORBIDDEN'); };
      globalThis.fetch=forbidden; http.request=https.request=http.get=https.get=forbidden; net.Socket.prototype.connect=forbidden;`,
    );
    let diagnostics = "",
      terminated = 0;
    const terminations: Promise<number>[] = [];
    const guarded = createIsolatedExtractor((bytes, kind) => {
      const worker = new Worker(
        new URL("../src/ingestion/worker.ts", import.meta.url),
        {
          workerData: { bytes, kind },
          execArgv: ["--import", "tsx", "--import", guard],
          resourceLimits: { maxOldGenerationSizeMb: 256 },
          stdout: true,
          stderr: true,
        },
      );
      worker.stdout.on("data", (data) => (diagnostics += data));
      worker.stderr.on("data", (data) => (diagnostics += data));
      const terminate = worker.terminate.bind(worker);
      worker.terminate = () => {
        terminated++;
        const completion = terminate();
        terminations.push(completion);
        return completion;
      };
      return worker;
    });
    containsScan((await guarded(scanImage(), "image")).sections[0].text);
    containsScan((await guarded(scanPdf([{}]), "pdf")).sections[0].text);
    assert.equal(terminated, 2);
    assert.doesNotMatch(
      diagnostics,
      /Pilot budget|Approval remains|RUNTIME_NETWORK_FORBIDDEN/,
    );
    const controller = new AbortController();
    const pending = guarded(scanPdf([{}, {}, {}, {}]), "pdf", {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, /cancelled/);
    await assert.rejects(
      guarded(scanImage(), "image", { timeoutMs: 1 }),
      /deadline/,
    );
    assert.equal(terminated, 4);
    containsScan((await guarded(scanImage("jpeg"), "image")).sections[0].text);
    await Promise.all(terminations);
    assert.equal(terminations.length, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("OCR source imports preserve immutable originals, exact spans, duplicates, failed retries, backup and purge", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-ocr-lifecycle-")),
    snap = root + "-backup",
    restored = root + "-restore";
  let store = new Store(root);
  const codex = {
    run: async () => {
      throw new Error("OCR must not invoke generation");
    },
    status: async () => ({}),
  } as any;
  let service = new NotebookService(store, codex);
  try {
    const n = store.createNotebook("OCR provenance").id,
      conversation = store.view(n).conversations[0].id;
    const bytes = scanImage(),
      job = store.beginImport(n, "Scan.png", "ocr-first", { kind: "image" });
    await service.import(n, job.id, {
      title: "Scan.png",
      kind: "image",
      bytes,
    });
    const record = store.importJob(n, job.id);
    assert.equal(record.status, "completed");
    const source = record.source_id,
      first = store.one("SELECT * FROM revisions WHERE source_id=?", source);
    assert.equal(first.extractor, EXTRACTION_VERSION);
    assert.deepEqual(store.sourceOriginal(n, source, first.id), bytes);
    const originalPath = path.join(root, "blobs", first.blob);
    writeFileSync(originalPath, Buffer.from("Corrupt snapshot"));
    assert.throws(() => store.sourceOriginal(n, source, first.id), /integrity/);
    writeFileSync(originalPath, bytes);
    assert.deepEqual(readFileSync(path.join(root, "blobs", first.blob)), bytes);
    const passages = store.selectedPassages(n, conversation),
      p = passages[0],
      quote = "Approval remains pending.",
      start = Array.from(p.text.slice(0, p.text.indexOf(quote))).length;
    const answer: Answer = {
      status: "answered",
      title: "Pending approval",
      blocks: [
        {
          kind: "fact",
          text: quote,
          citations: [
            {
              passageId: p.id,
              quote,
              start,
              end: start + Array.from(quote).length,
            },
          ],
        },
      ],
      coverageWarnings: [],
    };
    validateAnswer(answer, passages);
    assert.match(p.warnings!.join(" "), /English.*engine estimate/);
    const run = store.createRun(
      n,
      conversation,
      "Is approval final?",
      "answer",
      "fixture",
      "ocr-citation",
    );
    store.completeRun(run.id, answer);
    const note = store.saveArtifact(
      n,
      "OCR result",
      "note",
      JSON.stringify(answer),
      false,
      run.id,
    );
    const duplicate = store.beginImport(n, "Same.png", "ocr-duplicate", {
      kind: "image",
    });
    await service.import(n, duplicate.id, {
      title: "Same.png",
      kind: "image",
      bytes,
    });
    assert.equal(store.importJob(n, duplicate.id).status, "duplicate");
    store.resolveDuplicate(n, duplicate.id, "reuse");
    assert.equal(store.view(n).sources.length, 1);
    const bad = store.beginImport(n, "Broken", "ocr-bad", { kind: "pdf" });
    await service.import(n, bad.id, {
      title: "Broken",
      kind: "pdf",
      bytes: scanPdf([{}, { lines: ["________________"] }]),
    });
    assert.equal(store.importJob(n, bad.id).status, "failed");
    assert.equal(store.all("SELECT * FROM revisions").length, 1);
    const retry = store.beginImport(
      n,
      "Scanned PDF",
      "ocr-retry",
      { kind: "pdf" },
      bad.id,
    );
    await service.import(n, retry.id, {
      title: "Scanned PDF",
      kind: "pdf",
      bytes: scanPdf([{ native: "Heading" }]),
    });
    assert.equal(store.importJob(n, retry.id).status, "completed");
    assert.equal(store.importJob(n, retry.id).retry_of, bad.id);
    const other = store.createNotebook("Other").id;
    assert.throws(() => store.passage(other, p.id), /unavailable/);
    assert.throws(
      () => store.sourceOriginal(other, source, first.id),
      /unavailable/,
    );
    const refresh = store.beginImport(n, "Changed scan", "ocr-refresh", {
      kind: "image",
      sourceId: source,
    });
    await service.import(n, refresh.id, {
      title: "Changed scan",
      kind: "image",
      sourceId: source,
      bytes: scanImage("jpeg"),
    });
    assert.equal(store.importJob(n, refresh.id).status, "completed");
    assert.equal(
      store.one(
        "SELECT count(*) AS count FROM revisions WHERE source_id=?",
        source,
      ).count,
      2,
    );
    assert.deepEqual(store.sourceOriginal(n, source, first.id), bytes);
    assert.equal(store.passage(n, p.id)!.text, p.text);
    assert.deepEqual(validateAnswer(answer, [store.passage(n, p.id)!]), answer);
    service.shutdown();
    store.close();
    backup(root, snap);
    restore(snap, restored);
    store = new Store(restored);
    service = new NotebookService(store, codex);
    assert.equal(store.passage(n, p.id)!.extractionVersion, EXTRACTION_VERSION);
    assert.deepEqual(
      readFileSync(path.join(restored, "blobs", first.blob)),
      bytes,
    );
    assert.equal(store.one("SELECT count(*) AS count FROM runs").count, 1);
    store.purgeSource(n, source);
    assert.throws(() => store.passage(n, p.id), /unavailable/);
    assert.throws(
      () => store.sourceOriginal(n, source, first.id),
      /unavailable/,
    );
    assert.equal(
      store.one("SELECT unavailable FROM artifacts WHERE id=?", note)
        .unavailable,
      1,
    );
    assert.ok(
      store
        .all(
          "SELECT blob,sections,warnings FROM revisions WHERE source_id=?",
          source,
        )
        .every(
          (r) =>
            r.blob === null &&
            r.sections === "[]" &&
            r.warnings === '["Evidence purged"]',
        ),
    );
  } finally {
    service.shutdown();
    store.close();
    for (const dir of [root, snap, restored])
      rmSync(dir, { recursive: true, force: true });
  }
});
