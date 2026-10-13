import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/store.ts";
import { extract } from "../src/ingestion/extract.ts";
import { exportPptx } from "../src/domain/export-pptx.ts";
import { SlideExportService } from "../src/server/slide-export-service.ts";
import { slideAnswer, slideSourceText } from "./fixtures/slides.ts";

async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-slide-export-"));
  const store = new Store(root),
    n = store.createNotebook("Export race").id,
    c = store.view(n).conversations[0].id;
  const job = store.beginImport(n, "Proposal", "seed"),
    bytes = Buffer.from(slideSourceText);
  store.publishImport(
    n,
    job.id,
    "Proposal",
    "text",
    null,
    bytes,
    await extract(bytes, "text"),
  );
  const p = store.selectedPassages(n, c)[0],
    run = store.createRun(n, c, "Slides", "slides", "fixture", "seed-run");
  store.completeRun(run.id, slideAnswer(p));
  const artifact = store.view(n).artifacts[0];
  return {
    store,
    n,
    p,
    artifact,
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
function controlledAssembly() {
  const entered = deferred(),
    release = deferred();
  let calls = 0;
  const requests: Parameters<typeof exportPptx>[] = [];
  const assemble: typeof exportPptx = async (...args) => {
    calls++;
    requests.push(args);
    const bytes = await exportPptx(...args);
    entered.resolve();
    await release.promise;
    return bytes;
  };
  return { entered, release, assemble, requests, calls: () => calls };
}

test("actual assembled PowerPoint is withheld if its evidence is purged before delivery", async () => {
  const f = await fixture(),
    gate = controlledAssembly(),
    service = new SlideExportService(f.store, gate.assemble);
  try {
    const output = service.export(f.n, f.artifact.id, f.artifact.revision_id);
    const refused = assert.rejects(output, /became unavailable/);
    await gate.entered.promise;
    f.store.purgeSource(f.n, f.p.sourceId);
    gate.release.resolve();
    await refused;
    assert.equal(
      f.store.artifactRevision(f.n, f.artifact.id, f.artifact.revision_id)
        .available,
      false,
    );
  } finally {
    gate.release.resolve();
    await service.shutdown();
    f.close();
  }
});

test("moving a note to Trash withholds assembled PowerPoint until restoration", async () => {
  const f = await fixture(),
    gate = controlledAssembly(),
    service = new SlideExportService(f.store, gate.assemble);
  try {
    const output = service.export(f.n, f.artifact.id, f.artifact.revision_id);
    const refused = assert.rejects(output, /Trash/);
    await gate.entered.promise;
    f.store.trashArtifact(f.n, f.artifact.id, f.artifact.revision_id, 0);
    gate.release.resolve();
    await refused;
    await assert.rejects(service.export(f.n, f.artifact.id), /Trash/);
    f.store.restoreTrashedArtifact(f.n, f.artifact.id, 1);
    assert.ok((await service.export(f.n, f.artifact.id)).length > 1000);
  } finally {
    gate.release.resolve();
    await service.shutdown();
    f.close();
  }
});

test("two exports hold capacity through cancellation, reject excess without queueing and then release it", async () => {
  const f = await fixture(),
    gate = controlledAssembly(),
    service = new SlideExportService(f.store, gate.assemble);
  try {
    const cancelled = new AbortController();
    const first = service.export(
      f.n,
      f.artifact.id,
      undefined,
      cancelled.signal,
    );
    const refused = assert.rejects(first, /cancelled/);
    const second = service.export(f.n, f.artifact.id);
    await gate.entered.promise;
    cancelled.abort();
    await assert.rejects(
      service.export(f.n, f.artifact.id),
      /capacity is full/,
    );
    assert.equal(gate.calls(), 2);
    gate.release.resolve();
    await refused;
    assert.ok((await second).length > 1000);
    assert.ok((await service.export(f.n, f.artifact.id)).length > 1000);
    assert.equal(gate.calls(), 3, "the refused request was never queued");
  } finally {
    gate.release.resolve();
    await service.shutdown();
    f.close();
  }
});

test("shutdown withholds pending exports, waits for assembly and prevents new requests", async () => {
  const f = await fixture(),
    gate = controlledAssembly(),
    service = new SlideExportService(f.store, gate.assemble);
  try {
    const output = service.export(f.n, f.artifact.id),
      refused = assert.rejects(output, /cancelled/);
    await gate.entered.promise;
    let settled = false;
    const closing = service.shutdown().then(() => {
      settled = true;
    });
    await assert.rejects(service.export(f.n, f.artifact.id), /shutting down/);
    await Promise.resolve();
    assert.equal(settled, false);
    gate.release.resolve();
    await refused;
    await closing;
    assert.equal(settled, true);
  } finally {
    gate.release.resolve();
    await service.shutdown();
    f.close();
  }
});

test("edits during assembly preserve the captured generated revision and cause no export writes", async () => {
  const f = await fixture(),
    gate = controlledAssembly(),
    service = new SlideExportService(f.store, gate.assemble);
  try {
    const output = service.export(f.n, f.artifact.id, f.artifact.revision_id);
    await gate.entered.promise;
    f.store.editArtifact(f.n, f.artifact.id, "Authored edit", "My new note");
    const counts = () =>
      ["artifacts", "artifact_revisions", "sources", "revisions", "runs"].map(
        (table) => f.store.one(`SELECT count(*) AS count FROM ${table}`).count,
      );
    const before = counts();
    gate.release.resolve();
    assert.ok((await output).length > 1000);
    assert.equal(gate.requests[0][0], f.artifact.title);
    assert.equal(gate.requests[0][1].kind, "slides");
    assert.equal(gate.requests[0][3].revisionId, f.artifact.revision_id);
    assert.deepEqual(counts(), before);
    assert.equal(f.store.view(f.n).artifacts[0].content.text, "My new note");
    await assert.rejects(
      service.export(f.n, f.artifact.id),
      /available generated/,
    );
  } finally {
    gate.release.resolve();
    await service.shutdown();
    f.close();
  }
});

test("pre-cancel, assembly failure and deletion refuse bytes while releasing capacity", async () => {
  const f = await fixture(),
    gate = controlledAssembly(),
    service = new SlideExportService(f.store, gate.assemble);
  try {
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(
      service.export(f.n, f.artifact.id, undefined, cancelled.signal),
      /cancelled/,
    );
    assert.equal(gate.calls(), 0);
    for (let attempt = 0; attempt < 3; attempt++)
      await assert.rejects(service.export("foreign", f.artifact.id));
    const output = service.export(f.n, f.artifact.id),
      refused = assert.rejects(output);
    await gate.entered.promise;
    f.store.deleteNotebook(f.n);
    gate.release.resolve();
    await refused;
    assert.equal(gate.calls(), 1);
  } finally {
    gate.release.resolve();
    await service.shutdown();
    f.close();
  }
  const another = await fixture();
  let calls = 0;
  const failing = new SlideExportService(another.store, async () => {
    calls++;
    throw Error("Synthetic assembly failure");
  });
  try {
    for (let attempt = 0; attempt < 3; attempt++)
      await assert.rejects(
        failing.export(another.n, another.artifact.id),
        /Synthetic assembly failure/,
      );
    assert.equal(calls, 3);
  } finally {
    await failing.shutdown();
    another.close();
  }
});
