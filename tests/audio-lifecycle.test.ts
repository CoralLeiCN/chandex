import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.ts";
import { NotebookService } from "../src/server/service.ts";
import { backup, restore } from "../src/storage/backup.ts";
import { normalizeAudioTranscript } from "../src/ingestion/audio-transcript.ts";
import { decodeAudio } from "../src/ingestion/audio-decode.ts";
import { EXTRACTION_VERSION } from "../src/ingestion/version.ts";
import { fetchPublic } from "../src/ingestion/url.ts";
import { validateAnswer, type Answer } from "../src/domain/evidence.ts";
import { sourceViewer } from "../src/web/source-viewer.ts";
import {
  fileAccept,
  fileType,
  sourceType,
} from "../src/domain/source-types.ts";

const transcript = () =>
  normalizeAudioTranscript(
    {
      text: "Approval is still pending. Do not start the rollout.",
      chunks: [
        { text: "Approval is still pending.", timestamp: [5.36, 7.08] },
        { text: " Do not start the rollout.", timestamp: [7.08, 8.56] },
      ],
    },
    8.62325,
  );
const codex = {
  run: async () => {
    throw Error("Audio import must not invoke answer generation");
  },
  status: async () => ({}),
} as any;

test("audio revisions retain originals, warnings, exact transcript citations, historical refresh, retry, backup and purge", async () => {
  const root = mkdtempSync(join(tmpdir(), "codeboom-audio-lifecycle-")),
    snapshot = root + "-backup",
    restored = root + "-restore";
  let store = new Store(root);
  // Storage/service fixture seam: actual model/Worker recognition is checked
  // separately with installed assets, not made a hidden npm-test dependency.
  const ingestion = {
    fetch: fetchPublic,
    extract: async (bytes: Buffer) => {
      const decoded = await decodeAudio(bytes);
      const result = transcript();
      return { ...result, warnings: [...decoded.warnings, ...result.warnings] };
    },
  };
  let service = new NotebookService(store, codex, ingestion);
  try {
    const n = store.createNotebook("Audio notebook").id,
      conversation = store.view(n).conversations[0].id;
    const bytes = readFileSync(
      new URL("./fixtures/audio/speech.wav", import.meta.url),
    );
    const job = store.beginImport(n, "Speech.wav", "audio-first", {
      kind: "audio",
    });
    await service.import(n, job.id, {
      title: "Speech.wav",
      kind: "audio",
      bytes,
    });
    const completed = store.importJob(n, job.id);
    assert.equal(completed.status, "completed");
    const source = completed.source_id,
      revision = store.one("SELECT * FROM revisions WHERE source_id=?", source);
    assert.equal(revision.extractor, EXTRACTION_VERSION);
    assert.deepEqual(store.sourceOriginal(n, source, revision.id), bytes);
    const passages = store.selectedPassages(n, conversation),
      p = passages[0],
      quote = "Approval is still pending.";
    assert.match(p.locator, /Audio 1.*estimated/);
    assert.ok(p.warnings!.some((warning) => warning.includes("can invent")));
    const answer: Answer = {
      status: "answered",
      title: "Pending approval",
      blocks: [
        {
          kind: "fact",
          text: quote,
          citations: [
            { passageId: p.id, start: 0, end: Array.from(quote).length, quote },
          ],
        },
      ],
      coverageWarnings: [],
    };
    validateAnswer(answer, passages);
    const run = store.createRun(
      n,
      conversation,
      "Is approval final?",
      "answer",
      "fixture",
      "audio-cited-run",
    );
    store.completeRun(run.id, answer);
    const note = store.saveArtifact(
      n,
      "Audio note",
      "note",
      JSON.stringify(answer),
      false,
      run.id,
    );
    const detail = sourceViewer({
      ...store.one(
        "SELECT * FROM sources WHERE notebook_id=? AND id=?",
        n,
        source,
      ),
      revisions: [revision],
      passages,
    } as any);
    assert.ok(
      detail.warnings.some((warning: string) =>
        warning.includes("Automatic English transcript"),
      ),
    );
    const duplicate = store.beginImport(n, "Same.wav", "audio-duplicate", {
      kind: "audio",
    });
    await service.import(n, duplicate.id, {
      title: "Same.wav",
      kind: "audio",
      bytes,
    });
    assert.equal(store.importJob(n, duplicate.id).status, "duplicate");
    store.resolveDuplicate(n, duplicate.id, "reuse");
    assert.equal(store.one("SELECT count(*) AS count FROM revisions").count, 1);
    const bad = store.beginImport(n, "Bad.wav", "audio-bad", { kind: "audio" });
    await service.import(n, bad.id, {
      title: "Bad.wav",
      kind: "audio",
      bytes: Buffer.from("SOURCE_PRIVATE_CANARY"),
    });
    assert.equal(store.importJob(n, bad.id).status, "failed");
    assert.doesNotMatch(
      store.importJob(n, bad.id).error,
      /SOURCE_PRIVATE_CANARY/,
    );
    const retry = store.beginImport(
      n,
      "Fixed.m4a",
      "audio-retry",
      { kind: "audio" },
      bad.id,
    );
    await service.import(n, retry.id, {
      title: "Fixed.m4a",
      kind: "audio",
      bytes: readFileSync(
        new URL("./fixtures/audio/speech.m4a", import.meta.url),
      ),
    });
    assert.equal(store.importJob(n, retry.id).status, "completed");
    assert.equal(store.importJob(n, retry.id).retry_of, bad.id);
    const other = store.createNotebook("Other").id;
    assert.throws(
      () => store.sourceOriginal(other, source, revision.id),
      /unavailable/,
    );
    assert.throws(() => store.passage(other, p.id), /unavailable/);
    const refresh = store.beginImport(n, "Changed.mp3", "audio-refresh", {
      kind: "audio",
      sourceId: source,
    });
    await service.import(n, refresh.id, {
      title: "Changed.mp3",
      kind: "audio",
      sourceId: source,
      bytes: readFileSync(
        new URL("./fixtures/audio/speech.mp3", import.meta.url),
      ),
    });
    assert.equal(store.importJob(n, refresh.id).status, "completed");
    assert.deepEqual(store.sourceOriginal(n, source, revision.id), bytes);
    assert.equal(store.passage(n, p.id)!.text, p.text);
    validateAnswer(answer, [store.passage(n, p.id)!]);
    service.shutdown();
    store.close();
    backup(root, snapshot);
    restore(snapshot, restored);
    store = new Store(restored);
    service = new NotebookService(store, codex, ingestion);
    assert.equal(store.passage(n, p.id)!.extractionVersion, EXTRACTION_VERSION);
    assert.deepEqual(store.sourceOriginal(n, source, revision.id), bytes);
    store.purgeSource(n, source);
    assert.throws(() => store.passage(n, p.id), /unavailable/);
    assert.throws(
      () => store.sourceOriginal(n, source, revision.id),
      /unavailable/,
    );
    assert.equal(
      store.one("SELECT unavailable FROM artifacts WHERE id=?", note)
        .unavailable,
      1,
    );
  } finally {
    service.shutdown();
    store.close();
    for (const directory of [root, snapshot, restored])
      rmSync(directory, { recursive: true, force: true });
  }
});

