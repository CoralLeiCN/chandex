import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/store.ts";
import { backup, restore } from "../src/storage/backup.ts";
import { editableNote, richNote } from "../src/domain/notes.ts";
import { richFixture } from "./fixtures/notes.ts";
import { documentText } from "../src/domain/artifacts.ts";
import { NotebookService } from "../src/server/service.ts";
import type { Answer } from "../src/domain/evidence.ts";
import { schema17 } from "./fixtures/legacy-storage.ts";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-trash-"));
  const store = new Store(path.join(root, "data"));
  const n = store.createNotebook("Personal").id;
  const other = store.createNotebook("Other").id;
  return { root, store, n, other };
}
function add(
  store: Store,
  n: string,
  text: string,
  derivedFrom?: string,
  derivedRevision?: string,
) {
  const descriptor = {
    kind: derivedFrom ? "note" : "text",
    ...(derivedFrom ? { derivedFrom, derivedRevision } : {}),
  };
  const job = store.beginImport(n, "Evidence", crypto.randomUUID(), descriptor);
  return store.publishImport(
    n,
    job.id,
    "Evidence",
    descriptor.kind,
    null,
    Buffer.from(text),
    { sections: [{ locator: "Text", text }], warnings: [] },
    undefined,
    derivedFrom,
    undefined,
    false,
    derivedRevision,
  );
}
function answer(p: any): Answer {
  return {
    title: "Snapshot answer",
    status: "answered",
    blocks: [
      {
        kind: "fact",
        text: p.text,
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

test("Trash hides notes and drafts from ordinary lists and FTS; restore keeps exact history, references, snapshots and backup state", () => {
  const f = fixture();
  let store = f.store;
  try {
    add(store, f.n, "Evidence 🦉 remains provisional.");
    const c = store.view(f.n).conversations[0].id,
      p = store.selectedPassages(f.n, c)[0];
    const doc = richFixture({
      passageId: p.id,
      quote: p.text,
      start: 0,
      end: Array.from(p.text).length,
    });
    const a = store.createRichArtifact(f.n, "Cited research", doc);
    const base = store.artifactHistory(f.n, a).results[0].id;
    const revision = store.editRichArtifact(
      f.n,
      a,
      "Revised research",
      doc,
      base,
    );
    const history = store.artifactHistory(f.n, a);
    store.drafts.save(f.n, "unsaved", {
      artifactId: a,
      baseRevisionId: revision,
      title: "Draft research",
      document: editableNote({ text: "Unfinished research" }),
      version: 1,
    });
    const pinned = store.openNoteConversation(f.n, a, revision);
    const context = store.noteContext(f.n, pinned.id);
    const passages = store.selectedPassages(f.n, pinned.id);
    const generation = store.notebook(f.n).generation;
    const trashed = store.trashArtifact(f.n, a, revision, 0);
    assert.equal(trashed.revision_count, 2);
    assert.equal(store.view(f.n).artifacts.length, 0);
    assert.equal(store.view(f.n).drafts.length, 0);
    assert.equal(store.view(f.n).trashCount, 1);
    assert.equal(
      store.discover("research").results.some((r) => r.id === a),
      false,
    );
    assert.equal(
      store.one("SELECT count(*) AS count FROM note_fts WHERE artifact_id=?", a)
        .count,
      0,
    );
    assert.deepEqual(store.artifactHistory(f.n, a), history);
    assert.deepEqual(store.noteContext(f.n, pinned.id), context);
    assert.deepEqual(store.selectedPassages(f.n, pinned.id), passages);
    assert.equal(store.notebook(f.n).generation, generation);
    assert.throws(() => store.drafts.read(f.n, "unsaved"), /Trash/);
    store.close();
    store = new Store(path.join(f.root, "data"));
    assert.equal(store.trash(f.n)[0].trash_version, trashed.trash_version);
    store.close();
    backup(path.join(f.root, "data"), path.join(f.root, "backup"));
    restore(path.join(f.root, "backup"), path.join(f.root, "restored"));
    store = new Store(path.join(f.root, "restored"));
    store.restoreTrashedArtifact(f.n, a, trashed.trash_version);
    assert.equal(store.trash(f.n).length, 0);
    assert.deepEqual(store.artifactHistory(f.n, a), history);
    assert.deepEqual(
      store.artifactRevision(f.n, a, revision).content,
      richNote(doc),
    );
    assert.equal(
      store.artifactRevision(f.n, a, revision).referenceAvailability[p.id],
      true,
    );
    assert.equal(store.drafts.read(f.n, "unsaved").title, "Draft research");
    assert.ok(store.discover("research").results.some((r) => r.id === a));
  } finally {
    if (store.db.isOpen) store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("Trash mutations enforce notebook ownership, stale revisions and lifecycle versions; edits and new promotions require restore", () => {
  const f = fixture();
  try {
    const a = f.store.createRichArtifact(
      f.n,
      "Saved",
      editableNote({ text: "Personal note" }),
    );
    const base = f.store.artifactHistory(f.n, a).results[0].id;
    assert.throws(
      () => f.store.trashArtifact(f.other, a, base, 0),
      /not found/,
    );
    assert.throws(() => f.store.trashArtifact(f.n, a, "stale", 0), /changed/);
    assert.throws(() => f.store.deleteArtifact(f.n, a, 0), /Trash changed/);
    assert.throws(() => f.store.trashArtifact(f.n, a, base, NaN), /version/);
    f.store.trashArtifact(f.n, a, base, 0);
    for (const action of [
      () => f.store.editArtifact(f.n, a, "Edit", "changed", base),
      () =>
        f.store.editRichArtifact(
          f.n,
          a,
          "Edit",
          editableNote({ text: "changed" }),
          base,
        ),
      () => f.store.restoreArtifact(f.n, a, base, base),
      () => f.store.openNoteConversation(f.n, a, base),
      () =>
        f.store.drafts.save(f.n, "late", {
          artifactId: a,
          baseRevisionId: base,
          title: "",
          document: editableNote({ text: "Late" }),
          version: 1,
        }),
      () => add(f.store, f.n, "Personal note", a, base),
    ])
      assert.throws(action, /Trash|Originating note/);
    assert.throws(
      () => f.store.restoreTrashedArtifact(f.other, a, 1),
      /not found/,
    );
    assert.throws(() => f.store.deleteArtifact(f.other, a, 1), /not found/);
    f.store.restoreTrashedArtifact(f.n, a, 1);
    assert.throws(() => f.store.deleteArtifact(f.n, a, 1), /Trash changed/);
    assert.throws(() => f.store.trashArtifact(f.n, a, base, 0), /changed/);
    f.store.trashArtifact(f.n, a, base, 2);
    assert.throws(
      () => f.store.restoreTrashedArtifact(f.n, a, 1),
      /Trash changed/,
    );
    assert.throws(() => f.store.deleteArtifact(f.n, a, 1), /Trash changed/);
    f.store.deleteArtifact(f.n, a, 3);
    f.store.deleteArtifact(f.n, a, 3); // lost-response replay
    assert.throws(() => f.store.restoreTrashedArtifact(f.n, a, 3), /not found/);
    assert.throws(() => f.store.artifactRevision(f.n, a, base), /not found/);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("permanent deletion purges dependent evidence, pins and drafts while preserving independent sources and authored references", () => {
  const f = fixture();
  let store = f.store;
  try {
    const original = add(store, f.n, "Independent evidence.");
    const a = store.createRichArtifact(
      f.n,
      "Delete this",
      editableNote({ text: "Private saved note." }),
    );
    const revision = store.artifactHistory(f.n, a).results[0].id;
    store.drafts.save(f.n, "private-draft", {
      artifactId: a,
      baseRevisionId: revision,
      title: "Private draft",
      document: editableNote({ text: "Unsaved private text" }),
      version: 1,
    });
    const promoted = add(store, f.n, "Private saved note.", a, revision);
    const sourceRevision = store.one(
      "SELECT current_revision FROM sources WHERE id=?",
      promoted,
    ).current_revision;
    const blob = store.one(
      "SELECT blob FROM revisions WHERE id=?",
      sourceRevision,
    ).blob;
    const pinned = store.openNoteConversation(f.n, a, revision);
    const p = store.selectedPassages(f.n, pinned.id)[0];
    const r = store.createRun(
      f.n,
      pinned.id,
      "Question",
      "answer",
      "fixture",
      "pin-answer",
    );
    store.completeRun(r.id, answer(p));
    const derivedNote = store.saveArtifact(
      f.n,
      "Derived note",
      "note",
      JSON.stringify(answer(p)),
      false,
      r.id,
    );
    const descendantRevision = store.artifactHistory(f.n, derivedNote)
      .results[0].id;
    const descendant = add(
      store,
      f.n,
      documentText(answer(p)),
      derivedNote,
      descendantRevision,
    );
    const retained = store.createRichArtifact(
      f.n,
      "Authored reference",
      richFixture(answer(p).blocks[0].citations[0]),
    );
    const active = store.createRun(
      f.n,
      pinned.id,
      "Late question",
      "answer",
      "fixture",
      "pin-late",
    );
    store.trashArtifact(f.n, a, revision, 0);
    const service = new NotebookService(store, {
      status: async () => ({}) as any,
      run: async () => answer(p),
    });
    const controller = new AbortController();
    service.controllers.set(active.id, controller);
    service.deleteArtifact(f.n, a, 1);
    assert.equal(controller.signal.aborted, true);
    assert.equal(store.completeRun(active.id, answer(p)), false);
    for (const table of ["artifacts", "artifact_revisions", "note_drafts"])
      assert.equal(
        store.one(
          `SELECT count(*) AS count FROM ${table} WHERE ${table === "artifacts" ? "id" : "artifact_id"}=?`,
          a,
        ).count,
        0,
      );
    assert.throws(() => store.conversation(f.n, pinned.id), /not found/);
    assert.equal(
      store.one(
        "SELECT count(*) AS count FROM messages WHERE conversation_id=?",
        pinned.id,
      ).count,
      0,
    );
    assert.equal(
      store.one("SELECT count(*) AS count FROM events WHERE run_id=?", r.id)
        .count,
      0,
    );
    assert.equal(existsSync(path.join(store.blobs, blob)), false);
    assert.equal(
      store.one("SELECT blob FROM revisions WHERE id=?", sourceRevision).blob,
      null,
    );
    assert.equal(store.sourceDerivation(f.n, sourceRevision)?.deleted, true);
    assert.equal(
      store.one("SELECT removed FROM sources WHERE id=?", descendant).removed,
      1,
    );
    assert.equal(
      store.artifactRevision(f.n, derivedNote, descendantRevision).available,
      false,
    );
    const authored = store
      .view(f.n)
      .artifacts.find((note: any) => note.id === retained);
    assert.equal(authored.referenceAvailability[p.id], false);
    assert.throws(() => store.passage(f.n, p.id), /unavailable|not found/);
    assert.deepEqual(
      store.sourceOriginal(
        f.n,
        original,
        store.one("SELECT current_revision FROM sources WHERE id=?", original)
          .current_revision,
      ),
      Buffer.from("Independent evidence."),
    );
    assert.deepEqual(store.all("PRAGMA foreign_key_check"), []);
    store.close();
    backup(path.join(f.root, "data"), path.join(f.root, "backup"));
    restore(path.join(f.root, "backup"), path.join(f.root, "restored"));
    store = new Store(path.join(f.root, "restored"));
    store.deleteArtifact(f.n, a, 1);
    assert.throws(() => store.artifactHistory(f.n, a), /not found/);
    assert.equal(
      store.view(f.n).artifacts.find((note: any) => note.id === retained)
        .referenceAvailability[p.id],
      false,
    );
    store.deleteNotebook(f.n);
    assert.equal(
      store.one("SELECT count(*) AS count FROM deleted_notes").count,
      0,
    );
  } finally {
    if (store.db.isOpen) store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("moving to Trash cancels pending promotions and refuses delayed duplicate acceptance and publication", async () => {
  const f = fixture();
  try {
    const a = f.store.createRichArtifact(
      f.n,
      "Saved",
      editableNote({ text: "Snapshot" }),
    );
    const revision = f.store.artifactHistory(f.n, a).results[0].id;
    const descriptor = {
      kind: "note",
      derivedFrom: a,
      derivedRevision: revision,
    };
    const job = f.store.beginImport(f.n, "Saved", "pending", descriptor);
    const controller = new AbortController();
    const service = new NotebookService(f.store, {
      status: async () => ({}) as any,
      run: async () => ({}) as any,
    });
    service.importControllers.set(job.id, controller);
    service.trashArtifact(f.n, a, revision, 0);
    assert.equal(controller.signal.aborted, true);
    assert.equal(f.store.importJob(f.n, job.id).status, "failed");
    assert.throws(
      () => service.retryImport(f.n, job.id, "late-retry"),
      /unavailable/,
    );
    assert.throws(
      () => f.store.resolveDuplicate(f.n, job.id, "reuse"),
      /no pending/,
    );
    assert.throws(
      () =>
        f.store.publishImport(
          f.n,
          job.id,
          "Saved",
          "note",
          null,
          Buffer.from("Snapshot"),
          { sections: [{ locator: "Note", text: "Snapshot" }], warnings: [] },
          undefined,
          a,
          undefined,
          false,
          revision,
        ),
      /no longer active/,
    );
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("schema 17 backup migrates active notes and FTS into reversible Trash without changing revisions", () => {
  const f = fixture();
  let store = f.store;
  try {
    const a = store.createRichArtifact(
      f.n,
      "Legacy research",
      editableNote({ text: "Migration marker" }),
    );
    const history = store.artifactHistory(f.n, a);
    schema17(store);
    store.close();
    backup(path.join(f.root, "data"), path.join(f.root, "backup"));
    restore(path.join(f.root, "backup"), path.join(f.root, "restored"));
    store = new Store(path.join(f.root, "restored"));
    assert.equal(store.view(f.n).artifacts[0].trash_version, 0);
    assert.deepEqual(store.artifactHistory(f.n, a), history);
    store.trashArtifact(f.n, a, history.results[0].id, 0);
    assert.equal(store.discover("Migration marker").results.length, 0);
    store.restoreTrashedArtifact(f.n, a, 1);
    assert.equal(store.discover("Migration marker").results.length, 1);
  } finally {
    if (store.db.isOpen) store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("failed permanent cleanup keeps the note in Trash and safely retries after restart", () => {
  const f = fixture();
  let store = f.store;
  try {
    const a = store.createRichArtifact(
      f.n,
      "Retry deletion",
      editableNote({ text: "Private note" }),
    );
    const revision = store.artifactHistory(f.n, a).results[0].id;
    add(store, f.n, "Private note", a, revision);
    store.trashArtifact(f.n, a, revision, 0);
    chmodSync(store.blobs, 0o500);
    assert.throws(() => store.deleteArtifact(f.n, a, 1), /EACCES|EPERM/);
    assert.equal(store.trash(f.n)[0].id, a);
    assert.equal(store.artifactHistory(f.n, a).results.length, 1);
    assert.equal(
      store.one("SELECT count(*) AS count FROM deleted_notes").count,
      0,
    );
    chmodSync(store.blobs, 0o700);
    store.close();
    store = new Store(path.join(f.root, "data"));
    store.deleteArtifact(f.n, a, 1);
    assert.equal(store.trash(f.n).length, 0);
    assert.throws(() => store.artifactHistory(f.n, a), /not found/);
    assert.equal(
      store.one(
        "SELECT count(*) AS count FROM revisions WHERE blob IS NOT NULL",
      ).count,
      0,
    );
    assert.deepEqual(store.all("PRAGMA foreign_key_check"), []);
  } finally {
    chmodSync(store.blobs, 0o700);
    if (store.db.isOpen) store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
