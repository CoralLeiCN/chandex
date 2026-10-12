import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/storage/store.ts";
import { backup, restore } from "../src/storage/backup.ts";
import { extract } from "../src/ingestion/extract.ts";
import {
  NOTEBOOK_INSTRUCTIONS_LIMIT,
  notebookTags,
  recipe,
} from "../src/domain/notebooks.ts";
import { EvidenceTools } from "../src/retrieval/tools.ts";
import { studyAnswer } from "./fixtures/study.ts";
const data = {
  title: "Review 🦉",
  description: "Compare evidence",
  instructions: "Retain source qualifiers.",
  tags: ["Café", "Research"],
  questions: ["What remains uncertain?"],
};
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-library-"));
  return { root, store: new Store(root) };
}
test("notebook instructions share the template Unicode limit and reject invalid updates atomically", () => {
  const f = fixture();
  try {
    const instructions = "🦉".repeat(NOTEBOOK_INSTRUCTIONS_LIMIT);
    const n = f.store.createNotebook("Unicode instructions", { instructions });
    assert.equal(n.instructions, instructions);
    for (const invalid of [instructions + "x", "Invalid\0instructions"]) {
      assert.throws(() =>
        f.store.createNotebook("Invalid", { instructions: invalid }),
      );
      assert.throws(() =>
        f.store.updateNotebook(n.id, {
          title: "Must not change",
          instructions: invalid,
        }),
      );
    }
    assert.equal(f.store.notebook(n.id).title, "Unicode instructions");
    assert.equal(f.store.notebook(n.id).instructions, instructions);
    assert.equal(f.store.notebook(n.id).instruction_version, 1);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
async function publish(
  store: Store,
  n: string,
  title: string,
  text: string,
  previous?: string,
) {
  const bytes = Buffer.from(text),
    job = store.beginImport(n, title, crypto.randomUUID());
  return store.publishImport(
    n,
    job.id,
    title,
    "text",
    null,
    bytes,
    await extract(bytes, "text"),
    previous,
  );
}
test("tags normalize Unicode, deduplicate case, reject malformed labels and leave active evidence runs untouched", async () => {
  assert.deepEqual(notebookTags(["  Café ", "CAFÉ", "Study 🦉"]), [
    "Café",
    "Study 🦉",
  ]);
  assert.equal(notebookTags(["é".repeat(48)])[0].length, 48);
  for (const value of [
    null,
    [""],
    [1],
    Array(11).fill("x"),
    ["🦉".repeat(49)],
    ["a\nb"],
    ["x\0y"],
  ])
    assert.throws(() => notebookTags(value));
  const f = fixture();
  try {
    const n = f.store.createNotebook("Tags").id;
    await publish(f.store, n, "Evidence", "Ready evidence");
    const c = f.store.view(n).conversations[0].id,
      run = f.store.createRun(n, c, "Question", "answer", "", "tags-run"),
      old = f.store.notebook(n);
    f.store.updateNotebook(n, { tags: ["Café"], questions: ["Question?"] });
    const next = f.store.notebook(n);
    assert.equal(next.generation, old.generation);
    assert.equal(next.instruction_version, old.instruction_version);
    assert.equal(
      f.store.one("SELECT status FROM runs WHERE id=?", run.id).status,
      "queued",
    );
    f.store.updateNotebook(n, { tags: ["Café"], questions: ["Question?"] });
    assert.equal(f.store.notebook(n).updated, next.updated);
    assert.throws(() =>
      f.store.updateNotebook(n, { title: "Bad partial update", tags: [false] }),
    );
    assert.equal(f.store.notebook(n).title, "Tags");
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("template versions, personal copies and immutable empty notebook snapshots reject stale creation and never copy evidence", async () => {
  const f = fixture();
  try {
    const t = f.store.saveTemplate(data),
      n = f.store.createNotebook("Instantiated", {
        templateId: t.id,
        templateVersion: 1,
      }),
      view = f.store.view(n.id);
    assert.deepEqual(n.tags, data.tags);
    assert.deepEqual(n.starterQuestions, data.questions);
    assert.equal(n.instructions, data.instructions);
    assert.equal(n.instruction_version, 1);
    assert.equal(view.sources.length, 0);
    assert.equal(view.artifacts.length, 0);
    assert.equal(view.conversations.length, 1);
    assert.deepEqual(view.conversations[0].selected, []);
    assert.equal(f.store.saveTemplate(data, t.id, 1).version, 1);
    const changed = f.store.saveTemplate(
      { ...data, instructions: "Changed recipe" },
      t.id,
      1,
    );
    assert.equal(changed.version, 2);
    assert.throws(
      () =>
        f.store.createNotebook("Stale", {
          templateId: t.id,
          templateVersion: 1,
        }),
      /changed/,
    );
    assert.equal(f.store.notebooks().length, 1);
    assert.throws(() => f.store.saveTemplate(data, t.id, 1), /changed/);
    assert.throws(() => f.store.deleteTemplate(t.id, 1), /changed/);
    f.store.deleteTemplate(t.id, 2);
    assert.equal(f.store.notebook(n.id).instructions, data.instructions);
    assert.equal(f.store.notebook(n.id).templateSnapshot.version, 1);
    const builtin = f.store.templates()[0];
    assert.throws(() => f.store.saveTemplate(data, builtin.id, 1), /read-only/);
    assert.throws(() => f.store.deleteTemplate(builtin.id, 1), /read-only/);
    assert.equal(
      f.store.saveTemplate({ ...data, title: builtin.title }).builtin,
      false,
    );
    assert.throws(
      () => recipe({ ...data, sources: ["foreign"] }),
      /only settings/,
    );
    assert.throws(() => recipe({ ...data, questions: ["a\nb"] }));
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("discovery joins current active revisions, filters tags/archive and never expands a scoped tool manifest", async () => {
  const f = fixture();
  try {
    const a = f.store.createNotebook("Évidence 🦉", { tags: ["Café"] }).id,
      b = f.store.createNotebook("Other", { tags: ["Study"] }).id,
      c = f.store.createNotebook("Archived").id;
    f.store.updateNotebook(c, { archived: true });
    const sa = await publish(
        f.store,
        a,
        "Report",
        "Pilot budget oldmarker 240 🦉",
      ),
      sb = await publish(f.store, b, "Other report", "Pilot budget beta 500"),
      sc = await publish(
        f.store,
        c,
        "Archived report",
        "Pilot budget archived 900",
      );
    assert.equal(f.store.discover("ÉVIDENCE").results[0].notebookId, a);
    assert.equal(
      f.store.discover("🦉").results.some((r) => r.kind === "passage"),
      true,
    );
    assert.deepEqual(
      f.store
        .discover("budget", { tag: "CAFÉ" })
        .results.map((r) => r.notebookId),
      [a],
    );
    assert.equal(f.store.discover("budget").results.length, 2);
    assert.equal(
      f.store.discover("budget", { archived: true }).results.length,
      3,
    );
    const first = f.store.discover("budget", { limit: 1 });
    assert.equal(first.nextOffset, 1);
    assert.notEqual(
      first.results[0].id,
      f.store.discover("budget", { limit: 1, offset: 1 }).results[0].id,
    );
    await publish(
      f.store,
      a,
      "Report refreshed",
      "Pilot budget newmarker 250 🦉",
      sa,
    );
    assert.equal(f.store.discover("oldmarker").results.length, 0);
    assert.equal(f.store.discover("newmarker").results.length, 1);
    f.store.removeSource(b, sb);
    assert.equal(f.store.discover("beta").results.length, 0);
    f.store.purgeSource(c, sc);
    assert.equal(f.store.discover("900", { archived: true }).results.length, 0);
    const own = f.store.selectedPassages(
        a,
        f.store.view(a).conversations[0].id,
      ),
      foreign = f.store.selectedPassages(
        b,
        f.store.view(b).conversations[0].id,
      );
    assert.equal(foreign.length, 0);
    const foreignPassage = f.store.all(
      "SELECT id FROM passages WHERE source_id=?",
      sb,
    )[0].id;
    const tools = new EvidenceTools(own, () => [], 20, 200000);
    assert.throws(
      () =>
        tools.invoke("notebook_read_passage", { passageId: foreignPassage }),
      /Unknown|unknown|outside|not selected/,
    );
    assert.throws(() => f.store.discover("x", { limit: 51 }));
    assert.throws(() => f.store.discover("x", { offset: -1 }));
    assert.throws(() => f.store.discover("x".repeat(201)));
    assert.deepEqual(f.store.discover('" OR *').results, []);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("note search updates atomically, purge removes generated text while retaining authored edits, and notebook deletion clears indices", async () => {
  const f = fixture();
  try {
    const n = f.store.createNotebook("Notes").id,
      s = await publish(f.store, n, "Evidence", "Generated canary finding"),
      conversation = f.store.view(n).conversations[0].id,
      p = f.store.selectedPassages(n, conversation)[0],
      run = f.store.createRun(
        n,
        conversation,
        "Finding",
        "summary",
        "fixture",
        "note-search",
      );
    const answer = {
      status: "answered",
      title: "Finding",
      blocks: [
        {
          kind: "fact",
          text: p.text,
          citations: [
            {
              passageId: p.id,
              start: 0,
              end: Array.from(p.text).length,
              quote: p.text,
            },
          ],
        },
      ],
      coverageWarnings: [],
    };
    // A flat legacy-compatible generated revision is enough to exercise storage purge/index behavior.
    f.store.run("UPDATE runs SET kind='answer' WHERE id=?", run.id);
    f.store.completeRun(run.id, answer as any);
    const generated = f.store.saveArtifact(
        n,
        "Generated",
        "summary",
        JSON.stringify(answer),
        false,
        run.id,
      ),
      edited = f.store.saveArtifact(
        n,
        "Edited",
        "summary",
        JSON.stringify(answer),
        false,
        run.id,
      );
    f.store.editArtifact(
      n,
      edited,
      "Authored 🦉",
      "My retained ownmarker annotation",
    );
    const study = studyAnswer(p, "quiz");
    study.items![0].question = "Unique questionneedle about evidence";
    f.store.saveArtifact(
      n,
      "Practice",
      "quiz",
      JSON.stringify(study),
      false,
      run.id,
    );
    assert.ok(
      f.store.discover("questionneedle").results.some((r) => r.kind === "note"),
    );
    assert.ok(
      f.store.discover("canary").results.some((r) => r.id === generated),
    );
    assert.equal(
      f.store.discover("canary").results.some((r) => r.id === edited),
      false,
    );
    assert.ok(
      f.store.discover("ownmarker").results.some((r) => r.id === edited),
    );
    f.store.purgeSource(n, s);
    assert.equal(f.store.discover("canary").results.length, 0);
    assert.equal(f.store.discover("questionneedle").results.length, 0);
    assert.ok(
      f.store.discover("ownmarker").results.some((r) => r.id === edited),
    );
    f.store.deleteNotebook(n);
    assert.equal(f.store.discover("ownmarker").results.length, 0);
    assert.equal(f.store.one("SELECT count(*) AS n FROM note_fts").n, 0);
  } finally {
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("organization metadata, templates and note search survive restart and stopped backup/restore", async () => {
  const f = fixture(),
    snap = f.root + "-backup",
    restored = f.root + "-restored";
  let store = f.store;
  try {
    const t = store.saveTemplate(data),
      n = store.createNotebook("Backup", {
        templateId: t.id,
        templateVersion: t.version,
      }).id;
    store.saveArtifact(
      n,
      "Saved note",
      "note",
      JSON.stringify({ text: "Durable librarymarker" }),
      true,
    );
    store.close();
    store = new Store(f.root);
    assert.equal(store.discover("librarymarker").results.length, 1);
    assert.equal(store.template(t.id).version, 1);
    store.close();
    backup(f.root, snap);
    restore(snap, restored);
    store = new Store(restored);
    assert.deepEqual(store.notebook(n).tags, data.tags);
    assert.equal(store.notebook(n).templateSnapshot.id, t.id);
    assert.equal(store.discover("librarymarker").results.length, 1);
    assert.equal(store.template(t.id).instructions, data.instructions);
    assert.equal(
      store.one("SELECT max(version) AS version FROM migrations").version,
      17,
    );
  } finally {
    store.close();
    for (const p of [f.root, snap, restored])
      rmSync(p, { recursive: true, force: true });
  }
});
test("migration 12 backfills saved notes from a genuine schema-11 shape without rewriting prior notebook instructions or evidence", async () => {
  const f = fixture();
  let store = f.store;
  try {
    const n = store.createNotebook("Legacy notebook", {
      instructions: "Prior instructions",
    }).id;
    await publish(store, n, "Old source", "Earlier source evidence");
    store.saveArtifact(
      n,
      "Earlier note",
      "note",
      JSON.stringify({ text: "Backfill legacyneedle 🦉" }),
      true,
    );
    const before = store.view(n);
    store.db.exec(
      "DROP TABLE note_drafts; ALTER TABLE revisions DROP COLUMN kind; ALTER TABLE revisions DROP COLUMN provider_metadata; DROP TABLE note_conversations; DROP TABLE speech_assets; DROP TABLE speech_jobs; DROP TRIGGER note_search_insert; DROP TRIGGER note_search_update; DROP TRIGGER note_search_delete; DROP TABLE note_fts; DROP TABLE notebook_templates; ALTER TABLE notebooks DROP COLUMN tags; ALTER TABLE notebooks DROP COLUMN starter_questions; ALTER TABLE notebooks DROP COLUMN template_snapshot; DELETE FROM migrations WHERE version>=12;",
    );
    store.close();
    store = new Store(f.root);
    const after = store.view(n);
    assert.equal(after.instructions, before.instructions);
    assert.equal(after.generation, before.generation);
    assert.deepEqual(after.tags, []);
    assert.deepEqual(after.starterQuestions, []);
    assert.equal(after.templateSnapshot, null);
    assert.deepEqual(after.sources, before.sources);
    assert.equal(store.discover("legacyneedle").results.length, 1);
  } finally {
    store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
