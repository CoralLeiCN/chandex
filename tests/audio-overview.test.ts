import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  rmSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.ts";
import { backup, restore } from "../src/storage/backup.ts";
import { chunkText, digest, validateAnswer } from "../src/domain/evidence.ts";
import { documentText } from "../src/domain/artifacts.ts";
import {
  overviewSpeechText,
  validateSpeechText,
  SPEECH_NOTICE,
  SPEECH_PROVIDER_ID,
  speechVoice,
} from "../src/domain/audio-overview.ts";
import {
  validateSpeechAudio,
  SPEECH_MAX_BYTES,
} from "../src/media/speech-audio.ts";
import { renderSpeechIsolated } from "../src/media/speech-process.ts";
import { SpeechService } from "../src/server/speech-service.ts";
import { extract } from "../src/ingestion/extract.ts";
import { NotebookService } from "../src/server/service.ts";
import {
  seedOverview,
  overviewAnswer,
  speechWav,
  speechResult,
} from "./fixtures/audio-overview.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codeboom-overview-")),
    store = new Store(join(root, "data"));
  return {
    root,
    store,
    close() {
      if (store.db.isOpen) store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const begin = (
  store: Store,
  f: { n: string; a: string; revision: string },
  key: string,
  voice = "samantha",
) => store.speech.begin(f.n, f.a, f.revision, SPEECH_PROVIDER_ID, voice, key);

test("spoken scripts retain all evidence classifications, empty sections and coverage warnings", () => {
  const p = chunkText(
      "Approval is still pending.",
      "source",
      "revision",
      "Proposal",
    )[0],
    answer = overviewAnswer(p);
  validateAnswer(answer, [p], "audio-overview");
  const text = overviewSpeechText(answer);
  assert.ok(text.startsWith(SPEECH_NOTICE));
  for (const block of answer.blocks) assert.ok(text.includes(block.text));
  assert.match(text, /Interpretation\. The proposal is not/);
  assert.match(text, /Evidence limitation\. The source/);
  assert.match(text, /Differences\n\nNo supported content/);
  assert.match(text, /Coverage notes\.\n\nOnly the selected proposal/);
  assert.match(documentText(answer), /Inference: The proposal/);
  assert.match(documentText(answer), /Evidence limitation: The source/);
  const forged = structuredClone(answer);
  forged.blocks[0].citations[0].quote = "approved";
  assert.throws(
    () => validateAnswer(forged, [p], "audio-overview"),
    /quote|span/i,
  );
  assert.throws(
    () => overviewSpeechText({ ...answer, status: "insufficient_evidence" }),
    /supported/,
  );
});

test("speech rejects commands, incomplete Unicode, empty text and complete-text overflow before execution", async () => {
  for (const text of [
    "",
    " \n",
    "[[rate 999]]approved",
    "end]]",
    "x\u0000",
    "x\ud800",
    "e\u0301",
    "word ".repeat(701),
    "x".repeat(8001),
  ]) {
    assert.throws(() => validateSpeechText(text));
    await assert.rejects(
      renderSpeechIsolated(text, "samantha", { stageRoot: "/unowned-unused" }),
    );
  }
  validateSpeechText("Café 🦉 isn't approved.\nCheck all 300 units.");
  assert.throws(() => speechVoice("Samantha; rm -rf /"), /supported/);
  const p = chunkText("Evidence", "s", "r", "Source")[0],
    answer = overviewAnswer(p);
  answer.blocks[0].text = "word ".repeat(680); // Additional headings and notices count too.
  assert.throws(
    () => validateAnswer(answer, [p], "audio-overview"),
    /700-word/,
  );
});

test("speech publication independently enforces WAV format, duration, bytes and usable amplitude", () => {
  assert.equal(validateSpeechAudio(speechWav()).duration, 0.1);
  for (const bytes of [
    speechWav({ rate: 16000 }),
    speechWav({ channels: 2 }),
    speechWav({ silent: true }),
    speechWav({ seconds: 300.01 }),
    Buffer.alloc(SPEECH_MAX_BYTES + 1),
    Buffer.from("not audio"),
  ])
    assert.throws(() => validateSpeechAudio(bytes));
  const truncated = speechWav().subarray(0, 100);
  assert.throws(() => validateSpeechAudio(truncated));
});

test("speech jobs pin exact generated revisions, settings, ownership and bounded concurrency", async () => {
  const f = fixture(),
    { store } = f;
  try {
    const one = await seedOverview(store),
      other = store.createNotebook("Other").id;
    const job = begin(store, one, "one");
    assert.equal(begin(store, one, "one").id, job.id);
    assert.equal(job.script_hash, digest(overviewSpeechText(one.answer)));
    assert.throws(() => begin(store, one, "one", "daniel"), /Idempotency/);
    assert.throws(() => begin(store, one, "duplicate"), /already rendering/);
    assert.throws(
      () =>
        store.speech.begin(
          one.n,
          one.a,
          one.revision,
          "remote",
          "samantha",
          "remote",
        ),
      /provider/,
    );
    assert.throws(
      () => store.speech.script(other, one.a, one.revision),
      /not found/i,
    );
    const two = await seedOverview(store, one.n, "two");
    begin(store, two, "two");
    const three = await seedOverview(store, one.n, "three");
    assert.throws(() => begin(store, three, "three"), /capacity/);
    store.speech.cancel(one.n, one.a, job.id);
    const retry = store.speech.retry(one.n, one.a, job.id, "retry");
    assert.equal(retry.retry_of, job.id);
    assert.equal(
      store.speech.retry(one.n, one.a, job.id, "retry").id,
      retry.id,
    );
    assert.throws(
      () => store.speech.retry(one.n, one.a, job.id, "second-retry"),
      /already has a retry/,
    );
    store.speech.cancel(one.n, one.a, retry.id);
    store.editArtifact(one.n, one.a, "Authored edit", "Rewritten script");
    const edited = store
      .view(one.n)
      .artifacts.find((a: any) => a.id === one.a).revision_id;
    assert.throws(
      () => store.speech.script(one.n, one.a, edited),
      /supported generated/,
    );
    assert.equal(
      store.speech.script(one.n, one.a, one.revision).text,
      overviewSpeechText(one.answer),
    );
  } finally {
    f.close();
  }
});

test("asset publication is atomic and rejects mismatched renderer data, cancellation and SQL faults", async () => {
  const f = fixture(),
    { store } = f;
  try {
    const one = await seedOverview(store),
      job = begin(store, one, "publish"),
      before = readdirSync(store.blobs);
    for (const result of [
      { ...speechResult(), voiceId: "daniel" },
      { ...speechResult(), rendererVersion: 99 },
      { ...speechResult(), bytes: speechWav({ silent: true }) },
    ]) {
      assert.throws(() => store.speech.publish(one.n, one.a, job.id, result));
      assert.deepEqual(readdirSync(store.blobs), before);
    }
    store.db.exec(
      "CREATE TRIGGER speech_test_fault BEFORE INSERT ON speech_assets BEGIN SELECT RAISE(ABORT,'controlled publication fault'); END;",
    );
    assert.throws(
      () => store.speech.publish(one.n, one.a, job.id, speechResult()),
      /controlled/,
    );
    assert.deepEqual(readdirSync(store.blobs), before);
    assert.equal(store.speech.job(one.n, one.a, job.id).status, "processing");
    store.db.exec("DROP TRIGGER speech_test_fault");
    const asset = store.speech.publish(one.n, one.a, job.id, speechResult())!;
    assert.deepEqual(
      store.speech.asset(one.n, one.a, asset).bytes,
      speechWav(),
    );
    assert.equal(
      store.speech.publish(one.n, one.a, job.id, speechResult()),
      null,
    );
    const cancelled = begin(store, one, "cancelled");
    store.speech.cancel(one.n, one.a, cancelled.id);
    assert.equal(
      store.speech.publish(one.n, one.a, cancelled.id, speechResult()),
      null,
    );
    const stored = store.speech.asset(one.n, one.a, asset).asset;
    writeFileSync(join(store.blobs, stored.blob), "tampered");
    assert.throws(() => store.speech.asset(one.n, one.a, asset), /integrity/);
  } finally {
    f.close();
  }
});

test("speech survives source removal and edits, records generated-audio ancestry, and purge deletes owned media", async () => {
  const f = fixture(),
    { store } = f;
  try {
    const one = await seedOverview(store),
      job = begin(store, one, "asset"),
      result = speechResult();
    const id = store.speech.publish(one.n, one.a, job.id, result)!,
      asset = store.speech.asset(one.n, one.a, id).asset;
    assert.deepEqual(store.speech.importedAudio(one.n, digest(result.bytes)), {
      artifactId: one.a,
      revisionId: one.revision,
    });
    assert.equal(
      store.speech.importedAudio(
        store.createNotebook("Foreign").id,
        digest(result.bytes),
      ),
      null,
    );
    store.editArtifact(one.n, one.a, "Edited", "Authored annotation");
    const derived = store.publishImport(
      one.n,
      store.beginImport(one.n, "Derived", "derived").id,
      "Derived",
      "audio",
      null,
      result.bytes,
      await extract(Buffer.from("Synthetic transcript"), "text"),
      undefined,
      one.a,
      undefined,
      false,
      one.revision,
    );
    assert.equal(
      store.sourceDerivation(
        one.n,
        store.one("SELECT current_revision FROM sources WHERE id=?", derived)
          .current_revision,
      )?.revisionId,
      one.revision,
    );
    store.removeSource(one.n, one.passage.sourceId);
    store.editArtifact(one.n, one.a, "Edited", "Authored annotation");
    assert.deepEqual(store.speech.asset(one.n, one.a, id).bytes, result.bytes);
    store.purgeSource(one.n, one.passage.sourceId);
    assert.throws(() => store.speech.asset(one.n, one.a, id), /unavailable/);
    assert.throws(
      () => store.speech.importedAudio(one.n, digest(result.bytes)),
      /unavailable/,
    );
    assert.equal(existsSync(join(store.blobs, asset.blob)), false);
    assert.equal(
      store.one("SELECT blob FROM speech_assets WHERE id=?", id).blob,
      null,
    );
    assert.equal(
      store.one("SELECT blob FROM revisions WHERE source_id=?", derived).blob,
      null,
    );
    assert.equal(store.speech.job(one.n, one.a, job.id).status, "unavailable");
    assert.match(
      store.view(one.n).artifacts.find((a: any) => a.id === one.a).content.text,
      /Authored annotation/,
    );
  } finally {
    f.close();
  }
});

test("reimporting an owned generated recording automatically pins its original script and warns against corroboration", async () => {
  const f = fixture(),
    { store } = f;
  try {
    const one = await seedOverview(store),
      job = begin(store, one, "recording"),
      result = speechResult();
    store.speech.publish(one.n, one.a, job.id, result);
    store.editArtifact(one.n, one.a, "Later edit", "Authored annotation");
    const service = new NotebookService(
      store,
      {
        run: async () => one.answer,
        status: async () => ({
          available: true,
          authenticated: true,
          version: "fixture",
          models: [],
        }),
      },
      {
        fetch: async () => {
          throw Error("No network in this fixture");
        },
        extract: async () =>
          extract(
            Buffer.from(
              "Synthetic transcript; not native recognition evidence.",
            ),
            "text",
          ),
      },
    );
    const imported = store.beginImport(
      one.n,
      "Generated recording",
      "recognized",
      { kind: "audio" },
    );
    await service.import(one.n, imported.id, {
      kind: "audio",
      title: "Generated recording",
      bytes: result.bytes,
    });
    const source = store.importJob(one.n, imported.id).source_id,
      revision = store.one(
        "SELECT current_revision FROM sources WHERE id=?",
        source,
      ).current_revision;
    assert.equal(
      store.sourceDerivation(one.n, revision)?.revisionId,
      one.revision,
    );
    assert.match(
      store.one("SELECT warnings FROM revisions WHERE id=?", revision).warnings,
      /not independent corroborating evidence/,
    );
    store.purgeSource(one.n, one.passage.sourceId);
    assert.equal(
      store.one("SELECT blob FROM revisions WHERE id=?", revision).blob,
      null,
    );
    service.shutdown();
  } finally {
    f.close();
  }
});

test("restart interrupts speech jobs, removes abandoned staging and preserves referenced audio blobs", async () => {
  const f = fixture();
  let store = f.store;
  try {
    const one = await seedOverview(store),
      complete = begin(store, one, "complete"),
      id = store.speech.publish(one.n, one.a, complete.id, speechResult())!;
    const pending = begin(store, one, "pending");
    mkdirSync(join(store.root, "speech-staging", "abandoned"), {
      recursive: true,
    });
    writeFileSync(
      join(store.root, "speech-staging", "abandoned", "speech.wav"),
      "partial",
    );
    const root = store.root;
    store.close();
    store = new Store(root);
    assert.equal(
      store.speech.job(one.n, one.a, pending.id).status,
      "interrupted",
    );
    assert.equal(existsSync(join(root, "speech-staging")), false);
    assert.deepEqual(store.speech.asset(one.n, one.a, id).bytes, speechWav());
    assert.equal(
      store.speech.retry(one.n, one.a, pending.id, "restart-retry").retry_of,
      pending.id,
    );
    store.deleteNotebook(one.n);
    assert.equal(
      store.one("SELECT count(*) AS count FROM speech_assets").count,
      0,
    );
    assert.equal(readdirSync(store.blobs).length, 0);
  } finally {
    if (store.db.isOpen) store.close();
    f.close();
  }
});

test("schema 13 backups restore exact speech and reject missing or tampered media references", async () => {
  const f = fixture();
  let store = f.store;
  try {
    const one = await seedOverview(store),
      job = begin(store, one, "backup"),
      id = store.speech.publish(one.n, one.a, job.id, speechResult())!;
    const asset = store.speech.asset(one.n, one.a, id).asset,
      data = store.root;
    store.close();
    const saved = join(f.root, "backup");
    backup(data, saved);
    restore(saved, join(f.root, "restored"));
    store = new Store(join(f.root, "restored"));
    assert.deepEqual(store.speech.asset(one.n, one.a, id).bytes, speechWav());
    store.close();
    const manifestFile = join(saved, "manifest.json"),
      manifest = JSON.parse(readFileSync(manifestFile, "utf8")),
      originalManifest = JSON.stringify(manifest);
    assert.equal(manifest.schema, 19);
    assert.equal(manifest.hashes["blobs/" + asset.blob], asset.hash);
    delete manifest.hashes["blobs/" + asset.blob];
    writeFileSync(manifestFile, JSON.stringify(manifest));
    assert.throws(
      () => restore(saved, join(f.root, "missing")),
      /missing source evidence/,
    );
    assert.equal(existsSync(join(f.root, "missing")), false);
    writeFileSync(manifestFile, originalManifest);
    writeFileSync(join(saved, "blobs", asset.blob), "tampered");
    assert.throws(
      () => restore(saved, join(f.root, "tampered")),
      /hash mismatch/,
    );
  } finally {
    if (store.db.isOpen) store.close();
    f.close();
  }
});

test("speech service sanitizes provider diagnostics and retries with immutable text and explicit voice", async () => {
  const f = fixture(),
    { store } = f;
  try {
    const one = await seedOverview(store),
      first = begin(store, one, "failure");
    let calls = 0;
    const service = new SpeechService(store, async (text, voice, options) => {
      calls++;
      assert.equal(text, overviewSpeechText(one.answer));
      assert.equal(voice, "samantha");
      assert.equal(options.stageRoot, join(store.root, "speech-staging"));
      if (calls === 1) throw Error("PRIVATE_SOURCE_CANARY /private/secret");
      return speechResult(voice);
    });
    await service.execute(first.id);
    const failed = store.speech.job(one.n, one.a, first.id);
    assert.equal(failed.status, "failed");
    assert.doesNotMatch(failed.error, /PRIVATE_SOURCE_CANARY|private\/secret/);
    const retry = store.speech.retry(one.n, one.a, first.id, "retry");
    await service.execute(retry.id);
    await service.execute(retry.id);
    assert.equal(calls, 2);
    assert.equal(store.speech.job(one.n, one.a, retry.id).status, "completed");
    assert.equal(service.controllers.size, 0);
  } finally {
    f.close();
  }
});

test("late speech completion cannot publish after cancel, purge or shutdown, and duplicate execute never starts twice", async () => {
  for (const action of ["cancel", "purge", "shutdown"] as const) {
    const f = fixture(),
      { store } = f;
    try {
      const one = await seedOverview(store),
        job = begin(store, one, action);
      let finish!: (value: ReturnType<typeof speechResult>) => void,
        signal!: AbortSignal;
      const service = new SpeechService(
        store,
        async (_text, _voice, options) => {
          signal = options.signal!;
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      );
      const pending = service.execute(job.id);
      await service.execute(job.id);
      if (action === "cancel") service.cancel(one.n, one.a, job.id);
      else if (action === "purge") {
        service.cancelNotebook(one.n);
        store.purgeSource(one.n, one.passage.sourceId);
      } else service.shutdown();
      assert.equal(signal.aborted, true);
      finish(speechResult());
      await pending;
      assert.equal(service.controllers.size, 0);
      assert.equal(store.speech.list(one.n, one.a).assets.length, 0);
      assert.equal(
        store.speech.job(one.n, one.a, job.id).status,
        action === "purge" ? "unavailable" : "cancelled",
      );
    } finally {
      f.close();
    }
  }
});

test("cancelled speech retains per-revision and global capacity until the owning renderer settles", async () => {
  const f = fixture(),
    { store } = f;
  try {
    const one = await seedOverview(store),
      two = await seedOverview(store, one.n, "second"),
      three = await seedOverview(store, one.n, "third");
    const job = begin(store, one, "closing");
    let finish!: (value: ReturnType<typeof speechResult>) => void;
    const service = new SpeechService(
      store,
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = service.execute(job.id);
    service.cancel(one.n, one.a, job.id);
    assert.throws(
      () => store.speech.retry(one.n, one.a, job.id, "too-early"),
      /already rendering/,
    );
    begin(store, two, "second-active");
    assert.throws(() => begin(store, three, "too-many"), /capacity/);
    finish(speechResult());
    await pending;
    assert.equal(store.speech.rendering.size, 0);
    assert.equal(
      store.speech.retry(one.n, one.a, job.id, "after-exit").retry_of,
      job.id,
    );
  } finally {
    f.close();
  }
});
