import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/store.ts";
import { backup, restore } from "../src/storage/backup.ts";
import { editableNote, richNote } from "../src/domain/notes.ts";
import { richFixture } from "./fixtures/notes.ts";

const input = (text = "Unfinished 🦉") => ({
  artifactId: null,
  baseRevisionId: null,
  title: "",
  document: editableNote({ text }),
  version: 1,
});

test("new and existing drafts survive restart and backup without publishing notes or entering discovery", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-draft-recovery-"));
  let store = new Store(path.join(root, "data"));
  try {
    const n = store.createNotebook("Personal").id;
    const a = store.createRichArtifact(
      n,
      "Saved",
      editableNote({ text: "Published" }),
    );
    const base = store.view(n).artifacts[0].revision_id;
    const existing = {
      ...input(),
      artifactId: a,
      baseRevisionId: base,
      title: "Unsaved",
      document: richFixture(),
    };
    store.drafts.save(n, "new-draft", input());
    store.drafts.save(n, "existing-draft", existing);
    assert.equal(store.view(n).artifacts.length, 1);
    assert.equal(
      store.one("SELECT count(*) AS count FROM artifact_revisions").count,
      1,
    );
    assert.equal(store.view(n).drafts.length, 2);
    assert.equal(store.view(n).runs.length, 0);
    assert.equal(store.discover("Unfinished").results.length, 0);
    store.close();
    store = new Store(path.join(root, "data"));
    assert.deepEqual(
      store.drafts.read(n, "existing-draft").document,
      richNote(existing.document),
    );
    store.close();
    backup(path.join(root, "data"), path.join(root, "backup"));
    restore(path.join(root, "backup"), path.join(root, "restored"));
    store = new Store(path.join(root, "restored"));
    assert.equal(store.drafts.read(n, "new-draft").title, "");
    assert.deepEqual(
      store.drafts.read(n, "new-draft").document,
      input().document,
    );
    assert.equal(store.drafts.read(n, "existing-draft").baseRevisionId, base);
    store.deleteNotebook(n);
    assert.equal(
      store.one("SELECT count(*) AS count FROM note_drafts").count,
      0,
    );
  } finally {
    if (store.db.isOpen) store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("stale recovered edits cannot overwrite newer notes, and only committed publication clears a draft", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-draft-stale-"));
  const store = new Store(root);
  try {
    const n = store.createNotebook("Personal").id;
    const a = store.createRichArtifact(n, "Saved", input("Original").document);
    const base = store.view(n).artifacts[0].revision_id;
    const draft = {
      ...input("My unsaved text"),
      artifactId: a,
      baseRevisionId: base,
    };
    const ref = store.drafts.save(n, "draft", draft);
    store.editRichArtifact(
      n,
      a,
      "Newer title",
      input("Other window").document,
      base,
    );
    assert.throws(
      () =>
        store.drafts.publish(n, ref, a, base, () =>
          store.editRichArtifact(n, a, "Recovered", draft.document, base),
        ),
      /Note changed/,
    );
    assert.deepEqual(store.drafts.read(n, "draft").document, draft.document);
    assert.equal(store.view(n).artifacts[0].title, "Newer title");
    const newRef = store.drafts.save(n, "new", input());
    assert.throws(
      () =>
        store.drafts.publish(n, newRef, null, null, () => {
          throw Error("Save failed");
        }),
      /Save failed/,
    );
    assert.ok(store.drafts.read(n, "new"));
    const saved = store.drafts.publish(n, newRef, null, null, () =>
      store.createRichArtifact(n, "Recovered", input().document),
    );
    assert.ok(store.view(n).artifacts.some((note: any) => note.id === saved));
    assert.throws(() => store.drafts.read(n, "new"), /not found/);
    assert.throws(() => store.drafts.save(n, "new", input()), /closed/);
    store.drafts.discard(n, ref);
    const cleared = store.one(
      "SELECT title,document FROM note_drafts WHERE id='draft'",
    );
    assert.equal(cleared.title, "");
    assert.equal(cleared.document, null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent draft writes, retry after a lost response, stale discard and notebook scope preserve other edits", () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "codeboom-draft-concurrent-"),
  );
  const store = new Store(root);
  try {
    const n = store.createNotebook("One").id,
      other = store.createNotebook("Two").id;
    const ref = store.drafts.save(n, "same", input());
    assert.deepEqual(store.drafts.save(n, "same", input()), ref);
    assert.throws(
      () => store.drafts.save(other, "same", input()),
      /another note/,
    );
    assert.throws(() => store.drafts.read(other, "same"), /not found/);
    assert.throws(() => store.drafts.discard(other, ref), /not found/);
    const next = store.drafts.save(n, "same", {
      ...input("Window A"),
      version: 2,
    });
    assert.throws(
      () => store.drafts.save(n, "same", { ...input("Window B"), version: 2 }),
      /changed/,
    );
    assert.throws(() => store.drafts.discard(n, ref), /changed/);
    assert.throws(
      () =>
        store.drafts.publish(n, ref, null, null, () =>
          assert.fail("Must not save"),
        ),
      /changed/,
    );
    store.drafts.discard(n, next);
    store.drafts.discard(n, next);
    assert.throws(
      () => store.drafts.save(n, "same", { ...input(), version: 3 }),
      /closed/,
    );
    for (let i = 0; i < 50; i++) store.drafts.save(n, `draft-${i}`, input());
    assert.throws(
      () => store.drafts.save(n, "overflow", input()),
      /50 recoverable/,
    );
    store.drafts.discard(n, { id: "draft-0", version: 1 });
    store.drafts.save(n, "replacement", input());
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("draft citations remain exact and scoped; purged references in authored drafts are marked unavailable", () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "codeboom-draft-references-"),
  );
  const store = new Store(root);
  try {
    const n = store.createNotebook("One").id,
      other = store.createNotebook("Two").id;
    const text = "Approval remains pending.";
    const source = store.publishImport(
      n,
      store.beginImport(n, "Evidence", "import").id,
      "Evidence",
      "text",
      null,
      Buffer.from(text),
      { sections: [{ locator: "Text", text }], warnings: [] },
    );
    const p = store.selectedPassages(n, store.view(n).conversations[0].id)[0];
    const doc = richFixture({
      passageId: p.id,
      quote: p.text,
      start: 0,
      end: p.text.length,
    });
    const draft = { ...input(), document: doc };
    store.drafts.save(n, "cited", draft);
    assert.throws(
      () => store.drafts.save(other, "foreign", draft),
      /reference|passage|citation/i,
    );
    assert.throws(
      () =>
        store.drafts.save(n, "oversized", {
          ...input(),
          title: "x".repeat(201),
        }),
      /title/,
    );
    assert.throws(
      () =>
        store.drafts.save(n, "unsafe", {
          ...input(),
          document: { format: "html", html: "<script>" },
        }),
      /note|field/i,
    );
    store.purgeSource(n, source);
    const recovered = store.drafts.read(n, "cited");
    assert.deepEqual(recovered.document, richNote(doc));
    assert.equal(recovered.referenceAvailability[p.id], false);
    store.drafts.save(n, "cited", {
      ...draft,
      title: "Authored draft",
      version: 2,
    });
    assert.throws(
      () => store.drafts.save(n, "reintroduced", draft),
      /reference|passage|citation/i,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
