import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/store.ts";
import { extract } from "../src/ingestion/extract.ts";
import { validateAnswer, type Answer } from "../src/domain/evidence.ts";
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
    assert.equal(await add(f.store, n, "Original evidence 🦉", "retry"), s);
    const old = f.store.selectedPassages(n, c)[0];
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
test("restart marks unfinished runs interrupted without replaying them", async () => {
  const f = fixture();
  try {
    const n = f.store.createNotebook("A").id,
      c = f.store.view(n).conversations[0].id;
    await add(f.store, n, "Evidence");
    const r = f.store.createRun(n, c, "Question", "answer", "", "run");
    f.store.close();
    f.store = new Store(f.root);
    assert.equal(
      f.store.one("SELECT status FROM runs WHERE id=?", r.id).status,
      "interrupted",
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
    f.store.purgeSource(n, s);
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
