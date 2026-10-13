import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import { Store } from "../src/storage/store.ts";
import { NotebookService, canonicalDriveLink } from "../src/server/service.ts";
import { DriveClient, type DriveSnapshot } from "../src/ingestion/drive.ts";
import { extractIsolated } from "../src/ingestion/service.ts";
import { backup, restore } from "../src/storage/backup.ts";
import { sourceViewer } from "../src/web/source-viewer.ts";
import {
  wordFixture,
  slidesFixture,
  workbookFixture,
} from "./fixtures/office.ts";

const id = "Synthetic_Drive_123",
  link = `https://drive.google.com/file/d/${id}/view`,
  secret = "synthetic-sharing-key";
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const md5 = (bytes: Buffer) => createHash("md5").update(bytes).digest("hex");
function fixture(
  drive: Pick<DriveClient, "retrieve">,
  extract = extractIsolated,
) {
  const root = mkdtempSync(join(tmpdir(), "codeboom-drive-import-")),
    data = join(root, "data"),
    store = new Store(data);
  const n = store.createNotebook("Drive fixture").id,
    other = store.createNotebook("Other notebook").id;
  const service = new NotebookService(
    store,
    {
      run: async () => assert.fail("Unexpected provider run"),
      status: async () => ({
        available: false,
        authenticated: false,
        version: "0.161.0",
        models: [],
      }),
    },
    {
      fetch: async () => assert.fail("Drive import used public URL fetch"),
      extract,
      drive,
    },
  );
  let closed = false;
  const closeStore = () => {
    if (!closed) {
      store.close();
      closed = true;
    }
  };
  return {
    closeStore,
    root,
    data,
    store,
    service,
    n,
    other,
    cleanup() {
      service.shutdown();
      closeStore();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function snapshot(bytes: Buffer, version = "1"): DriveSnapshot {
  return {
    bytes,
    kind: "text",
    name: "Personal notes.txt",
    origin: link,
    retrievedAt: "2026-10-10T12:00:00.000Z",
    provenance: {
      provider: "google-drive",
      id,
      name: "Personal notes.txt",
      mimeType: "text/plain",
      version,
      modifiedTime: "2026-10-10T12:00:00.000Z",
      representation: "binary",
      size: String(bytes.length),
      md5Checksum: md5(bytes),
      sha256: hash(bytes),
    },
    warnings: ["Synthetic Drive retrieval fixture"],
  };
}
async function imported(
  f: ReturnType<typeof fixture>,
  key: string,
  sourceId?: string,
  driveUrl = link,
) {
  const job = f.store.beginImport(f.n, "Personal note", key, {
    kind: "drive",
    driveUrl: canonicalDriveLink(driveUrl),
    ...(sourceId ? { sourceId } : {}),
  });
  await f.service.import(f.n, job.id, {
    title: job.title,
    kind: "drive",
    driveUrl,
    sourceId,
  });
  return f.store.importJob(f.n, job.id);
}
test("Drive imports publish isolated passages, safe immutable provenance and exact bytes; duplicate/revision identity includes provider version", async () => {
  const bytes = Buffer.from("Do not approve £40. Café 🦉."),
    revisions = [snapshot(bytes), snapshot(bytes), snapshot(bytes, "2")];
  Object.assign(revisions[0].provenance, {
    accessToken: "must-not-persist",
    resourceKey: secret,
  });
  const f = fixture({ retrieve: async () => revisions.shift()! });
  try {
    const job = await imported(
      f,
      "first",
      undefined,
      link + "?resourcekey=" + secret,
    );
    assert.equal(job.status, "completed");
    const source = f.store.view(f.n).sources[0],
      revision = source.current_revision;
    const row = f.store.one("SELECT * FROM revisions WHERE id=?", revision),
      provider = JSON.parse(row.provider_metadata);
    assert.deepEqual(provider, snapshot(bytes).provenance);
    assert.doesNotMatch(
      row.provider_metadata,
      /must-not-persist|synthetic-sharing-key/,
    );
    assert.equal(row.retrieved_at, snapshot(bytes).retrievedAt);
    assert.doesNotMatch(job.input_metadata, new RegExp(secret));
    assert.match(row.warnings, /sharing access key is not saved/);
    const conversation = f.store.view(f.n).conversations[0].id,
      passage = f.store.selectedPassages(f.n, conversation)[0];
    assert.equal(passage.text, bytes.toString());
    assert.deepEqual(passage.drive, provider);
    assert.deepEqual(f.store.sourceOriginal(f.n, source.id, revision), bytes);
    await assert.rejects(
      async () => f.store.sourceOriginal(f.other, source.id, revision),
      /unavailable/,
    );
    const view = sourceViewer({
      ...source,
      revisions: [row],
      passages: [passage],
    });
    assert.deepEqual(view.provenance?.drive, provider);
    const duplicate = await imported(f, "duplicate");
    assert.equal(duplicate.status, "duplicate");
    assert.equal(
      f.store.resolveDuplicate(f.n, duplicate.id, "reuse").status,
      "completed",
    );
    const refreshed = await imported(f, "refresh", source.id);
    assert.equal(refreshed.status, "completed");
    const current = f.store.view(f.n).sources[0];
    assert.notEqual(current.current_revision, revision);
    assert.equal(
      JSON.parse(
        f.store.one(
          "SELECT provider_metadata FROM revisions WHERE id=?",
          current.current_revision,
        ).provider_metadata,
      ).version,
      "2",
    );
    assert.equal(f.store.passage(f.n, passage.id).drive?.version, "1");
    assert.deepEqual(f.store.sourceOriginal(f.n, source.id, revision), bytes);
    assert.equal(f.store.view(f.other).sources.length, 0);
  } finally {
    f.cleanup();
  }
});

test("Real Drive adapter and Office workers publish Docs/Sheets/Slides exports with their selected representation and locators", async () => {
  for (const [mime, bytes, locator] of [
    ["application/vnd.google-apps.document", wordFixture(), "Paragraph"],
    ["application/vnd.google-apps.spreadsheet", workbookFixture(), "Sheet"],
    ["application/vnd.google-apps.presentation", slidesFixture(), "Slide"],
  ] as const) {
    const meta = {
      id,
      name: "Synthetic native file",
      mimeType: mime,
      version: "90071992547409931234",
      modifiedTime: "2026-10-10T12:00:00Z",
      trashed: false,
      capabilities: { canDownload: true },
    };
    let call = 0;
    const client = new DriveClient(
      async () => "synthetic-private-token",
      async (_url, request) => {
        assert.equal(
          (request.headers as Record<string, string>).Authorization,
          "Bearer synthetic-private-token",
        );
        call++;
        return call === 2
          ? new Response(new Uint8Array(bytes), {
              headers: {
                "content-type": mime.endsWith("document")
                  ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  : mime.endsWith("spreadsheet")
                    ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    : "application/vnd.openxmlformats-officedocument.presentationml.presentation",
              },
            })
          : Response.json(meta);
      },
    );
    const f = fixture(client);
    try {
      const job = await imported(f, "native");
      assert.equal(job.status, "completed", job.error);
      const source = f.store.view(f.n).sources[0],
        passages = f.store.selectedPassages(
          f.n,
          f.store.view(f.n).conversations[0].id,
        );
      assert.equal(passages[0].drive?.representation, "workspace-export");
      assert.match(passages[0].locator, new RegExp(locator, "i"));
      assert.deepEqual(
        f.store.sourceOriginal(f.n, source.id, source.current_revision),
        bytes,
      );
      assert.doesNotMatch(
        JSON.stringify(f.store.view(f.n)),
        /synthetic-private-token/,
      );
      assert.equal(call, 3);
    } finally {
      f.cleanup();
    }
  }
});

test("Failed Drive imports support explicit linked retries and refuse source/duplicate ownership crossing", async () => {
  let count = 0;
  const bytes = Buffer.from("Retry evidence");
  const f = fixture({
    retrieve: async () => {
      if (++count === 1) throw Error("Drive file unavailable.");
      return snapshot(bytes);
    },
  });
  try {
    const failed = await imported(f, "failed");
    assert.equal(failed.status, "failed");
    assert.equal(f.store.view(f.n).sources.length, 0);
    const retried = f.service.retryImport(f.n, failed.id, "retry");
    const deadline = Date.now() + 2000;
    while (
      f.store.importJob(f.n, retried.id).status === "processing" &&
      Date.now() < deadline
    )
      await setImmediate();
    const completed = f.store.importJob(f.n, retried.id);
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(completed.retry_of, failed.id);
    assert.equal(completed.attempt_count, 2);
    assert.throws(
      () => f.service.retryImport(f.other, failed.id, "foreign"),
      /not found/i,
    );
    assert.equal(f.service.retryImport(f.n, failed.id, "retry").id, retried.id);
    const foreign = f.store.beginImport(
      f.other,
      "Foreign refresh",
      "foreign-refresh",
      { kind: "drive", driveUrl: link, sourceId: completed.source_id },
    );
    await f.service.import(f.other, foreign.id, {
      title: "Foreign refresh",
      kind: "drive",
      driveUrl: link,
      sourceId: completed.source_id,
    });
    assert.equal(f.store.importJob(f.other, foreign.id).status, "failed");
    assert.equal(f.store.view(f.other).sources.length, 0);
  } finally {
    f.cleanup();
  }
});

test("Drive disconnect blocks new jobs, cancels pending retrieval/worker publication, waits for cleanup and retains prior snapshots", async () => {
  for (const phase of ["retrieval", "worker"]) {
    const bytes = Buffer.from("Keep saved evidence"),
      source = snapshot(bytes);
    let active = false;
    const hang = (signal?: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        active = true;
        signal!.addEventListener(
          "abort",
          () => reject(Error("Import cancelled.")),
          { once: true },
        );
      });
    let first = true;
    const f = fixture(
      {
        retrieve: async (_input, options) => {
          if (!first && phase === "retrieval") return hang(options?.signal);
          return source;
        },
      },
      async (input, kind, options) => {
        if (!first && phase === "worker") return hang(options?.signal);
        return extractIsolated(input, kind, options);
      },
    );
    try {
      const saved = await imported(f, "saved");
      first = false;
      const job = f.store.beginImport(f.n, "Pending", "pending", {
        kind: "drive",
        driveUrl: link,
      });
      const pending = f.service.import(f.n, job.id, {
        title: job.title,
        kind: "drive",
        driveUrl: link,
      });
      while (!active) await setImmediate();
      let release!: () => void;
      const disconnected = f.service.disconnectDrive(async () => {
        assert.equal(f.service.imports.size, 0);
        await new Promise<void>((r) => {
          release = r;
        });
      });
      await pending;
      while (!release) await setImmediate();
      const blocked = await imported(f, "blocked");
      assert.equal(blocked.status, "failed");
      assert.match(blocked.error, /Connect/);
      release();
      await disconnected;
      assert.equal(f.store.importJob(f.n, job.id).status, "failed");
      assert.equal(f.store.view(f.n).sources.length, 1);
      assert.deepEqual(
        f.store.sourceOriginal(
          f.n,
          saved.source_id,
          f.store.view(f.n).sources[0].current_revision,
        ),
        bytes,
      );
    } finally {
      f.cleanup();
    }
  }
});

test("Drive provenance survives restart/backup/restore without credentials and purge removes retained content", async () => {
  const bytes = Buffer.from("Backup evidence"),
    f = fixture({ retrieve: async () => snapshot(bytes) });
  let reopened: Store | undefined;
  try {
    const job = await imported(f, "backup"),
      source = f.store.view(f.n).sources[0],
      passage = f.store.selectedPassages(
        f.n,
        f.store.view(f.n).conversations[0].id,
      )[0];
    f.closeStore();
    const target = join(f.root, "backup"),
      restored = join(f.root, "restored");
    backup(f.data, target);
    const manifest = JSON.parse(
      readFileSync(join(target, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.schema, 18);
    restore(target, restored);
    assert.doesNotMatch(
      readFileSync(join(target, "codeboom.sqlite")).toString(),
      /synthetic-private-token|synthetic-sharing-key|accessToken|refreshToken/,
    );
    reopened = new Store(restored);
    assert.deepEqual(
      reopened.passage(f.n, passage.id).drive,
      snapshot(bytes).provenance,
    );
    assert.deepEqual(
      reopened.sourceOriginal(f.n, job.source_id, source.current_revision),
      bytes,
    );
    reopened.purgeSource(f.n, source.id);
    assert.throws(() => reopened!.passage(f.n, passage.id), /unavailable/);
    assert.throws(
      () => reopened!.sourceOriginal(f.n, source.id, source.current_revision),
      /unavailable/,
    );
  } finally {
    reopened?.close();
    f.cleanup();
  }
});
