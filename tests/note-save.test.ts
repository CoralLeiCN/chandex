import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/store.ts";
import { backup, restore } from "../src/storage/backup.ts";
import { editableNote } from "../src/domain/notes.ts";

test("save receipts survive migration, restart and backup and reject changed, foreign and deleted-note replays", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-save-once-"));
  const data = path.join(root, "data");
  let store = new Store(data);
  try {
    // Upgrade a genuine schema-18 database with an existing note and draft.
    const n = store.createNotebook("Personal").id,
      other = store.createNotebook("Other").id;
    const document = editableNote({ text: "My note" });
    const input = {
      artifactId: null,
      baseRevisionId: null,
      title: "My note",
      document,
      version: 1,
    };
    const draft = store.drafts.save(n, "draft", input);
    store.db.exec(
      "DROP TABLE note_saves; DELETE FROM migrations WHERE version=19;",
    );
    store.close();
    store = new Store(data);
    assert.deepEqual(store.drafts.read(n, draft.id).document, document);
    const save = () =>
      store.drafts.publish(n, draft, null, null, () =>
        store.createRichArtifact(n, input.title, document),
      );
    const artifact = store.drafts.saveOnce(n, "operation", input, save);
    assert.equal(store.drafts.list(n).length, 0);
    store.close();
    backup(data, path.join(root, "backup"));
    restore(path.join(root, "backup"), path.join(root, "restored"));
    store = new Store(path.join(root, "restored"));
    const noSave = () => assert.fail("A replay must not publish again");
    assert.equal(
      store.drafts.saveOnce(n, "operation", input, noSave),
      artifact,
    );
    assert.equal(store.view(n).artifacts.length, 1);
    assert.throws(
      () =>
        store.drafts.saveOnce(
          n,
          "operation",
          { ...input, title: "Changed" },
          noSave,
        ),
      /another note save/,
    );
    assert.throws(
      () => store.drafts.saveOnce(other, "operation", input, noSave),
      /another note save/,
    );
    assert.throws(
      () => store.drafts.saveOnce(n, "bad key!", input, noSave),
      /Invalid note save ID/,
    );
    const current = store.view(n).artifacts[0];
    const trashed = store.trashArtifact(
      n,
      artifact,
      current.revision_id,
      current.trash_version,
    );
    assert.throws(
      () => store.drafts.saveOnce(n, "operation", input, noSave),
      /Trash/,
    );
    store.deleteArtifact(n, artifact, trashed.trash_version);
    assert.throws(
      () => store.drafts.saveOnce(n, "operation", input, noSave),
      /permanently deleted/,
    );
    store.deleteNotebook(n);
    assert.equal(
      store.one("SELECT count(*) AS count FROM note_saves").count,
      0,
    );
  } finally {
    if (store.db.isOpen) store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed publication rolls back the save receipt, note and draft closure together", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-save-rollback-"));
  const store = new Store(root);
  try {
    const n = store.createNotebook("Personal").id,
      document = editableNote({ text: "Retain me" });
    const draft = store.drafts.save(n, "draft", {
      artifactId: null,
      baseRevisionId: null,
      title: "Retain me",
      document,
      version: 1,
    });
    assert.throws(
      () =>
        store.drafts.saveOnce(n, "operation", {}, () => {
          store.drafts.publish(n, draft, null, null, () =>
            store.createRichArtifact(n, "Retain me", document),
          );
          throw Error("Controlled failure");
        }),
      /Controlled failure/,
    );
    assert.equal(store.view(n).artifacts.length, 0);
    assert.equal(
      store.one("SELECT count(*) AS count FROM note_saves").count,
      0,
    );
    assert.ok(store.drafts.read(n, draft.id));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
