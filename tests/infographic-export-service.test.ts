import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/store.ts";
import { extract } from "../src/ingestion/extract.ts";
import { exportInfographic } from "../src/domain/export-infographic.ts";
import { InfographicExportService } from "../src/server/infographic-export-service.ts";
import {
  infographicAnswer,
  infographicSourceText,
} from "./fixtures/infographic.ts";
async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-info-race-")),
    store = new Store(root),
    n = store.createNotebook("Images").id,
    c = store.view(n).conversations[0].id,
    job = store.beginImport(n, "Proposal", "seed"),
    bytes = Buffer.from(infographicSourceText);
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
    run = store.createRun(
      n,
      c,
      "Infographic",
      "infographic",
      "fixture",
      "seed",
    );
  store.completeRun(run.id, infographicAnswer(p));
  return {
    store,
    n,
    p,
    artifact: store.view(n).artifacts[0],
    close: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function controlled() {
  const entered = deferred(),
    release = deferred();
  let calls = 0;
  const requests: Parameters<typeof exportInfographic>[] = [];
  const assemble: typeof exportInfographic = async (...args) => {
    calls++;
    requests.push(args);
    const bytes = await exportInfographic(...args);
    entered.resolve();
    await release.promise;
    return bytes;
  };
  return { entered, release, assemble, requests, calls: () => calls };
}
test("actual image bytes are withheld when evidence is purged during export", async () => {
  const f = await fixture(),
    gate = controlled(),
    service = new InfographicExportService(f.store, gate.assemble);
  try {
    const output = service.export(f.n, f.artifact.id, undefined, "png"),
      refused = assert.rejects(output, /became unavailable/);
    await gate.entered.promise;
    f.store.purgeSource(f.n, f.p.sourceId);
    gate.release.resolve();
    await refused;
  } finally {
    gate.release.resolve();
    await service.shutdown();
    f.close();
  }
});
test("cancelled images keep capacity until settled and excess exports never queue", async () => {
  const f = await fixture(),
    gate = controlled(),
    service = new InfographicExportService(f.store, gate.assemble);
  try {
    const abort = new AbortController(),
      first = service.export(
        f.n,
        f.artifact.id,
        undefined,
        "png",
        abort.signal,
      ),
      refused = assert.rejects(first, /cancelled/),
      second = service.export(f.n, f.artifact.id, undefined, "svg");
    await gate.entered.promise;
    abort.abort();
    await assert.rejects(
      service.export(f.n, f.artifact.id, undefined, "svg"),
      /capacity is full/,
    );
    assert.equal(gate.calls(), 2);
    gate.release.resolve();
    await refused;
    assert.ok((await second).length > 1000);
    assert.ok(
      (await service.export(f.n, f.artifact.id, undefined, "png")).length >
        1000,
    );
    assert.equal(gate.calls(), 3);
  } finally {
    gate.release.resolve();
    await service.shutdown();
    f.close();
  }
});
test("image shutdown waits for real encoders and suppresses pending/new output", async () => {
  const f = await fixture(),
    gate = controlled(),
    service = new InfographicExportService(f.store, gate.assemble);
  try {
    const pending = service.export(f.n, f.artifact.id, undefined, "png"),
      refused = assert.rejects(pending, /cancelled/);
    await gate.entered.promise;
    let closed = false;
    const close = service.shutdown().then(() => {
      closed = true;
    });
    await assert.rejects(
      service.export(f.n, f.artifact.id, undefined, "svg"),
      /cancelled/,
    );
    await Promise.resolve();
    assert.equal(closed, false);
    gate.release.resolve();
    await refused;
    await close;
    assert.equal(closed, true);
  } finally {
    gate.release.resolve();
    await service.shutdown();
    f.close();
  }
});
test("image capture survives edits with exact historical revision and no storage writes", async () => {
  const f = await fixture(),
    gate = controlled(),
    service = new InfographicExportService(f.store, gate.assemble);
  try {
    const pending = service.export(
      f.n,
      f.artifact.id,
      f.artifact.revision_id,
      "svg",
    );
    await gate.entered.promise;
    f.store.editArtifact(f.n, f.artifact.id, "Changed", "My new annotation");
    const counts = () =>
        ["artifacts", "artifact_revisions", "sources", "revisions", "runs"].map(
          (t) => f.store.one(`SELECT count(*) AS count FROM ${t}`).count,
        ),
      before = counts();
    gate.release.resolve();
    const output = (await pending).toString();
    assert.ok(output.includes(f.artifact.revision_id));
    assert.ok(!output.includes("My new annotation"));
    assert.equal(gate.requests[0][3].revisionId, f.artifact.revision_id);
    assert.deepEqual(counts(), before);
    await assert.rejects(
      service.export(f.n, f.artifact.id, undefined, "png"),
      /available generated/,
    );
    assert.ok(
      (await service.export(f.n, f.artifact.id, f.artifact.revision_id, "png"))
        .length > 1000,
    );
  } finally {
    gate.release.resolve();
    await service.shutdown();
    f.close();
  }
});
test("pre-cancel, failures, foreign notebook and deletion release image capacity without bytes", async () => {
  const f = await fixture(),
    gate = controlled(),
    service = new InfographicExportService(f.store, gate.assemble);
  try {
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(
      service.export(f.n, f.artifact.id, undefined, "png", abort.signal),
      /cancelled/,
    );
    assert.equal(gate.calls(), 0);
    for (let i = 0; i < 3; i++)
      await assert.rejects(
        service.export("foreign", f.artifact.id, undefined, "svg"),
      );
    const output = service.export(f.n, f.artifact.id, undefined, "png"),
      refused = assert.rejects(output);
    await gate.entered.promise;
    f.store.deleteNotebook(f.n);
    gate.release.resolve();
    await refused;
  } finally {
    gate.release.resolve();
    await service.shutdown();
    f.close();
  }
  const another = await fixture();
  let calls = 0;
  const failing = new InfographicExportService(another.store, async () => {
    calls++;
    throw Error("Synthetic encoder failure");
  });
  try {
    for (let i = 0; i < 3; i++)
      await assert.rejects(
        failing.export(another.n, another.artifact.id, undefined, "png"),
        /Synthetic encoder/,
      );
    assert.equal(calls, 3);
  } finally {
    await failing.shutdown();
    another.close();
  }
});
