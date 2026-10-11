import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/store.ts";
import { backup, restore } from "../src/storage/backup.ts";
import { extract } from "../src/ingestion/extract.ts";
import { richFixture } from "./fixtures/notes.ts";
import { documentText } from "../src/domain/artifacts.ts";

test("purging a reference invalidates its pinned note snapshot but preserves a later clean revision", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-note-reference-"));
  const store = new Store(root);
  try {
    const n = store.createNotebook("Personal").id;
    const bytes = Buffer.from("Budget is provisional.");
    const job = store.beginImport(n, "Evidence", "evidence");
    const source = store.publishImport(
      n,
      job.id,
      "Evidence",
      "text",
      null,
      bytes,
      await extract(bytes, "text"),
    );
    const p = store.selectedPassages(n, store.view(n).conversations[0].id)[0];
    const note = store.createRichArtifact(
      n,
      "Plan",
      richFixture({
        passageId: p.id,
        quote: p.text,
        start: 0,
        end: Array.from(p.text).length,
      }),
    );
    const revision = store.view(n).artifacts[0].revision_id;
    const conversation = store.openNoteConversation(n, note, revision);
    const snapshot = store.noteContext(n, conversation.id).source_id;
    assert.ok(
      store
        .selectedPassages(n, conversation.id)
        .some((p) => p.text.includes("Budget is provisional.")),
    );
    const cleanRevision = store.editRichArtifact(
      n,
      note,
      "Clean plan",
      richFixture(),
      revision,
    );
    const cleanConversation = store.openNoteConversation(
      n,
      note,
      cleanRevision,
    );

    store.purgeSource(n, source);

    assert.throws(
      () => store.openNoteConversation(n, note, revision),
      /unavailable/,
    );
    assert.throws(
      () =>
        store.createRun(
          n,
          conversation.id,
          "Question",
          "answer",
          "",
          "purged-reference",
        ),
      /removed or purged/,
    );
    assert.deepEqual(store.selectedPassages(n, conversation.id), []);
    assert.equal(
      store.one("SELECT removed FROM sources WHERE id=?", snapshot).removed,
      1,
    );
    assert.equal(
      store.one(
        "SELECT count(*) AS count FROM revisions WHERE source_id=? AND blob IS NOT NULL",
        snapshot,
      ).count,
      0,
    );
    const retained = store.artifactRevision(n, note, revision);
    assert.equal(retained.available, true);
    assert.equal(retained.referenceAvailability[p.id], false);
    assert.match(documentText(retained.content), /Budget is provisional/);
    assert.equal(
      store.createRun(
        n,
        cleanConversation.id,
        "Question",
        "answer",
        "",
        "clean-reference",
      ).status,
      "queued",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("purge follows authored note promotions and refuses delayed republication", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-note-promotion-"));
  const store = new Store(root);
  try {
    const n = store.createNotebook("Personal").id;
    const conversation = store.view(n).conversations[0].id;
    const bytes = Buffer.from("Budget is provisional.");
    const job = store.beginImport(n, "Evidence", "evidence");
    const source = store.publishImport(
      n,
      job.id,
      "Evidence",
      "text",
      null,
      bytes,
      await extract(bytes, "text"),
    );
    const p = store.selectedPassages(n, conversation)[0];
    const content = richFixture({
      passageId: p.id,
      quote: p.text,
      start: 0,
      end: Array.from(p.text).length,
    });
    const note = store.createRichArtifact(n, "Plan", content);
    const revision = store.view(n).artifacts[0].revision_id;
    const text = documentText(content);
    const extracted = {
      sections: [{ locator: "Saved note", text }],
      warnings: [],
    };
    const promotion = store.beginImport(n, "Plan", "promotion");
    const promoted = store.publishImport(
      n,
      promotion.id,
      "Plan",
      "note",
      null,
      Buffer.from(text),
      extracted,
      undefined,
      note,
      undefined,
      false,
      revision,
    );
    store.setSelection(n, conversation, [promoted]);
    const derivedPassage = store.selectedPassages(n, conversation)[0];
    const run = store.createRun(
      n,
      conversation,
      "Question",
      "answer",
      "",
      "derived-answer",
    );
    store.completeRun(run.id, {
      title: "Plan",
      status: "answered",
      coverageWarnings: [],
      blocks: [
        {
          text: derivedPassage.text,
          kind: "fact",
          citations: [
            {
              passageId: derivedPassage.id,
              quote: derivedPassage.text,
              start: 0,
              end: Array.from(derivedPassage.text).length,
            },
          ],
        },
      ],
    });
    const delayed = store.beginImport(n, "Plan", "delayed-promotion");

    store.purgeSource(n, source);

    assert.equal(
      store.one("SELECT removed FROM sources WHERE id=?", promoted).removed,
      1,
    );
    assert.deepEqual(store.selectedPassages(n, conversation), []);
    assert.equal(
      store.one("SELECT output FROM runs WHERE id=?", run.id).output,
      null,
    );
    assert.throws(
      () =>
        store.publishImport(
          n,
          delayed.id,
          "Plan",
          "note",
          null,
          Buffer.from(text),
          extracted,
          undefined,
          note,
          undefined,
          false,
          revision,
        ),
      /unavailable.*references/,
    );
    assert.equal(readdirSync(store.blobs).length, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing note conversations revalidate missing references before creating a run", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "codeboom-note-revalidation-"),
  );
  const store = new Store(root);
  try {
    const n = store.createNotebook("Personal").id;
    const bytes = Buffer.from("Budget is provisional.");
    const job = store.beginImport(n, "Evidence", "evidence");
    store.publishImport(
      n,
      job.id,
      "Evidence",
      "text",
      null,
      bytes,
      await extract(bytes, "text"),
    );
    const p = store.selectedPassages(n, store.view(n).conversations[0].id)[0];
    const note = store.createRichArtifact(
      n,
      "Plan",
      richFixture({
        passageId: p.id,
        quote: p.text,
        start: 0,
        end: Array.from(p.text).length,
      }),
    );
    const revision = store.view(n).artifacts[0].revision_id;
    const conversation = store.openNoteConversation(n, note, revision);
    // Simulate a snapshot retained by a version that did not cascade authored references.
    store.run("DELETE FROM passages WHERE id=?", p.id);
    assert.ok(store.selectedPassages(n, conversation.id).length);
    assert.throws(
      () =>
        store.createRun(
          n,
          conversation.id,
          "Question",
          "answer",
          "",
          "missing-reference",
        ),
      /unavailable.*references/,
    );
    assert.equal(store.one("SELECT count(*) AS count FROM runs").count, 0);
    store.purgeSource(n, p.sourceId);
    assert.deepEqual(store.selectedPassages(n, conversation.id), []);
    assert.equal(readdirSync(store.blobs).length, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("saved-note questions pin and reuse one revision without changing other selections or active runs", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-note-chat-"));
  const store = new Store(root);
  try {
    const n = store.createNotebook("Personal").id;
    const original = store.view(n).conversations[0].id;
    const bytes = Buffer.from("Other evidence");
    const job = store.beginImport(n, "Other", "other");
    store.publishImport(
      n,
      job.id,
      "Other",
      "text",
      null,
      bytes,
      await extract(bytes, "text"),
    );
    const selected = store.conversation(n, original).selected;
    const run = store.createRun(
      n,
      original,
      "Question",
      "answer",
      "",
      "active",
    );
    const generation = store.notebook(n).generation;
    const a = store.createRichArtifact(n, "My plan", richFixture());
    const rev = store
      .view(n)
      .artifacts.find((x: any) => x.id === a).revision_id;
    const c = store.openNoteConversation(n, a, rev);
    const context = store.noteContext(n, c.id);
    assert.deepEqual(JSON.parse(c.selected), [context.source_id]);
    assert.equal(store.conversation(n, original).selected, selected);
    assert.equal(store.notebook(n).generation, generation);
    assert.equal(
      store.one("SELECT status FROM runs WHERE id=?", run.id).status,
      "queued",
    );
    assert.equal(store.openNoteConversation(n, a, rev).id, c.id);
    assert.equal(
      store.one("SELECT count(*) AS count FROM sources WHERE derived_from=?", a)
        .count,
      1,
    );
    const ps = store.selectedPassages(n, c.id);
    assert.ok(ps.some((p) => p.text.includes("Approval remains pending.")));
    assert.ok(
      ps.every((p) => p.sourceId === context.source_id && p.derivedFrom === a),
    );
    assert.equal(store.sourceDerivation(n, ps[0].revisionId)!.revisionId, rev);
    assert.throws(() => store.setSelection(n, c.id, []), /pinned/);
    store.editRichArtifact(
      n,
      a,
      "Changed",
      {
        format: "rich-note",
        version: 1,
        doc: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Changed plan" }],
            },
          ],
        },
      },
      rev,
    );
    assert.equal(store.openNoteConversation(n, a, rev).id, c.id);
    assert.ok(
      !store
        .selectedPassages(n, c.id)
        .some((p) => p.text.includes("Changed plan")),
    );
    const newer = store
      .view(n)
      .artifacts.find((x: any) => x.id === a).revision_id;
    const next = store.openNoteConversation(n, a, newer);
    assert.notEqual(next.id, c.id);
    const imported = store.beginImport(n, "Later", "later");
    const laterBytes = Buffer.from("Later unrelated evidence");
    store.publishImport(
      n,
      imported.id,
      "Later",
      "text",
      null,
      laterBytes,
      await extract(laterBytes, "text"),
      undefined,
      undefined,
      undefined,
      false,
    );
    assert.equal(store.conversation(n, c.id).selected, c.selected);
    assert.equal(store.conversation(n, next.id).selected, next.selected);
    const refresh = store.beginImport(n, "Refresh", "refresh");
    assert.throws(
      () =>
        store.publishImport(
          n,
          refresh.id,
          "Changed",
          "note",
          null,
          bytes,
          { sections: [{ locator: "Text", text: "Changed" }], warnings: [] },
          context.source_id,
          a,
          undefined,
          false,
          rev,
        ),
      /cannot be refreshed/,
    );
    assert.equal(
      store.view(n).conversations.find((x: any) => x.id === c.id).note_revision,
      rev,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("note conversations survive restart and backup, and refuse foreign, empty, missing and purged content", () => {
  const base = mkdtempSync(
    path.join(os.tmpdir(), "codeboom-note-chat-backup-"),
  );
  let store = new Store(path.join(base, "data"));
  try {
    const n = store.createNotebook("Personal").id,
      other = store.createNotebook("Other").id;
    const a = store.createRichArtifact(n, "Plan", richFixture());
    const rev = store.view(n).artifacts[0].revision_id;
    assert.throws(() => store.openNoteConversation(other, a, rev), /not found/);
    assert.throws(
      () => store.openNoteConversation(n, a, "missing"),
      /not found/,
    );
    const empty = store.createRichArtifact(n, "Empty", {
      format: "rich-note",
      version: 1,
      doc: { type: "doc", content: [{ type: "paragraph" }] },
    });
    const emptyRev = store
      .view(n)
      .artifacts.find((x: any) => x.id === empty).revision_id;
    const count = readdirSync(store.blobs).length;
    assert.throws(
      () => store.openNoteConversation(n, empty, emptyRev),
      /no usable text/,
    );
    assert.equal(readdirSync(store.blobs).length, count);
    const c = store.openNoteConversation(n, a, rev);
    const source = store.noteContext(n, c.id).source_id;
    store.close();
    store = new Store(path.join(base, "data"));
    assert.equal(store.openNoteConversation(n, a, rev).id, c.id);
    store.close();
    backup(path.join(base, "data"), path.join(base, "backup"));
    restore(path.join(base, "backup"), path.join(base, "restored"));
    store = new Store(path.join(base, "restored"));
    assert.equal(store.openNoteConversation(n, a, rev).id, c.id);
    store.purgeSource(n, source);
    assert.throws(
      () => store.openNoteConversation(n, a, rev),
      /removed or purged/,
    );
    assert.throws(
      () => store.createRun(n, c.id, "Question", "answer", "", "purged"),
      /removed or purged/,
    );
    assert.equal(readdirSync(store.blobs).length, 0);
    store.deleteNotebook(n);
    assert.equal(
      store.one("SELECT count(*) AS count FROM note_conversations").count,
      0,
    );
  } finally {
    store.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("missing note references and failed context publication retain no snapshot, job or blob", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "codeboom-note-chat-failure-"),
  );
  const store = new Store(root);
  try {
    const n = store.createNotebook("Personal").id;
    const bytes = Buffer.from("Budget is provisional.");
    const job = store.beginImport(n, "Evidence", "evidence");
    const source = store.publishImport(
      n,
      job.id,
      "Evidence",
      "text",
      null,
      bytes,
      await extract(bytes, "text"),
    );
    const p = store.selectedPassages(n, store.view(n).conversations[0].id)[0];
    const a = store.createRichArtifact(
      n,
      "Referenced",
      richFixture({
        passageId: p.id,
        quote: p.text,
        start: 0,
        end: Array.from(p.text).length,
      }),
    );
    const revision = store.view(n).artifacts[0].revision_id;
    store.purgeSource(n, source);
    assert.throws(
      () => store.openNoteConversation(n, a, revision),
      /unavailable/,
    );
    assert.equal(
      store.one("SELECT count(*) AS count FROM note_conversations").count,
      0,
    );
    const clean = store.createRichArtifact(n, "Clean", richFixture());
    const cleanRevision = store
      .view(n)
      .artifacts.find((x: any) => x.id === clean).revision_id;
    const beforeJobs = store.one("SELECT count(*) AS count FROM jobs").count;
    const beforeSources = store.one(
      "SELECT count(*) AS count FROM sources",
    ).count;
    store.db.exec(
      "CREATE TRIGGER refuse_context BEFORE INSERT ON note_conversations BEGIN SELECT RAISE(ABORT,'fixture publication failure'); END;",
    );
    assert.throws(
      () => store.openNoteConversation(n, clean, cleanRevision),
      /fixture publication failure/,
    );
    assert.equal(
      store.one("SELECT count(*) AS count FROM jobs").count,
      beforeJobs,
    );
    assert.equal(
      store.one("SELECT count(*) AS count FROM sources").count,
      beforeSources,
    );
    assert.equal(readdirSync(store.blobs).length, 0);
    store.db.exec("DROP TRIGGER refuse_context");
    assert.ok(store.openNoteConversation(n, clean, cleanRevision).id);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
