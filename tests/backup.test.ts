import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/storage/store.ts";
import { backup, restore } from "../src/storage/backup.ts";
import { extract } from "../src/ingestion/extract.ts";
import { textPdf } from "./fixtures/pdf.ts";
test("backup restores notebook evidence and rejects modified bytes and active writers", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-backup-"));
  const data = path.join(root, "data");
  let store = new Store(data);
  try {
    const n = store.createNotebook("Research").id,
      j = store.beginImport(n, "Fixture", "i"),
      bytes = Buffer.from("Backup evidence 🦉");
    store.publishImport(
      n,
      j.id,
      "Fixture",
      "text",
      null,
      bytes,
      await extract(bytes, "text"),
    );
    const p = store.selectedPassages(n, store.view(n).conversations[0].id)[0];
    const duplicate = store.beginImport(n, "Duplicate", "pending-offer");
    store.publishImport(
      n,
      duplicate.id,
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
    const note = store.saveArtifact(
      n,
      "Before edit",
      "note",
      JSON.stringify({ text: "Promoted content" }),
      true,
    );
    const promotedBytes = Buffer.from("Promoted content");
    const promoted = store.publishImport(
      n,
      store.beginImport(n, "Promoted", "promoted").id,
      "Promoted",
      "note",
      null,
      promotedBytes,
      await extract(promotedBytes, "note"),
      undefined,
      note,
    );
    const promotedRevision = store.one(
      "SELECT current_revision FROM sources WHERE id=?",
      promoted,
    ).current_revision;
    const provenance = store.sourceDerivation(n, promotedRevision);
    store.editArtifact(n, note, "After edit", "Changed content");
    const failed = store.beginImport(n, "Retry fixture", "retry-parent", {
      kind: "url",
      url: "https://example.com/evidence",
    });
    store.run(
      "UPDATE jobs SET status='failed',error='Controlled fault' WHERE id=?",
      failed.id,
    );
    const retry = store.beginImport(
      n,
      "Retry fixture",
      "retry-child",
      { kind: "paste" },
      failed.id,
    );
    store.run(
      "UPDATE jobs SET status='failed',error='Controlled second fault' WHERE id=?",
      retry.id,
    );
    const retryRecord = store.importJob(n, retry.id);
    store.updateNotebook(n, { instructions: "Use audience A" });
    const run = store.createRun(
      n,
      store.view(n).conversations[0].id,
      "Backup question",
      "answer",
      "fixture",
      "instruction-run",
    );
    store.completeRun(run.id, {
      status: "insufficient_evidence",
      title: "Gap",
      blocks: [
        {
          kind: "notice",
          text: "No evidence for the question.",
          citations: [],
        },
      ],
      coverageWarnings: [],
    });
    const stats = {
      ...JSON.parse(run.stats),
      firstProgressMs: 10,
      elapsedMs: 1000,
      toolCalls: 2,
      evidenceCharacters: 1234,
      usage: {
        totalTokens: 100,
        inputTokens: 80,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 0,
        outputTokens: 20,
        reasoningOutputTokens: 5,
      },
      budgetReached: ["evidence_calls"],
      context: {
        modelContextWindow: 20000,
        reportedContextTokens: 600,
        chargedBytes: 1234,
        reservedTokens: 4000,
        capacityRefusals: 1,
      },
    };
    store.run(
      "UPDATE runs SET stats=? WHERE id=?",
      JSON.stringify(stats),
      run.id,
    );
    store.updateNotebook(n, { instructions: "Use audience B" });
    store.close();
    backup(data, path.join(root, "backup"));
    restore(path.join(root, "backup"), path.join(root, "restored"));
    store = new Store(path.join(root, "restored"));
    assert.equal(store.passage(n, p.id).text, "Backup evidence 🦉");
    assert.deepEqual(store.sourceDerivation(n, promotedRevision), provenance);
    assert.deepEqual(store.importJob(n, retry.id), retryRecord);
    const restoredRun = store.one("SELECT * FROM runs WHERE id=?", run.id);
    assert.equal(restoredRun.instruction_version, 2);
    assert.equal(restoredRun.instruction_snapshot, "Use audience A");
    assert.equal(restoredRun.grounding_mode, "sources");
    assert.deepEqual(JSON.parse(restoredRun.stats), stats);
    assert.deepEqual(
      store.view(n).runs.find((r: any) => r.id === run.id).stats,
      stats,
    );
    assert.equal(store.notebook(n).instruction_version, 3);
    assert.equal(store.notebook(n).instructions, "Use audience B");
    assert.ok(store.notebook(n).updated);
    assert.equal(
      store.one("SELECT status FROM jobs WHERE id=?", duplicate.id).status,
      "duplicate",
    );
    assert.equal(
      store.resolveDuplicate(n, duplicate.id, "reuse").source_id,
      p.sourceId,
    );
    store.close();
    const manifest = JSON.parse(
      readFileSync(path.join(root, "backup", "manifest.json"), "utf8"),
    );
    const blob = Object.keys(manifest.hashes).find((x) =>
      x.startsWith("blobs/"),
    )!;
    writeFileSync(path.join(root, "backup", blob), "tampered");
    assert.throws(
      () => restore(path.join(root, "backup"), path.join(root, "invalid")),
      /hash/,
    );
    writeFileSync(path.join(data, "server.lock"), String(process.pid));
    assert.throws(
      () => backup(data, path.join(root, "blocked")),
      /Stop Codeboom/,
    );
  } finally {
    if (store.db.isOpen) store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const legacy of [false, true])
  test(
    legacy
      ? "schema 15 migration backfills only current revision kinds and preserves unknown history"
      : "source revision kinds survive format-changing refresh, backup and restart",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-kinds-")),
        data = path.join(root, "data"),
        restored = path.join(root, "restored");
      let store = new Store(data);
      try {
        const n = store.createNotebook("Changing URL").id,
          origin = "https://example.com/changing",
          text = Buffer.from("ID3 tags describe the recording; this is text."),
          pdf = textPdf([["New PDF representation"]]);
        const source = store.publishImport(
          n,
          store.beginImport(n, "Source", "text").id,
          "Source",
          "text",
          origin,
          text,
          await extract(text, "text"),
        );
        const textRevision = store.one(
          "SELECT current_revision FROM sources WHERE id=?",
          source,
        ).current_revision;
        store.publishImport(
          n,
          store.beginImport(n, "Source", "pdf").id,
          "Source",
          "pdf",
          origin,
          pdf,
          await extract(pdf, "pdf"),
          source,
        );
        const pdfRevision = store.one(
          "SELECT current_revision FROM sources WHERE id=?",
          source,
        ).current_revision;
        assert.equal(
          store.one("SELECT kind FROM revisions WHERE id=?", textRevision).kind,
          "text",
        );
        if (legacy)
          store.db.exec(
            "ALTER TABLE revisions DROP COLUMN kind; DELETE FROM migrations WHERE version=16;",
          );
        store.close();
        backup(data, path.join(root, "backup"));
        assert.equal(
          JSON.parse(
            readFileSync(path.join(root, "backup", "manifest.json"), "utf8"),
          ).schema,
          legacy ? 15 : 16,
        );
        restore(path.join(root, "backup"), restored);
        store = new Store(restored);
        const markdown = Buffer.from("# Another representation");
        store.publishImport(
          n,
          store.beginImport(n, "Source", "markdown").id,
          "Source",
          "markdown",
          origin,
          markdown,
          await extract(markdown, "markdown"),
          source,
        );
        store.close();
        store = new Store(restored);
        assert.equal(
          store.one("SELECT kind FROM revisions WHERE id=?", textRevision).kind,
          legacy ? null : "text",
        );
        assert.equal(
          store.one("SELECT kind FROM revisions WHERE id=?", pdfRevision).kind,
          "pdf",
        );
        assert.equal(
          store.one(
            "SELECT r.kind FROM revisions r JOIN sources s ON s.current_revision=r.id WHERE s.id=?",
            source,
          ).kind,
          "markdown",
        );
        assert.deepEqual(store.sourceOriginal(n, source, textRevision), text);
        assert.deepEqual(store.sourceOriginal(n, source, pdfRevision), pdf);
      } finally {
        if (store.db.isOpen) store.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

test("schema 3 backups restore and migrate without losing evidence or completed runs", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-legacy-backup-"));
  let store = new Store(path.join(root, "data"));
  try {
    const n = store.createNotebook("Legacy notebook").id;
    const c = store.view(n).conversations[0].id;
    const bytes = Buffer.from("Legacy evidence");
    const job = store.beginImport(n, "Legacy", "legacy-import");
    store.publishImport(
      n,
      job.id,
      "Legacy",
      "text",
      null,
      bytes,
      await extract(bytes, "text"),
    );
    const r = store.createRun(
      n,
      c,
      "Unsupported question",
      "answer",
      "",
      "legacy-run",
    );
    store.completeRun(r.id, {
      status: "insufficient_evidence",
      title: "Evidence gap",
      blocks: [
        { kind: "notice", text: "No supporting evidence.", citations: [] },
      ],
      coverageWarnings: [],
    });
    store.db.exec(
      "ALTER TABLE revisions DROP COLUMN kind; ALTER TABLE revisions DROP COLUMN provider_metadata; DROP TABLE note_conversations; DROP TABLE speech_assets; DROP TABLE speech_jobs; DROP TRIGGER note_search_insert; DROP TRIGGER note_search_update; DROP TRIGGER note_search_delete; DROP TABLE note_fts; DROP TABLE notebook_templates; ALTER TABLE notebooks DROP COLUMN tags; ALTER TABLE notebooks DROP COLUMN starter_questions; ALTER TABLE notebooks DROP COLUMN template_snapshot;",
    );
    store.db.exec(
      "DROP TABLE quiz_attempts; ALTER TABLE runs DROP COLUMN study_count; ALTER TABLE notebooks DROP COLUMN instruction_version; ALTER TABLE notebooks DROP COLUMN updated; ALTER TABLE runs DROP COLUMN instruction_version; ALTER TABLE runs DROP COLUMN instruction_snapshot; ALTER TABLE runs DROP COLUMN grounding_mode; DROP TRIGGER jobs_lifecycle; DROP INDEX one_import_retry; ALTER TABLE jobs DROP COLUMN type; ALTER TABLE jobs DROP COLUMN input_kind; ALTER TABLE jobs DROP COLUMN input_metadata; ALTER TABLE jobs DROP COLUMN attempt_count; ALTER TABLE jobs DROP COLUMN retry_of; ALTER TABLE jobs DROP COLUMN started; ALTER TABLE jobs DROP COLUMN updated; ALTER TABLE jobs DROP COLUMN ended; ALTER TABLE runs DROP COLUMN error_category; ALTER TABLE runs DROP COLUMN failure_draft; ALTER TABLE sources DROP COLUMN requested_origin; ALTER TABLE revisions DROP COLUMN requested_origin; ALTER TABLE revisions DROP COLUMN retrieved_at; ALTER TABLE jobs DROP COLUMN duplicate_revision; ALTER TABLE revisions DROP COLUMN derived_revision; ALTER TABLE artifact_revisions DROP COLUMN title; DELETE FROM migrations WHERE version>=4",
    );
    store.close();
    backup(path.join(root, "data"), path.join(root, "backup"));
    assert.equal(
      JSON.parse(
        readFileSync(path.join(root, "backup", "manifest.json"), "utf8"),
      ).schema,
      3,
    );
    restore(path.join(root, "backup"), path.join(root, "restored"));
    store = new Store(path.join(root, "restored"));
    assert.equal(
      store.one("SELECT max(version) AS version FROM migrations").version,
      16,
    );
    assert.equal(
      store.one("SELECT status FROM runs WHERE id=?", r.id).status,
      "completed",
    );
    assert.equal(
      store.view(n).messages.filter((m: any) => m.role === "assistant").length,
      1,
    );
    assert.equal(store.selectedPassages(n, c)[0].text, "Legacy evidence");
    assert.equal(store.notebook(n).instruction_version, 1);
    assert.equal(store.notebook(n).updated, null);
    assert.equal(
      store.one("SELECT instruction_version FROM runs WHERE id=?", r.id)
        .instruction_version,
      null,
    );
    assert.equal(
      store.one("SELECT instruction_snapshot FROM runs WHERE id=?", r.id)
        .instruction_snapshot,
      null,
    );
  } finally {
    if (store.db.isOpen) store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
