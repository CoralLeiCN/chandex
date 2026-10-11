import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/store.ts";
import { NotebookService } from "../src/server/service.ts";
import { GenerationError, runtimeFailure } from "../src/codex/errors.ts";
import type { RunOptions } from "../src/codex/client.ts";
import type { Answer } from "../src/domain/evidence.ts";
import { initialRunStats } from "../src/domain/run-stats.ts";
import { extract } from "../src/ingestion/extract.ts";
import { structuredAnswer } from "./fixtures/structured.ts";

async function fixture(run: (options: RunOptions) => Promise<Answer>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-service-"));
  const store = new Store(root);
  const n = store.createNotebook("Fault fixture").id;
  const c = store.view(n).conversations[0].id;
  const bytes = Buffer.from("Fixture evidence");
  const job = store.beginImport(n, "Fixture", "import");
  store.publishImport(
    n,
    job.id,
    "Fixture",
    "text",
    null,
    bytes,
    await extract(bytes, "text"),
  );
  const service = new NotebookService(store, {
    run,
    status: async () => ({
      available: true,
      authenticated: true,
      version: "0.161.0",
      models: [],
    }),
  });
  return {
    store,
    service,
    n,
    c,
    cleanup() {
      service.shutdown();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const answer: Answer = {
  status: "insufficient_evidence",
  title: "Evidence gap",
  blocks: [
    {
      kind: "notice",
      text: "The evidence does not answer this question.",
      citations: [],
    },
  ],
  coverageWarnings: [],
};

test("provider error codes preserve authentication, rate-limit and unknown remote outcomes", () => {
  assert.equal(
    runtimeFailure("expired", "unauthorized").category,
    "authentication",
  );
  assert.equal(
    runtimeFailure("limited", "rateLimitExceeded").category,
    "rate_limit",
  );
  assert.equal(
    runtimeFailure("budget", "usageLimitExceeded").category,
    "rate_limit",
  );
  for (const [httpStatusCode, expected] of [
    [401, "authentication"],
    [429, "rate_limit"],
    [503, "interrupted"],
  ] as const)
    assert.equal(
      runtimeFailure("stream failure", {
        responseStreamConnectionFailed: { httpStatusCode },
      }).category,
      expected,
    );
  assert.equal(runtimeFailure("Codex process exited.").category, "interrupted");
});
test("unknown provider diagnostics never echo source or credential canaries", () => {
  for (const message of [
    "SOURCE_SECRET_CANARY credential=PRIVATE_TOKEN_CANARY",
    "unauthorized: credential=PRIVATE_TOKEN_CANARY",
    "Codex process exited. SOURCE_SECRET_CANARY",
  ]) {
    const failure = runtimeFailure(message, "other");
    assert.doesNotMatch(failure.message, /SECRET_CANARY|TOKEN_CANARY/);
    assert.doesNotMatch(JSON.stringify(failure), /SECRET_CANARY|TOKEN_CANARY/);
  }
});

test("run diagnostics persist measured progress and reported counters while unavailable usage remains unknown", async () => {
  const usage = {
    totalTokens: 100,
    inputTokens: 70,
    cachedInputTokens: 20,
    cacheWriteInputTokens: 0,
    outputTokens: 30,
    reasoningOutputTokens: 10,
  };
  const f = await fixture(async (input) => {
    input.onProgress?.({ type: "progress", text: "Reading selected evidence" });
    input.onStats?.({
      toolCalls: 3,
      evidenceCharacters: 1000,
      usage,
      budgetReached: ["evidence_calls"],
      context: {
        modelContextWindow: 20000,
        reportedContextTokens: 600,
        chargedBytes: 1234,
        reservedTokens: 4000,
        capacityRefusals: 1,
      },
    });
    return answer;
  });
  try {
    const run = f.store.createRun(
      f.n,
      f.c,
      "Question",
      "answer",
      "fixture",
      "stats",
    );
    assert.deepEqual(JSON.parse(run.stats), initialRunStats(1));
    await f.service.execute(run.id);
    const stats = f.store
      .view(f.n)
      .runs.find((r: any) => r.id === run.id).stats;
    assert.deepEqual(stats.usage, usage);
    assert.equal(stats.sourceCount, 1);
    assert.equal(stats.toolCalls, 3);
    assert.equal(stats.evidenceCharacters, 1000);
    assert.ok(
      stats.firstProgressMs >= 0 && stats.elapsedMs >= stats.firstProgressMs,
    );
    assert.deepEqual(stats.budgetReached, ["evidence_calls"]);
    assert.deepEqual(stats.context, {
      modelContextWindow: 20000,
      reportedContextTokens: 600,
      chargedBytes: 1234,
      reservedTokens: 4000,
      capacityRefusals: 1,
    });
    const timeout = new NotebookService(f.store, {
      ...f.service.codex,
      run: async () => {
        throw new GenerationError("timeout", "Controlled deadline");
      },
    });
    const failed = f.store.createRun(
      f.n,
      f.c,
      "Failed question",
      "answer",
      "fixture",
      "stats-failure",
    );
    await timeout.execute(failed.id);
    const interrupted = f.store
      .view(f.n)
      .runs.find((r: any) => r.id === failed.id);
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.stats.usage, null);
    assert.equal(interrupted.stats.toolCalls, null);
    assert.equal(interrupted.stats.firstProgressMs, null);
    assert.ok(interrupted.stats.elapsedMs >= 0);
    assert.deepEqual(interrupted.stats.budgetReached, ["deadline"]);
  } finally {
    f.cleanup();
  }
});

test("unchanged instructions and metadata edits preserve active generation; changed instructions cancel it", async () => {
  let resolve!: (answer: Answer) => void, options!: RunOptions;
  const f = await fixture(async (input) => {
    options = input;
    return new Promise((done) => {
      resolve = done;
    });
  });
  try {
    f.service.updateNotebook(f.n, { instructions: "Audience A" });
    const run = f.store.createRun(
      f.n,
      f.c,
      "Question",
      "answer",
      "",
      "metadata-run",
    );
    const execution = f.service.execute(run.id);
    f.service.updateNotebook(f.n, {
      title: "Renamed",
      instructions: "Audience A",
      archived: true,
    });
    assert.equal(options.signal?.aborted, false);
    assert.equal(f.store.active(run.id), true);
    assert.equal(f.store.notebook(f.n).instruction_version, 2);
    f.service.updateNotebook(f.n, { instructions: "Audience B" });
    assert.equal(options.signal?.aborted, true);
    assert.equal(f.store.notebook(f.n).instruction_version, 3);
    assert.equal(
      f.store.one("SELECT status FROM runs WHERE id=?", run.id).status,
      "cancelled",
    );
    assert.equal(options.instructions, "Audience A");
    resolve(answer);
    await execution;
    assert.equal(
      f.store.view(f.n).messages.filter((m: any) => m.role === "assistant")
        .length,
      0,
    );
  } finally {
    f.cleanup();
  }
});

test("history cannot reappear after instructions or selection return to an earlier value", async () => {
  const inputs: RunOptions[] = [];
  const f = await fixture(async (input) => {
    inputs.push(input);
    return {
      ...answer,
      blocks: [
        {
          kind: "notice",
          text: "HISTORY_CANARY_" + input.question,
          citations: [],
        },
      ],
    };
  });
  try {
    const ask = async (question: string) => {
      const run = f.store.createRun(f.n, f.c, question, "answer", "", question);
      await f.service.execute(run.id);
      assert.equal(
        f.store.one("SELECT status FROM runs WHERE id=?", run.id).status,
        "completed",
      );
      return run;
    };
    f.store.updateNotebook(f.n, { instructions: "Audience A" });
    const original = await ask("A-first");
    await ask("A-followup");
    assert.match(inputs[1].history!, /HISTORY_CANARY_A-first/);
    f.store.updateNotebook(f.n, { instructions: "Audience B" });
    await ask("B-first");
    assert.equal(inputs[2].history, "[]");
    f.store.updateNotebook(f.n, { instructions: "Audience A" });
    const reverted = await ask("A-returned");
    assert.equal(reverted.context_key, original.context_key);
    assert.notEqual(reverted.generation, original.generation);
    assert.equal(inputs[3].history, "[]");
    assert.equal(inputs[3].instructions, "Audience A");
    await ask("Returned-followup");
    assert.match(inputs[4].history!, /HISTORY_CANARY_A-returned/);
    assert.doesNotMatch(
      inputs[4].history!,
      /HISTORY_CANARY_A-first|HISTORY_CANARY_A-followup|HISTORY_CANARY_B-first/,
    );
    const selected = JSON.parse(f.store.conversation(f.n, f.c).selected);
    f.store.setSelection(f.n, f.c, []);
    f.store.setSelection(f.n, f.c, selected);
    const reselected = await ask("Selection-returned");
    assert.equal(reselected.context_key, reverted.context_key);
    assert.equal(inputs[5].history, "[]");
    assert.equal(inputs[5].passages.length, 1);
    assert.equal(
      f.store.view(f.n).messages.filter((m: any) => m.role === "assistant")
        .length,
      6,
    );
  } finally {
    f.cleanup();
  }
});

test("generation faults save distinct categories and explicit retries never duplicate completed outputs", async () => {
  for (const category of [
    "authentication",
    "rate_limit",
    "invalid_output",
    "timeout",
    "interrupted",
    "runtime",
  ] as const) {
    let calls = 0;
    const f = await fixture(async () => {
      if (++calls === 1)
        throw new GenerationError(category, "Synthetic " + category + " fault");
      return {
        ...answer,
        kind: "summary",
        sections: [
          { key: "key_points", blockIndexes: [] },
          { key: "limitations", blockIndexes: [0] },
        ],
      };
    });
    try {
      const r = f.store.createRun(f.n, f.c, "Question", "summary", "", "first");
      await f.service.execute(r.id);
      const failed = f.store.one("SELECT * FROM runs WHERE id=?", r.id);
      assert.equal(failed.error_category, category);
      assert.equal(
        failed.status,
        ["timeout", "interrupted"].includes(category)
          ? "interrupted"
          : "failed",
      );
      assert.equal(f.store.all("SELECT * FROM artifacts").length, 0);
      const event = JSON.parse(
        f.store.one(
          "SELECT data FROM events WHERE run_id=? ORDER BY seq DESC",
          r.id,
        ).data,
      );
      assert.equal(event.category, category);
      assert.equal(event.type, failed.status);
      const retry = f.store.createRun(
        f.n,
        f.c,
        "Question",
        "summary",
        "",
        "retry",
        r.id,
      );
      await Promise.all([
        f.service.execute(retry.id),
        f.service.execute(retry.id),
      ]);
      await f.service.execute(retry.id);
      assert.equal(calls, 2);
      assert.equal(f.store.all("SELECT * FROM artifacts").length, 1);
      assert.equal(
        f.store.one("SELECT retry_of FROM runs WHERE id=?", retry.id).retry_of,
        r.id,
      );
      assert.equal(
        f.store.createRun(f.n, f.c, "Question", "summary", "", "retry", r.id)
          .id,
        retry.id,
      );
      assert.throws(
        () =>
          f.store.createRun(
            f.n,
            f.c,
            "Question",
            "summary",
            "",
            "third",
            retry.id,
          ),
        /Invalid retry/,
      );
      const events = f.store.all(
        "SELECT * FROM events WHERE run_id=?",
        retry.id,
      ).length;
      f.service.cancel(f.n, retry.id);
      assert.equal(
        f.store.one("SELECT status FROM runs WHERE id=?", retry.id).status,
        "completed",
      );
      assert.equal(
        f.store.all("SELECT * FROM events WHERE run_id=?", retry.id).length,
        events,
      );
    } finally {
      f.cleanup();
    }
  }
});

test("cancellation and source mutation suppress late results, progress and failures", async () => {
  for (const mutation of [false, true]) {
    let resolve!: (answer: Answer) => void;
    let options!: RunOptions;
    const f = await fixture(async (input) => {
      options = input;
      return new Promise((done) => {
        resolve = done;
      });
    });
    try {
      const r = f.store.createRun(f.n, f.c, "Question", "answer", "", "first");
      const execution = f.service.execute(r.id);
      if (mutation) {
        f.service.cancelNotebook(f.n);
        f.store.setSelection(f.n, f.c, []);
      } else {
        f.service.cancel(f.n, r.id);
        f.service.cancel(f.n, r.id);
      }
      assert.equal(options.signal?.aborted, true);
      const count = f.store.all(
        "SELECT * FROM events WHERE run_id=?",
        r.id,
      ).length;
      options.onProgress?.({
        type: "progress",
        text: "Late provider progress",
      });
      resolve(answer);
      await execution;
      assert.equal(
        f.store.all("SELECT * FROM events WHERE run_id=?", r.id).length,
        count,
      );
      assert.equal(
        f.store.view(f.n).messages.filter((m: any) => m.role === "assistant")
          .length,
        0,
      );
      assert.equal(
        f.store.one("SELECT status FROM runs WHERE id=?", r.id).status,
        "cancelled",
      );
      assert.equal(f.service.controllers.size, 0);
    } finally {
      f.cleanup();
    }
  }
});

test("failed parsing is retryable and cannot publish partial source revisions", async () => {
  const f = await fixture(async () => answer);
  try {
    const bad = f.store.beginImport(f.n, "Broken", "broken");
    await f.service.import(f.n, bad.id, {
      title: "Broken",
      kind: "pdf",
      bytes: Buffer.from("not a PDF"),
    });
    assert.equal(
      f.store.one("SELECT status FROM jobs WHERE id=?", bad.id).status,
      "failed",
    );
    assert.equal(f.store.view(f.n).sources.length, 1);
    const retry = f.store.beginImport(
      f.n,
      "Fixed",
      "fixed",
      { kind: "text" },
      bad.id,
    );
    await Promise.all([
      f.service.import(f.n, retry.id, {
        title: "Fixed",
        kind: "text",
        bytes: Buffer.from("Recovered source"),
      }),
      f.service.import(f.n, retry.id, {
        title: "Fixed",
        kind: "text",
        bytes: Buffer.from("Recovered source"),
      }),
    ]);
    assert.equal(
      f.store.one("SELECT status FROM jobs WHERE id=?", retry.id).status,
      "completed",
    );
    assert.equal(f.store.view(f.n).sources.length, 2);
    const record = f.store.importJob(f.n, retry.id);
    assert.equal(record.attempt_count, 2);
    assert.equal(record.retry_of, bad.id);
    assert.equal(record.input_kind, "text");
    assert.ok(record.started && record.ended && record.updated);
    assert.deepEqual(JSON.parse(record.input_metadata), { kind: "text" });
    assert.equal(f.service.imports.size, 0);
  } finally {
    f.cleanup();
  }
});

test("stored URL-refresh retries preserve the source and dispatch once per linked attempt", async () => {
  const f = await fixture(async () => answer);
  let service: NotebookService | undefined;
  try {
    const bytes = Buffer.from("Previous URL snapshot"),
      url = "https://example.com/proposal";
    const source = f.store.publishImport(
      f.n,
      f.store.beginImport(f.n, "URL", "url-source").id,
      "URL",
      "text",
      url,
      bytes,
      await extract(bytes, "text"),
    );
    let fetches = 0;
    service = new NotebookService(f.store, f.service.codex, {
      fetch: async (requested) => {
        assert.equal(requested, url);
        if (++fetches === 1) throw new Error("Controlled download fault");
        return {
          bytes: Buffer.from("Refreshed URL snapshot"),
          url,
          contentType: "text/plain",
          retrievedAt: new Date().toISOString(),
        };
      },
      extract: async (bytes, kind) => extract(bytes, kind),
    });
    const descriptor = { kind: "url", url, sourceId: source };
    const first = f.store.beginImport(f.n, "URL", "refresh-first", descriptor);
    await service.import(f.n, first.id, { title: "URL", ...descriptor });
    assert.equal(f.store.importJob(f.n, first.id).status, "failed");
    const retry = service.retryImport(f.n, first.id, "refresh-retry");
    assert.equal(
      service.retryImport(f.n, first.id, "refresh-retry").id,
      retry.id,
    );
    for (let i = 0; i < 30 && service.imports.size; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(fetches, 2);
    const completed = f.store.importJob(f.n, retry.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.type, "refresh");
    assert.equal(completed.source_id, source);
    assert.equal(completed.attempt_count, 2);
    assert.equal(
      f.store.all("SELECT id FROM revisions WHERE source_id=?", source).length,
      2,
    );
    assert.equal(f.store.view(f.n).sources.length, 2);
    assert.throws(
      () =>
        f.store.beginImport(
          f.n,
          "Wrong",
          "wrong-operation",
          { kind: "paste" },
          first.id,
        ),
      /already has a retry/,
    );
    const removed = f.store.beginImport(
      f.n,
      "URL",
      "removed-refresh",
      descriptor,
    );
    f.store.run("UPDATE jobs SET status='failed' WHERE id=?", removed.id);
    f.store.removeSource(f.n, source);
    assert.equal(
      service.retryImport(f.n, first.id, "refresh-retry").id,
      retry.id,
    );
    assert.throws(
      () => service!.retryImport(f.n, removed.id, "refresh-retry"),
      /another import attempt/,
    );
    assert.throws(
      () => service!.retryImport(f.n, removed.id, "removed-retry"),
      /unavailable/,
    );
  } finally {
    service?.shutdown();
    f.cleanup();
  }
});

test("promotion retries retain the exact note edit and refuse purged or foreign ancestry", async () => {
  const f = await fixture(async () => answer);
  let service: NotebookService | undefined;
  try {
    const note = f.store.saveArtifact(
      f.n,
      "Original",
      "note",
      JSON.stringify({ text: "Pinned original text" }),
      true,
    );
    const revision = f.store.one(
      "SELECT id FROM artifact_revisions WHERE artifact_id=?",
      note,
    ).id;
    const descriptor = {
      kind: "note",
      derivedFrom: note,
      derivedRevision: revision,
    };
    const job = f.store.beginImport(
      f.n,
      "Original",
      "failed-promotion",
      descriptor,
    );
    f.store.run(
      "UPDATE jobs SET status='failed',error='Controlled fault' WHERE id=?",
      job.id,
    );
    f.store.editArtifact(f.n, note, "Edited later", "Changed annotation");
    let extracts = 0;
    service = new NotebookService(f.store, f.service.codex, {
      fetch: async () => {
        throw new Error("Unexpected URL fetch");
      },
      extract: async (bytes, kind) => {
        extracts++;
        assert.equal(bytes.toString(), "Pinned original text");
        return extract(bytes, kind);
      },
    });
    const retry = service.retryImport(f.n, job.id, "promotion-retry");
    assert.equal(
      service.retryImport(f.n, job.id, "promotion-retry").id,
      retry.id,
    );
    for (let i = 0; i < 30 && service.imports.size; i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(extracts, 1);
    const completed = f.store.importJob(f.n, retry.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.type, "promotion");
    const source = f.store.one(
      "SELECT current_revision FROM sources WHERE id=?",
      completed.source_id,
    );
    assert.deepEqual(
      f.store.sourceDerivation(f.n, source.current_revision)!.content,
      { text: "Pinned original text" },
    );
    const unavailable = f.store.beginImport(
      f.n,
      "Original",
      "unavailable-promotion",
      descriptor,
    );
    f.store.run("UPDATE jobs SET status='failed' WHERE id=?", unavailable.id);
    f.store.run("UPDATE artifacts SET unavailable=1 WHERE id=?", note);
    assert.throws(
      () => service!.retryImport(f.n, unavailable.id, "purged-retry"),
      /unavailable/,
    );
    const other = f.store.createNotebook("Other").id;
    assert.throws(
      () => service!.retryImport(other, job.id, "foreign-retry"),
      /not found/,
    );
    const file = f.store.beginImport(f.n, "File", "file-failure", {
      kind: "pdf",
    });
    f.store.run("UPDATE jobs SET status='failed' WHERE id=?", file.id);
    assert.throws(
      () => service!.retryImport(f.n, file.id, "no-file-retry"),
      /input again/,
    );
  } finally {
    service?.shutdown();
    f.cleanup();
  }
});

test("imports enforce admission capacity, persist redirect provenance and stop on shutdown", async () => {
  const f = await fixture(async () => answer);
  const pending: { resolve: (value: any) => void; signal: AbortSignal }[] = [];
  const fetches: string[] = [];
  const service = new NotebookService(f.store, f.service.codex, {
    fetch: async (url) => {
      fetches.push(url);
      return {
        bytes: Buffer.from("Redirected source"),
        url: "https://public.example/final",
        contentType: "text/plain",
        retrievedAt: "2026-10-09T10:00:00.000Z",
      };
    },
    extract: async (_bytes, _kind, options) =>
      new Promise((resolve, reject) => {
        const signal = options!.signal!;
        signal.addEventListener(
          "abort",
          () => reject(new Error("Import cancelled.")),
          { once: true },
        );
        pending.push({ resolve, signal });
      }),
  });
  try {
    const a = f.store.beginImport(f.n, "A", "capacity-a");
    const b = f.store.beginImport(f.n, "B", "capacity-b");
    const rejected = f.store.beginImport(f.n, "C", "capacity-c");
    const runningA = service.import(f.n, a.id, {
      title: "A",
      kind: "text",
      bytes: Buffer.from("A evidence"),
    });
    const runningB = service.import(f.n, b.id, {
      title: "B",
      kind: "url",
      url: "https://public.example/requested",
    });
    await Promise.resolve();
    await service.import(f.n, rejected.id, {
      title: "C",
      kind: "text",
      bytes: Buffer.from("C evidence"),
    });
    assert.equal(service.imports.size, 2);
    assert.match(
      f.store.one("SELECT error FROM jobs WHERE id=?", rejected.id).error,
      /capacity/,
    );
    pending[1].resolve({
      sections: [{ locator: "Text", text: "Redirected source" }],
      warnings: [],
    });
    await runningB;
    const source = f.store.view(f.n).sources.find((s: any) => s.title === "B");
    assert.equal(source.requested_origin, "https://public.example/requested");
    assert.equal(source.origin, "https://public.example/final");
    const p = f.store
      .selectedPassages(f.n, f.c)
      .find((p) => p.sourceId === source.id)!;
    assert.equal(p.retrievedAt, "2026-10-09T10:00:00.000Z");
    assert.deepEqual(fetches, ["https://public.example/requested"]);
    service.shutdown();
    assert.equal(pending[0].signal.aborted, true);
    await runningA;
    assert.equal(
      f.store.one("SELECT status FROM jobs WHERE id=?", a.id).status,
      "failed",
    );
    assert.equal(service.imports.size, 0);
    assert.equal(service.importControllers.size, 0);
    assert.equal(f.store.view(f.n).sources.length, 2);
  } finally {
    service.shutdown();
    f.cleanup();
  }
});

test("a duplicate offer does not cancel generation, change selection or consume another source", async () => {
  let finish!: (answer: Answer) => void;
  let signal!: AbortSignal;
  const f = await fixture(async (options) => {
    signal = options.signal!;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  try {
    const run = f.store.createRun(
      f.n,
      f.c,
      "Question",
      "answer",
      "fixture",
      "active",
    );
    const running = f.service.execute(run.id);
    const selection = f.store.view(f.n).conversations[0].selected;
    const generation = f.store.notebook(f.n).generation;
    const job = f.store.beginImport(f.n, "Duplicate", "duplicate");
    await f.service.import(f.n, job.id, {
      title: "Duplicate",
      kind: "text",
      bytes: Buffer.from("Fixture evidence"),
    });
    assert.equal(
      f.store.one("SELECT status FROM jobs WHERE id=?", job.id).status,
      "duplicate",
    );
    assert.equal(signal.aborted, false);
    assert.equal(f.store.notebook(f.n).generation, generation);
    assert.deepEqual(f.store.view(f.n).conversations[0].selected, selection);
    f.store.resolveDuplicate(f.n, job.id, "reuse");
    assert.equal(f.store.view(f.n).sources.length, 1);
    finish(answer);
    await running;
    assert.equal(
      f.store.one("SELECT status FROM runs WHERE id=?", run.id).status,
      "completed",
    );
  } finally {
    f.cleanup();
  }
});
test("final publication refuses a flat Studio response and retains it only as an unverified draft", async () => {
  const f = await fixture(async () => answer);
  try {
    const run = f.store.createRun(
      f.n,
      f.c,
      "Summary",
      "summary",
      "fixture",
      "flat",
    );
    await f.service.execute(run.id);
    const row = f.store.one("SELECT * FROM runs WHERE id=?", run.id);
    assert.equal(row.status, "failed");
    assert.equal(row.error_category, "invalid_output");
    assert.equal(row.output, null);
    assert.match(JSON.parse(row.failure_draft).text, /does not answer/);
    assert.equal(f.store.view(f.n).artifacts.length, 0);
  } finally {
    f.cleanup();
  }
});

test("failed drafts stay separate from completed output and purge removes their evidence copies", async () => {
  const f = await fixture(async () => {
    throw new GenerationError(
      "invalid_output",
      "Draft failed validation.",
      undefined,
      { text: "UNVERIFIED_SOURCE_COPY", truncated: false },
    );
  });
  try {
    const run = f.store.createRun(
      f.n,
      f.c,
      "Question",
      "answer",
      "",
      "failed-draft",
    );
    await f.service.execute(run.id);
    const stored = f.store.view(f.n).runs.find((r: any) => r.id === run.id);
    assert.equal(stored.status, "failed");
    assert.equal(stored.output, null);
    assert.equal(stored.failureDraft.text, "UNVERIFIED_SOURCE_COPY");
    assert.equal(
      f.store.view(f.n).messages.filter((m: any) => m.role === "assistant")
        .length,
      0,
    );
    assert.equal(f.store.view(f.n).artifacts.length, 0);
    f.store.purgeSource(f.n, f.store.view(f.n).sources[0].id);
    assert.ok(
      !JSON.stringify(f.store.view(f.n)).includes("UNVERIFIED_SOURCE_COPY"),
    );
    assert.equal(
      f.store.one("SELECT failure_draft FROM runs WHERE id=?", run.id)
        .failure_draft,
      null,
    );
  } finally {
    f.cleanup();
  }
});
test("map and table generation cannot publish late after stop, selection or instruction changes", async () => {
  for (const kind of ["mind-map", "data-table"] as const)
    for (const mutation of ["stop", "selection", "instructions"]) {
      let resolve!: (answer: Answer) => void, options!: RunOptions;
      const f = await fixture(async (input) => {
        options = input;
        return new Promise((done) => {
          resolve = done;
        });
      });
      try {
        const p = f.store.selectedPassages(f.n, f.c)[0],
          run = f.store.createRun(
            f.n,
            f.c,
            "Structure",
            kind,
            "fixture",
            "late",
          );
        const execution = f.service.execute(run.id);
        if (mutation === "stop") f.service.cancel(f.n, run.id);
        else if (mutation === "instructions")
          f.service.updateNotebook(f.n, { instructions: "Changed audience" });
        else {
          f.service.cancelNotebook(f.n);
          f.store.setSelection(f.n, f.c, []);
        }
        assert.equal(options.signal?.aborted, true);
        resolve(structuredAnswer(p, kind));
        await execution;
        assert.equal(
          f.store.one("SELECT status FROM runs WHERE id=?", run.id).status,
          "cancelled",
        );
        assert.equal(f.store.view(f.n).artifacts.length, 0);
        assert.equal(
          f.store.one("SELECT output FROM runs WHERE id=?", run.id).output,
          null,
        );
      } finally {
        f.cleanup();
      }
    }
});