test("audio admission and cancellation prevent late transcript publication without retaining a backlog", async () => {
  const root = mkdtempSync(join(tmpdir(), "codeboom-audio-stop-")),
    store = new Store(root);
  const pending: ((value: ReturnType<typeof transcript>) => void)[] = [];
  const service = new NotebookService(store, codex, {
    fetch: fetchPublic,
    extract: async () => new Promise((resolve) => pending.push(resolve)),
  });
  try {
    const n = store.createNotebook("Audio cancellation").id,
      bytes = Buffer.from("synthetic admission fixture");
    const jobs = Array.from({ length: 3 }, (_, i) =>
      store.beginImport(n, "Speech.wav", "audio-limit-" + i, { kind: "audio" }),
    );
    const running = jobs.map((job) =>
      service.import(n, job.id, { title: "Speech.wav", kind: "audio", bytes }),
    );
    assert.equal(service.imports.size, 2);
    assert.equal(pending.length, 2);
    assert.match(store.importJob(n, jobs[2].id).error, /capacity/);
    service.shutdown();
    pending.forEach((resolve) => resolve(transcript()));
    await Promise.all(running);
    assert.equal(store.one("SELECT count(*) AS count FROM sources").count, 0);
    assert.equal(service.imports.size, 0);
    assert.equal(service.importControllers.size, 0);
    for (const job of jobs)
      assert.equal(store.importJob(n, job.id).status, "failed");
  } finally {
    service.shutdown();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the file picker and source badge advertise only the enabled English audio import family", () => {
  for (const extension of [
    "wav",
    "mp3",
    "m4a",
    "aac",
    "flac",
    "ogg",
    "oga",
    "opus",
  ]) {
    assert.equal(fileType("recording." + extension)?.kind, "audio");
    assert.ok(fileAccept.includes("." + extension));
  }
  assert.equal(sourceType("audio")?.badge, "AUD");
  assert.match(sourceType("audio")!.label, /Automatic English/);
});
