import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/store.ts";
import { extract } from "../src/ingestion/extract.ts";
import { EXTRACTION_VERSION } from "../src/ingestion/version.ts";
import { exportMarkdown } from "../src/domain/export.ts";
import {
  validateAnswer,
  OUTPUT_CONTRACT_VERSION,
  type Answer,
} from "../src/domain/evidence.ts";
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-"));
  const store = new Store(root);
  return {
    store,
    root,
    cleanup() {
      this.store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function add(
  store: Store,
  n: string,
  text: string,
  key = "import-key",
  sourceId?: string,
  origin: string | null = null,
) {
  const job = store.beginImport(n, "Source", key);
  const extracted = await extract(Buffer.from(text), "text");
  return store.publishImport(
    n,
    job.id,
    "Source",
    "text",
    origin,
    Buffer.from(text),
    extracted,
    sourceId,
  );
}
function answer(p: any): Answer {
  return {
    status: "answered",
    title: "Answer",
    blocks: [
      {
        text: p.text,
        kind: "fact",
        citations: [
          {
            passageId: p.id,
            quote: p.text,
            start: 0,
            end: Array.from(p.text).length,
          },
        ],
      },
    ],
    coverageWarnings: [],
  };
}
test("imports and citations survive restart; revisions are immutable; duplicates reuse sources", async () => {
  const f = fixture();
  try {
    const n = f.store.createNotebook("Research").id,
      c = f.store.view(n).conversations[0].id;
    const s = await add(
      f.store,
      n,
      "Original evidence 🦉",
      "import-key",
      undefined,
      "https://example.com/old",
    );
    assert.equal(
      await add(
        f.store,
        n,
        "Original evidence 🦉",
        "retry",
        undefined,
        "https://example.com/old",
      ),
      s,
    );
    const old = f.store.selectedPassages(n, c)[0];
    const run = f.store.createRun(
      n,
      c,
      "Question",
      "answer",
      "fixture",
      "version-check",
    );
    assert.equal(run.schema_version, OUTPUT_CONTRACT_VERSION);
    f.store.run("UPDATE runs SET status='cancelled' WHERE id=?", run.id);
    await add(
      f.store,
      n,
      "Updated evidence",
      "refresh",
      s,
      "https://example.com/new",
    );
    const selected = f.store.selectedPassages(n, c);
    assert.equal(f.store.search(selected, "Updated", 5)[0].id, selected[0].id);
    assert.deepEqual(f.store.search(selected, "Original", 5), []);
    assert.equal(f.store.passage(n, old.id).origin, "https://example.com/old");
    assert.equal(selected[0].origin, "https://example.com/new");
    assert.equal(f.store.passage(n, old.id).text, "Original evidence 🦉");
    assert.notEqual(
      f.store.selectedPassages(n, c)[0].revisionId,
      old.revisionId,
    );
    f.store.close();
    f.store = new Store(f.root);
    assert.equal(f.store.passage(n, old.id).text, "Original evidence 🦉");
    assert.equal(f.store.view(n).sources.length, 1);
  } finally {
    f.cleanup();
  }
});
test("instruction versions and snapshots survive edits, no-op saves and restart", async () => {
  const f = fixture();
  try {
    const n = f.store.createNotebook("A").id,
      c = f.store.view(n).conversations[0].id;
    const created = f.store.notebook(n);
    assert.equal(created.instruction_version, 1);
    assert.equal(created.updated, created.created);
    await add(f.store, n, "Evidence");
    f.store.updateNotebook(n, { instructions: "Audience A" });
    const first = f.store.createRun(
      n,
      c,
      "Question",
      "answer",
      "",
      "version-one",
    );
    assert.equal(first.instruction_version, 2);
    assert.equal(first.instruction_snapshot, "Audience A");
    assert.equal(first.grounding_mode, "sources");
    const before = f.store.notebook(n);
    const unchanged = f.store.updateNotebook(n, {
      title: before.title,
      instructions: before.instructions,
      archived: false,
    });
    assert.deepEqual(unchanged, before);
    assert.equal(f.store.active(first.id), true);
    f.store.updateNotebook(n, { title: "Renamed", archived: true });
    assert.equal(f.store.active(first.id), true);
    assert.equal(f.store.notebook(n).instruction_version, 2);
    assert.equal(
      f.store.completeRun(first.id, answer(f.store.selectedPassages(n, c)[0])),
      true,
    );
    f.store.updateNotebook(n, { instructions: "Audience B" });
    const queued = f.store.createRun(
      n,
      c,
      "Queued question",
      "answer",
      "",
      "version-two",
    );
    f.store.updateNotebook(n, { instructions: "Audience A" });
    assert.equal(
      f.store.one("SELECT status FROM runs WHERE id=?", queued.id).status,
      "cancelled",
    );
    assert.equal(f.store.notebook(n).instruction_version, 4);
    f.store.close();
    f.store = new Store(f.root);
    assert.equal(f.store.notebook(n).instruction_version, 4);
    assert.equal(
      f.store.one("SELECT instruction_snapshot FROM runs WHERE id=?", first.id)
        .instruction_snapshot,
      "Audience A",
    );
    assert.equal(
      f.store.one("SELECT instruction_snapshot FROM runs WHERE id=?", queued.id)
        .instruction_snapshot,
      "Audience B",
    );
    assert.equal(
      f.store.one("SELECT instruction_version FROM runs WHERE id=?", queued.id)
        .instruction_version,
      3,
    );
    assert.equal(
      f.store.view(n).messages.filter((m: any) => m.role === "assistant")
        .length,
      1,
    );
  } finally {
    f.cleanup();
  }
});

test("cross-notebook source, passage and idempotency access is rejected", async () => {
  const f = fixture();
  try {
    const a = f.store.createNotebook("A").id,
      b = f.store.createNotebook("B").id;
    const c = f.store.view(a).conversations[0].id,
      s = await add(f.store, b, "Private B");
    const p = f.store.selectedPassages(
      b,
      f.store.view(b).conversations[0].id,
    )[0];
    assert.throws(() => f.store.passage(a, p.id));
    assert.throws(() => f.store.setSelection(a, c, [s]));
    assert.throws(() => f.store.beginImport(a, "Reuse", "import-key"));
    assert.deepEqual(
      f.store.search(f.store.selectedPassages(a, c), "Private", 5),
      [],
    );
  } finally {
    f.cleanup();
  }
});
test("cancel or context mutation wins completion race and active requests are idempotent", async () => {
  const f = fixture();
  try {
    const n = f.store.createNotebook("A").id,
      c = f.store.view(n).conversations[0].id;
    await add(f.store, n, "Evidence");
    const r = f.store.createRun(n, c, "Question", "answer", "", "run-key"),
      p = f.store.selectedPassages(n, c)[0];
    assert.equal(
      f.store.createRun(n, c, "Question", "answer", "", "run-key").id,
      r.id,
    );
    assert.throws(() =>
      f.store.createRun(n, c, "Second", "answer", "", "other-key"),
    );
    f.store.setSelection(n, c, []);
    assert.equal(f.store.completeRun(r.id, answer(p)), false);
    assert.equal(
      f.store.view(n).messages.filter((m: any) => m.role === "assistant")
        .length,
      0,
    );
  } finally {
    f.cleanup();
  }
});
test("purge removes original, index, citation quotes, and generated artifacts but preserves edited notes", async () => {
  const f = fixture();
  try {
    const n = f.store.createNotebook("A").id,
      c = f.store.view(n).conversations[0].id,
      s = await add(f.store, n, "PURGE_ME_EVIDENCE");
    const p = f.store.selectedPassages(n, c)[0],
      r = f.store.createRun(n, c, "Question", "answer", "", "run");
    f.store.completeRun(r.id, answer(p));
    const a = f.store.saveArtifact(
      n,
      "Saved",
      "note",
      JSON.stringify(answer(p)),
      false,
      r.id,
    );
    const edited = f.store.saveArtifact(
      n,
      "Edited",
      "note",
      JSON.stringify(answer(p)),
      false,
      r.id,
    );
    f.store.editArtifact(n, edited, "Mine", "My own note");
    f.store.purgeSource(n, s);
    assert.throws(() => f.store.passage(n, p.id));
    assert.equal(f.store.all("SELECT * FROM passage_fts").length, 0);
    assert.equal(
      f.store.one("SELECT blob FROM revisions WHERE id=?", p.revisionId).blob,
      null,
    );
    assert.ok(!JSON.stringify(f.store.view(n)).includes("PURGE_ME_EVIDENCE"));
    assert.equal(
      JSON.parse(
        f.store.one("SELECT content FROM artifacts WHERE id=?", edited).content,
      ).text,
      "My own note",
    );
    f.store.deleteNotebook(n);
    assert.equal(f.store.all("SELECT * FROM notebooks").length, 0);
  } finally {
    f.cleanup();
  }
});
test("failed local cleanup retains retryable blob references and never claims notebook deletion", async () => {
  const f = fixture();
  try {
    const n = f.store.createNotebook("Cleanup fault").id;
    const c = f.store.view(n).conversations[0].id;
    const source = await add(f.store, n, "CLEANUP_FAULT_CANARY");
    const p = f.store.selectedPassages(n, c)[0];
    const run = f.store.createRun(
      n,
      c,
      "Question",
      "answer",
      "fixture",
      "cleanup-run",
    );
    f.store.completeRun(run.id, answer(p));
    const blob = f.store.one(
      "SELECT blob FROM revisions WHERE id=?",
      p.revisionId,
    ).blob;
    chmodSync(f.store.blobs, 0o500);
    assert.throws(() => f.store.deleteNotebook(n), /EACCES|EPERM/);
    assert.equal(f.store.notebook(n).id, n);
    assert.equal(f.store.view(n).sources[0].removed, 1);
    assert.throws(() => f.store.passage(n, p.id), /unavailable/);
    assert.equal(
      f.store.one("SELECT output FROM runs WHERE id=?", run.id).output,
      null,
    );
    assert.equal(
      f.store.one("SELECT blob FROM revisions WHERE id=?", p.revisionId).blob,
      blob,
    );
    assert.equal(existsSync(path.join(f.store.blobs, blob)), true);
    chmodSync(f.store.blobs, 0o700);
    f.store.deleteNotebook(n);
    assert.throws(() => f.store.notebook(n), /not found/);
    assert.equal(existsSync(path.join(f.store.blobs, blob)), false);
  } finally {
    chmodSync(f.store.blobs, 0o700);
    f.cleanup();
  }
});

test("restart marks unfinished runs interrupted without replaying them", async () => {
  const f = fixture();
  try {
    const n = f.store.createNotebook("A").id,
      c = f.store.view(n).conversations[0].id;
    await add(f.store, n, "Evidence");
    const r = f.store.createRun(n, c, "Question", "answer", "", "run");
    const job = f.store.beginImport(n, "Unfinished", "unfinished-import");
    const staged = path.join(f.store.blobs, "staged.tmp");
    writeFileSync(staged, "partial bytes");
    f.store.event(r.id, { type: "progress", text: "Before restart" });
    f.store.close();
    f.store = new Store(f.root);
    assert.equal(
      f.store.one("SELECT status FROM runs WHERE id=?", r.id).status,
      "interrupted",
    );
    const events = f.store.all(
      "SELECT * FROM events WHERE run_id=? ORDER BY seq",
      r.id,
    );
    assert.equal(JSON.parse(events.at(-1).data).type, "interrupted");
    assert.equal(
      f.store.one("SELECT status FROM jobs WHERE id=?", job.id).status,
      "failed",
    );
    assert.equal(existsSync(staged), false);
    assert.equal(
      f.store.completeRun(r.id, answer(f.store.selectedPassages(n, c)[0])),
      false,
    );
    assert.equal(
      f.store.view(n).messages.filter((m: any) => m.role === "assistant")
        .length,
      0,
    );
    const retry = f.store.createRun(
      n,
      c,
      "Question",
      "answer",
      "",
      "explicit-retry",
      r.id,
    );
    assert.equal(retry.retry_of, r.id);
    f.store.run("UPDATE runs SET status='cancelled' WHERE id=?", retry.id);
    f.store.close();
    f.store = new Store(f.root);
    assert.equal(
      f.store.all("SELECT * FROM events WHERE run_id=?", r.id).length,
      events.length,
    );
  } finally {
    f.cleanup();
  }
});
test("identical repeated section headings retain distinct passage identities", async () => {
  const f = fixture();
  try {
    const n = f.store.createNotebook("A").id,
      job = f.store.beginImport(n, "Repeated", "repeat");
    const bytes = Buffer.from("# Same\nFirst.\n# Same\nSecond.");
    f.store.publishImport(
      n,
      job.id,
      "Repeated",
      "markdown",
      null,
      bytes,
      await extract(bytes, "markdown"),
    );
    assert.equal(f.store.all("SELECT * FROM passages").length, 2);
  } finally {
    f.cleanup();
  }
});

test("purge follows promoted generated notes and restart removes unreferenced blobs", async () => {
  const f = fixture();
  try {
    const n = f.store.createNotebook("A").id,
      c = f.store.view(n).conversations[0].id,
      s = await add(f.store, n, "Original unique evidence");
    const p = f.store.selectedPassages(n, c)[0],
      r = f.store.createRun(n, c, "Question", "answer", "", "run");
    f.store.completeRun(r.id, answer(p));
    const a = f.store.saveArtifact(
      n,
      "Generated",
      "note",
      JSON.stringify(answer(p)),
      false,
      r.id,
    );
    const job = f.store.beginImport(n, "Derived", "derived-job"),
      bytes = Buffer.from("A derived copy of original unique evidence");
    const derived = f.store.publishImport(
      n,
      job.id,
      "Derived",
      "note",
      null,
      bytes,
      await extract(bytes, "note"),
      undefined,
      a,
    );
    f.store.editArtifact(n, a, "Edited later", "A user-owned annotation");
    assert.equal(
      f.store.view(n).sources.find((s: any) => s.id === derived).derived_origin,
      "generated",
    );
    const promotedRevision = f.store.one(
      "SELECT current_revision FROM sources WHERE id=?",
      derived,
    ).current_revision;
    const derivation = f.store.sourceDerivation(n, promotedRevision);
    assert.equal(derivation!.title, "Generated");
    assert.equal(derivation!.authored, false);
    assert.equal(derivation!.origin, "generated");
    assert.equal(derivation!.runId, r.id);
    assert.deepEqual(derivation!.manifest, JSON.parse(r.manifest));
    assert.deepEqual(derivation!.content, answer(p));
    f.store.purgeSource(n, s);
    assert.equal(f.store.sourceDerivation(n, promotedRevision)!.content, null);
    assert.equal(
      f.store.sourceDerivation(n, promotedRevision)!.unavailable,
      true,
    );
    assert.equal(
      f.store.all("SELECT * FROM passages WHERE source_id=?", derived).length,
      0,
    );
    assert.equal(
      f.store.one("SELECT removed FROM sources WHERE id=?", derived).removed,
      1,
    );
    assert.equal(
      JSON.parse(
        f.store.one("SELECT content FROM artifacts WHERE id=?", a).content,
      ).text,
      "A user-owned annotation",
    );
    const orphan = path.join(f.store.blobs, "orphan.bin");
    writeFileSync(orphan, "unreferenced");
    f.store.close();
    f.store = new Store(f.root);
    assert.equal(existsSync(orphan), false);
  } finally {
    f.cleanup();
  }
});

test("duplicate reuse preserves note derivation and distinct URL provenance", async () => {
  const f = fixture();
  try {
    const n = f.store.createNotebook("A").id;
    const foreign = f.store.createNotebook("B").id;
    const bytes = Buffer.from("Identical source and promoted note content");
    const extracted = await extract(bytes, "note");
    const firstNote = f.store.saveArtifact(
      n,
      "First",
      "note",
      JSON.stringify({ text: bytes.toString() }),
      true,
    );
    const secondNote = f.store.saveArtifact(
      n,
      "Second",
      "note",
      JSON.stringify({ text: bytes.toString() }),
      true,
    );
    const foreignNote = f.store.saveArtifact(
      foreign,
      "Foreign",
      "note",
      "{}",
      true,
    );
    const publish = (
      key: string,
      derivedFrom?: string,
      origin: string | null = null,
    ) => {
      const job = f.store.beginImport(n, "Source", key);
      return f.store.publishImport(
        n,
        job.id,
        "Source",
        "note",
        origin,
        bytes,
        extracted,
        undefined,
        derivedFrom,
      );
    };
    const original = publish("original");
    const first = publish("first", firstNote);
    assert.equal(
      f.store.view(n).sources.find((s: any) => s.id === first).derived_origin,
      "user",
    );
    const second = publish("second", secondNote);
    assert.notEqual(original, first);
    assert.notEqual(first, second);
    assert.equal(publish("first-again", firstNote), first);
    assert.equal(
      f.store.one("SELECT derived_from FROM sources WHERE id=?", first)
        .derived_from,
      firstNote,
    );
    assert.equal(
      f.store.one("SELECT extractor FROM revisions WHERE source_id=?", first)
        .extractor,
      EXTRACTION_VERSION,
    );
    assert.throws(() => publish("foreign", foreignNote), /Originating note/);
    const urlA = publish("url-a", undefined, "https://example.com/a");
    const urlB = publish("url-b", undefined, "https://example.com/b");
    assert.notEqual(urlA, urlB);
    assert.equal(
      publish("url-a-again", undefined, "https://example.com/a"),
      urlA,
    );
  } finally {
    f.cleanup();
  }
});

test("promotion pins a notebook-scoped immutable note revision even across edits and restart", async () => {
  const f = fixture();
  try {
    const n = f.store.createNotebook("A").id;
    const other = f.store.createNotebook("B").id;
    const bytes = Buffer.from("Original note text");
    const a = f.store.saveArtifact(
      n,
      "Original title",
      "note",
      JSON.stringify({ text: bytes.toString() }),
      true,
    );
    const revision = f.store.one(
      "SELECT id FROM artifact_revisions WHERE artifact_id=?",
      a,
    ).id;
    f.store.editArtifact(n, a, "Later title", "Later note text");
    const publish = async (
      key: string,
      parent = a,
      parentRevision = revision,
    ) =>
      f.store.publishImport(
        n,
        f.store.beginImport(n, "Derived", key).id,
        "Derived",
        "note",
        null,
        bytes,
        await extract(bytes, "note"),
        undefined,
        parent,
        undefined,
        false,
        parentRevision,
      );
    const s = await publish("old-promotion");
    const sourceRevision = f.store.one(
      "SELECT current_revision FROM sources WHERE id=?",
      s,
    ).current_revision;
    const provenance = f.store.sourceDerivation(n, sourceRevision)!;
    assert.equal(provenance.revisionId, revision);
    assert.equal(provenance.title, "Original title");
    assert.deepEqual(provenance.content, { text: "Original note text" });
    assert.equal(provenance.origin, "user");
    assert.throws(
      () => f.store.sourceDerivation(other, sourceRevision),
      /not found/,
    );
    const foreign = f.store.saveArtifact(other, "Other", "note", "{}", true);
    const foreignRevision = f.store.one(
      "SELECT id FROM artifact_revisions WHERE artifact_id=?",
      foreign,
    ).id;
    await assert.rejects(
      publish("foreign-revision", a, foreignRevision),
      /revision not found/,
    );
    await assert.rejects(
      publish("foreign-note", foreign, foreignRevision),
      /Originating note/,
    );
    const currentRevision = f.store.one(
      "SELECT id FROM artifact_revisions WHERE artifact_id=? ORDER BY rowid DESC LIMIT 1",
      a,
    ).id;
    // Matching bytes cannot erase the distinction between different note edits.
    assert.notEqual(await publish("different-edit", a, currentRevision), s);
    f.store.close();
    f.store = new Store(f.root);
    assert.deepEqual(f.store.sourceDerivation(n, sourceRevision), provenance);
    const p = f.store
      .selectedPassages(n, f.store.view(n).conversations[0].id)
      .find((p) => p.sourceId === s)!;
    const exported = exportMarkdown("Derived answer", answer(p), (id) => ({
      ...f.store.passage(n, id),
      derivation: f.store.sourceDerivation(n, sourceRevision),
    }));
    assert.ok(exported.includes("note revision " + revision));
    assert.match(exported, /user origin.*not independent corroboration/);
    // Pre-migration promotions retain an honest unknown revision rather than
    // substituting the current editable note for their missing history.
    f.store.run(
      "UPDATE revisions SET derived_revision=NULL WHERE id=?",
      sourceRevision,
    );
    const legacy = f.store.sourceDerivation(n, sourceRevision)!;
    assert.equal(legacy.revisionId, null);
    assert.equal(legacy.content, null);
    assert.equal(legacy.title, null);
  } finally {
    f.cleanup();
  }
});

test("import attempts are typed, timed, scoped and retry exactly once with idempotent replay", async () => {
  const f = fixture();
  try {
    const n = f.store.createNotebook("A").id,
      other = f.store.createNotebook("B").id;
    const original = f.store.beginImport(n, "Input", "attempt-one", {
      kind: "paste",
    });
    assert.equal(original.type, "import");
    assert.equal(original.attempt_count, 1);
    assert.equal(original.started, null);
    assert.equal(original.ended, null);
    assert.equal(original.updated, original.created);
    assert.throws(
      () =>
        f.store.beginImport(
          n,
          "Input",
          "premature",
          { kind: "paste" },
          original.id,
        ),
      /Only failed/,
    );
    f.store.startImport(n, original.id, { kind: "paste" });
    f.store.run(
      "UPDATE jobs SET status='failed',error='Failed input' WHERE id=?",
      original.id,
    );
    const failed = f.store.importJob(n, original.id);
    assert.ok(failed.started && failed.ended && failed.updated);
    assert.throws(
      () =>
        f.store.beginImport(
          other,
          "Input",
          "foreign",
          { kind: "paste" },
          original.id,
        ),
      /not found/,
    );
    const retry = f.store.beginImport(
      n,
      "Fixed input",
      "attempt-two",
      { kind: "text" },
      original.id,
    );
    assert.equal(retry.retry_of, original.id);
    assert.equal(retry.attempt_count, 2);
    assert.equal(
      f.store.beginImport(
        n,
        "Fixed input",
        "attempt-two",
        { kind: "text" },
        original.id,
      ).id,
      retry.id,
    );
    assert.throws(
      () =>
        f.store.beginImport(
          n,
          "Input",
          "duplicate-retry",
          { kind: "paste" },
          original.id,
        ),
      /already has a retry/,
    );
    f.store.close();
    f.store = new Store(f.root);
    const interrupted = f.store.importJob(n, retry.id);
    assert.equal(interrupted.status, "failed");
    assert.equal(interrupted.started, null);
    assert.ok(interrupted.ended);
    const third = f.store.beginImport(
      n,
      "Input",
      "attempt-three",
      { kind: "paste" },
      retry.id,
    );
    assert.equal(third.attempt_count, 3);
    const bytes = Buffer.from("Successful retried evidence");
    f.store.publishImport(
      n,
      third.id,
      "Input",
      "paste",
      null,
      bytes,
      await extract(bytes, "paste"),
    );
    const complete = f.store.importJob(n, third.id);
    assert.equal(complete.status, "completed");
    assert.ok(complete.ended);
    assert.throws(
      () =>
        f.store.beginImport(
          n,
          "Input",
          "completed-retry",
          { kind: "paste" },
          third.id,
        ),
      /Only failed/,
    );
    assert.equal(f.store.view(n).sources.length, 1);
    assert.deepEqual(JSON.parse(complete.input_metadata), { kind: "paste" });
  } finally {
    f.cleanup();
  }
});

test("duplicate offers survive restart, reuse once and reject a changed revision", async () => {
  const f = fixture();
  try {
    const n = f.store.createNotebook("A").id;
    const source = await add(f.store, n, "Identical evidence");
    const bytes = Buffer.from("Identical evidence");
    const extracted = await extract(bytes, "text");
    const offer = (key: string) => {
      const job = f.store.beginImport(n, "Duplicate", key);
      f.store.publishImport(
        n,
        job.id,
        "Duplicate",
        "text",
        null,
        bytes,
        extracted,
        undefined,
        undefined,
        undefined,
        true,
      );
      return job.id;
    };
    const generation = f.store.notebook(n).generation;
    const first = offer("offer");
    assert.equal(
      f.store.one("SELECT status FROM jobs WHERE id=?", first).status,
      "duplicate",
    );
    assert.equal(f.store.view(n).sources.length, 1);
    assert.equal(f.store.notebook(n).generation, generation);
    f.store.close();
    f.store = new Store(f.root);
    assert.equal(f.store.resolveDuplicate(n, first, "reuse").source_id, source);
    assert.equal(
      f.store.resolveDuplicate(n, first, "reuse").status,
      "completed",
    );
    const dismissed = offer("dismiss");
    assert.equal(
      f.store.resolveDuplicate(n, dismissed, "dismiss").status,
      "dismissed",
    );
    assert.equal(
      f.store.resolveDuplicate(n, dismissed, "dismiss").source_id,
      null,
    );
    const stale = offer("stale");
    await add(f.store, n, "Changed evidence", "refresh-offer", source);
    assert.equal(f.store.resolveDuplicate(n, stale, "reuse").status, "failed");
    assert.match(
      f.store.one("SELECT error FROM jobs WHERE id=?", stale).error,
      /changed or is unavailable/,
    );
    assert.equal(f.store.view(n).sources.length, 1);
  } finally {
    f.cleanup();
  }
});
test("duplicate acceptance is notebook scoped and cannot restore a removed source", async () => {
  const f = fixture();
  try {
    const n = f.store.createNotebook("A").id;
    const other = f.store.createNotebook("B").id;
    const source = await add(f.store, n, "Identical evidence");
    const bytes = Buffer.from("Identical evidence");
    const job = f.store.beginImport(n, "Duplicate", "offer");
    f.store.publishImport(
      n,
      job.id,
      "Duplicate",
      "text",
      null,
      bytes,
      await extract(bytes, "text"),
      undefined,
      undefined,
      undefined,
      true,
    );
    assert.throws(
      () => f.store.resolveDuplicate(other, job.id, "reuse"),
      /Import job not found/,
    );
    f.store.removeSource(n, source);
    assert.equal(f.store.resolveDuplicate(n, job.id, "reuse").status, "failed");
    assert.equal(f.store.view(n).sources[0].removed, 1);
    assert.equal(
      f.store.one("SELECT duplicate_revision FROM jobs WHERE id=?", job.id)
        .duplicate_revision,
      null,
    );
  } finally {
    f.cleanup();
  }
});

test("URL snapshots retain requested and final origins and retrieval time across refresh and restart", async () => {
  const f = fixture();
  try {
    const n = f.store.createNotebook("URL provenance").id;
    const c = f.store.view(n).conversations[0].id;
    const original = "https://public.example/current";
    const first = Buffer.from("First URL evidence");
    const job = f.store.beginImport(n, "URL", "first-url");
    const source = f.store.publishImport(
      n,
      job.id,
      "URL",
      "text",
      "https://public.example/v1",
      first,
      await extract(first, "text"),
      undefined,
      undefined,
      { requestedUrl: original, retrievedAt: "2026-10-09T10:00:00.000Z" },
    );
    const old = f.store.selectedPassages(n, c)[0];
    const second = Buffer.from("Second URL evidence");
    const refresh = f.store.beginImport(n, "URL", "second-url");
    f.store.publishImport(
      n,
      refresh.id,
      "URL",
      "text",
      "https://public.example/v2",
      second,
      await extract(second, "text"),
      source,
      undefined,
      { requestedUrl: original, retrievedAt: "2026-10-09T11:00:00.000Z" },
    );
    const current = f.store.selectedPassages(n, c)[0];
    assert.equal(current.requestedOrigin, original);
    assert.equal(current.origin, "https://public.example/v2");
    assert.equal(current.retrievedAt, "2026-10-09T11:00:00.000Z");
    assert.equal(f.store.view(n).sources[0].requested_origin, original);
    assert.equal(
      f.store.view(n).sources[0].origin,
      "https://public.example/v2",
    );
    assert.match(current.originalHash!, /^[0-9a-f]{64}$/);
    assert.equal(current.extractionVersion, EXTRACTION_VERSION);
    f.store.close();
    f.store = new Store(f.root);
    const historical = f.store.passage(n, old.id);
    assert.equal(historical.origin, "https://public.example/v1");
    assert.equal(historical.requestedOrigin, original);
    assert.equal(historical.retrievedAt, "2026-10-09T10:00:00.000Z");
    assert.equal(historical.originalHash, old.originalHash);
  } finally {
    f.cleanup();
  }
});

test("import publication rejects mismatched jobs and terminal jobs cannot create another revision", async () => {
  const f = fixture();
  try {
    const n = f.store.createNotebook("A").id;
    const other = f.store.createNotebook("B").id;
    const job = f.store.beginImport(n, "Evidence", "scoped-job");
    const bytes = Buffer.from("Scoped evidence");
    const extracted = await extract(bytes, "text");
    assert.throws(
      () =>
        f.store.publishImport(
          other,
          job.id,
          "Evidence",
          "text",
          null,
          bytes,
          extracted,
        ),
      /job not found/,
    );
    const source = f.store.publishImport(
      n,
      job.id,
      "Evidence",
      "text",
      null,
      bytes,
      extracted,
    );
    assert.equal(
      f.store.publishImport(
        n,
        job.id,
        "Changed",
        "text",
        null,
        Buffer.from("Different bytes"),
        extracted,
      ),
      source,
    );
    assert.equal(f.store.all("SELECT * FROM revisions").length, 1);
    const failed = f.store.beginImport(n, "Failed", "terminal-job");
    f.store.run("UPDATE jobs SET status='failed' WHERE id=?", failed.id);
    assert.throws(
      () =>
        f.store.publishImport(
          n,
          failed.id,
          "Failed",
          "text",
          null,
          bytes,
          extracted,
        ),
      /no longer active/,
    );
  } finally {
    f.cleanup();
  }
});
