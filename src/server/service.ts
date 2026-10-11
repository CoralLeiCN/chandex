import { limits } from "../domain/limits.ts";
import { Store, type ImportDescriptor } from "../storage/store.ts";
import { CodexClient } from "../codex/client.ts";
import {
  GenerationError,
  generationFailure,
  unverifiedDraft,
} from "../codex/errors.ts";
import { extractIsolated } from "../ingestion/service.ts";
import { fetchPublic, MAX_BYTES } from "../ingestion/url.ts";
import { validateAnswer, digest } from "../domain/evidence.ts";
import { documentText } from "../domain/artifacts.ts";
import { initialRunStats } from "../domain/run-stats.ts";
import { DictationService } from "./dictation-service.ts";
import { driveFileInput, type DriveClient } from "../ingestion/drive.ts";
import type { DriveProvenance } from "../domain/drive-provenance.ts";
export class NotebookService {
  readonly dictation: DictationService;
  readonly imports = new Set<string>();
  readonly importControllers = new Map<string, AbortController>();
  readonly controllers = new Map<string, AbortController>();
  private readonly driveJobs = new Map<string, Promise<void>>();
  private driveDisconnecting = 0;
  constructor(
    readonly store: Store,
    readonly codex: Pick<CodexClient, "run" | "status">,
    readonly ingestion: {
      fetch: typeof fetchPublic;
      extract: typeof extractIsolated;
      drive?: Pick<DriveClient, "retrieve">;
    } = { fetch: fetchPublic, extract: extractIsolated },
  ) {
    this.dictation = new DictationService(
      store,
      ingestion.extract,
      () => this.imports.size,
    );
  }
  async disconnectDrive(disconnect: () => Promise<unknown>) {
    this.driveDisconnecting++;
    try {
      for (const job of this.driveJobs.keys())
        this.importControllers.get(job)?.abort();
      await Promise.allSettled([...this.driveJobs.values()]);
      return await disconnect();
    } finally {
      this.driveDisconnecting--;
    }
  }
  cancelNotebook(n: string) {
    for (const [run, controller] of this.controllers) {
      if (
        this.store.one("SELECT notebook_id FROM runs WHERE id=?", run)
          ?.notebook_id === n
      )
        controller.abort();
    }
  }
  updateNotebook(
    n: string,
    data: {
      title?: string;
      instructions?: string;
      archived?: boolean;
      tags?: unknown;
      questions?: unknown;
    },
  ) {
    const generation = this.store.notebook(n).generation;
    const notebook = this.store.updateNotebook(n, data);
    if (notebook.generation !== generation) this.cancelNotebook(n);
    return notebook;
  }
  cancel(n: string, id: string) {
    const run = this.store.one(
      "SELECT * FROM runs WHERE notebook_id=? AND id=?",
      n,
      id,
    );
    if (!run) throw new Error("Run not found.");
    this.store.tx(() => {
      const changed = this.store.run(
        "UPDATE runs SET status='cancelled',ended=? WHERE id=? AND status IN ('queued','running','validating')",
        new Date().toISOString(),
        id,
      );
      if (changed.changes) {
        this.controllers.get(id)?.abort();
        this.store.event(id, { type: "cancelled" });
      }
    });
  }
  retryImport(n: string, previousId: string, key: string) {
    const previous = this.store.importJob(n, previousId);
    const existing = this.store.one(
      "SELECT * FROM jobs WHERE idempotency=?",
      key,
    );
    if (existing) {
      if (existing.notebook_id !== n || existing.retry_of !== previousId)
        throw new Error("Idempotency key belongs to another import attempt.");
      return existing;
    }
    const descriptor: ImportDescriptor | null =
      previous.input_metadata && JSON.parse(previous.input_metadata);
    if (!descriptor)
      throw new Error(
        "This legacy import needs its input again. Choose a file, URL or pasted text.",
      );
    let bytes: Buffer | undefined;
    if (
      descriptor.sourceId &&
      !this.store.one(
        "SELECT id FROM sources WHERE id=? AND notebook_id=? AND removed=0",
        descriptor.sourceId,
        n,
      )
    )
      throw new Error("The source is unavailable and cannot be refreshed.");
    if (descriptor.derivedFrom) {
      const revision = this.store.one(
        "SELECT r.content FROM artifact_revisions r JOIN artifacts a ON a.id=r.artifact_id WHERE r.id=? AND a.id=? AND a.notebook_id=? AND a.unavailable=0",
        descriptor.derivedRevision ?? null,
        descriptor.derivedFrom,
        n,
      );
      if (!revision)
        throw new Error("The originating note revision is unavailable.");
      bytes = Buffer.from(documentText(JSON.parse(revision.content)));
    } else if (!descriptor.url && !descriptor.driveUrl)
      throw new Error(
        "This import needs its input again. Choose the file or paste the text again.",
      );
    const job = this.store.beginImport(
      n,
      previous.title,
      key,
      descriptor,
      previousId,
    );
    if (job.status === "processing")
      void this.import(n, job.id, { title: job.title, ...descriptor, bytes });
    return job;
  }
  async import(
    n: string,
    job: string,
    options: {
      title: string;
      kind: string;
      bytes?: Buffer;
      url?: string;
      driveUrl?: string;
      sourceId?: string;
      derivedFrom?: string;
      derivedRevision?: string;
    },
  ) {
    if (this.imports.has(job)) return;
    const record = this.store.one(
      "SELECT status FROM jobs WHERE id=? AND notebook_id=?",
      job,
      n,
    );
    if (!record) throw new Error("Import job not found.");
    if (record.status !== "processing") return;
    const descriptor: ImportDescriptor = {
      kind: options.kind,
      ...(options.url ? { url: options.url } : {}),
      ...(options.driveUrl
        ? { driveUrl: canonicalDriveLink(options.driveUrl) }
        : {}),
      ...(options.sourceId ? { sourceId: options.sourceId } : {}),
      ...(options.derivedFrom ? { derivedFrom: options.derivedFrom } : {}),
      ...(options.derivedRevision
        ? { derivedRevision: options.derivedRevision }
        : {}),
    };
    this.store.startImport(n, job, descriptor);
    if (this.imports.size + this.dictation.controllers.size >= limits.imports) {
      this.store.run(
        "UPDATE jobs SET status='failed',error=? WHERE id=? AND notebook_id=? AND status='processing'",
        "Import capacity is full. Wait for another import to finish, then retry.",
        job,
        n,
      );
      return;
    }
    const controller = new AbortController();
    this.importControllers.set(job, controller);
    this.imports.add(job);
    let finishDrive: (() => void) | undefined;
    if (options.driveUrl)
      this.driveJobs.set(
        job,
        new Promise<void>((r) => {
          finishDrive = r;
        }),
      );
    try {
      let { bytes, kind, title } = options;
      let origin = options.url ?? null;
      let provenance:
        | { requestedUrl: string; retrievedAt: string; drive?: DriveProvenance }
        | undefined;
      let driveWarnings: string[] = [];
      if (options.driveUrl) {
        if (this.driveDisconnecting || !this.ingestion.drive)
          throw Error("Connect Google Drive before importing a file.");
        if (options.url || options.bytes)
          throw Error("Choose one Drive file input.");
        const snapshot = await this.ingestion.drive.retrieve(options.driveUrl, {
          signal: controller.signal,
        });
        bytes = snapshot.bytes;
        kind = snapshot.kind;
        origin = snapshot.origin;
        provenance = {
          requestedUrl: snapshot.origin,
          retrievedAt: snapshot.retrievedAt,
          drive: snapshot.provenance,
        };
        driveWarnings = snapshot.warnings;
        if (driveFileInput(options.driveUrl).resourceKey)
          driveWarnings = [
            ...driveWarnings,
            "The sharing access key is not saved. If a later refresh or retry needs it, paste the original sharing link again.",
          ];
      } else if (options.url) {
        const fetched = await this.ingestion.fetch(
          options.url,
          0,
          Date.now() + 20000,
          controller.signal,
        );
        bytes = fetched.bytes;
        origin = fetched.url;
        provenance = {
          requestedUrl: options.url,
          retrievedAt: fetched.retrievedAt,
        };
        kind =
          fetched.contentType.includes("pdf") ||
          bytes.subarray(0, 5).toString() === "%PDF-"
            ? "pdf"
            : fetched.contentType.includes("html")
              ? "html"
              : fetched.contentType.includes("text/plain")
                ? "text"
                : "unsupported";
      }
      if (!bytes || bytes.length > MAX_BYTES)
        throw new Error("Missing source or file exceeds 25 MiB.");
      const generatedAudio =
        kind === "audio"
          ? this.store.speech.importedAudio(n, digest(bytes))
          : null;
      const result = await this.ingestion.extract(bytes, kind, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw new Error("Import cancelled.");
      result.warnings.push(...driveWarnings);
      if (generatedAudio)
        result.warnings.push(
          "This recording was generated from a Codeboom script. Its recognized transcript is derived material, not independent corroborating evidence. Inspect the originating written revision and citations.",
        );
      const generation = this.store.notebook(n).generation;
      this.store.publishImport(
        n,
        job,
        title || result.title || "Imported source",
        kind,
        origin,
        bytes,
        result,
        options.sourceId,
        generatedAudio?.artifactId ?? options.derivedFrom,
        provenance,
        true,
        generatedAudio?.revisionId ?? options.derivedRevision,
      );
      if (this.store.notebook(n).generation !== generation)
        this.cancelNotebook(n);
    } catch (error) {
      this.store.run(
        "UPDATE jobs SET status='failed',error=? WHERE id=? AND notebook_id=? AND status='processing'",
        error instanceof Error ? error.message : "Import failed.",
        job,
        n,
      );
    } finally {
      this.imports.delete(job);
      this.importControllers.delete(job);
      this.driveJobs.delete(job);
      finishDrive?.();
    }
  }
  async execute(runId: string) {
    if (this.controllers.has(runId)) return;
    const run = this.store.one("SELECT * FROM runs WHERE id=?", runId);
    if (!run || !this.store.active(runId)) return;
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    let lastProgress = "";
    const started = performance.now();
    const stats = initialRunStats(JSON.parse(run.manifest).length);
    const persistStats = () =>
      this.store.run(
        "UPDATE runs SET stats=? WHERE id=?",
        JSON.stringify(stats),
        runId,
      );
    try {
      this.store.run("UPDATE runs SET status='running' WHERE id=?", runId);
      const nb = this.store.notebook(run.notebook_id),
        passages = this.store.selectedPassages(nb.id, run.conversation_id);
      const history = this.store
        .all(
          "SELECT m.role,m.content FROM messages m JOIN runs r ON r.id=m.run_id WHERE m.conversation_id=? AND r.context_key=? AND r.generation=? AND r.grounding_mode=? AND r.status='completed' ORDER BY m.created DESC,m.rowid DESC LIMIT 8",
          run.conversation_id,
          run.context_key,
          run.generation,
          run.grounding_mode,
        )
        .reverse();
      const answer = await this.codex.run({
        passages,
        question: run.question,
        instructions: run.instruction_snapshot ?? nb.instructions,
        model: run.model || undefined,
        kind: run.kind,
        itemCount: run.study_count ?? undefined,
        signal: controller.signal,
        history: JSON.stringify(history),
        timeoutMs: run.kind === "answer" ? limits.chatMs : limits.artifactMs,
        onThread: (id) =>
          this.store.run(
            "UPDATE runs SET runtime_thread_id=? WHERE id=?",
            id,
            runId,
          ),
        onStats: (reported) => {
          Object.assign(stats, reported);
          persistStats();
        },
        onModel: (model) =>
          this.store.run("UPDATE runs SET model=? WHERE id=?", model, runId),
        search: (query, limit) => this.store.search(passages, query, limit),
        onProgress: (event) => {
          if (event.type === "validating" && this.store.active(runId))
            this.store.run(
              "UPDATE runs SET status='validating' WHERE id=?",
              runId,
            );
          const key = JSON.stringify(event);
          if (key !== lastProgress && this.store.active(runId)) {
            if (stats.firstProgressMs === null) {
              stats.firstProgressMs = Math.round(performance.now() - started);
              persistStats();
            }
            this.store.event(runId, event);
            lastProgress = key;
          }
        },
      });
      try {
        validateAnswer(
          answer,
          passages,
          run.kind,
          run.study_count ?? undefined,
        );
      } catch (error) {
        throw new GenerationError(
          "invalid_output",
          "The generated output failed final validation. An unverified draft is available separately.",
          { cause: error },
          unverifiedDraft(JSON.stringify(answer)),
        );
      }
      this.store.completeRun(runId, answer);
    } catch (error) {
      if (this.store.active(runId)) {
        const failure = generationFailure(error);
        if (
          failure.category === "timeout" &&
          !stats.budgetReached.includes("deadline")
        )
          stats.budgetReached.push("deadline");
        const message = failure.message;
        const status = ["interrupted", "timeout"].includes(failure.category)
          ? "interrupted"
          : "failed";
        this.store.tx(() => {
          this.store.run(
            "UPDATE runs SET status=?,error=?,error_category=?,failure_draft=?,ended=? WHERE id=?",
            status,
            message,
            failure.category,
            failure.draft ? JSON.stringify(failure.draft) : null,
            new Date().toISOString(),
            runId,
          );
          this.store.event(runId, {
            type: status,
            category: failure.category,
            text: message,
          });
        });
      }
    } finally {
      stats.elapsedMs = Math.round(performance.now() - started);
      if (this.store.db.isOpen) persistStats();
      this.controllers.delete(runId);
    }
  }
  shutdown() {
    this.dictation.shutdown();
    for (const controller of this.controllers.values()) controller.abort();
    for (const controller of this.importControllers.values())
      controller.abort();
  }
}

export function canonicalDriveLink(input: string) {
  const selected = driveFileInput(input);
  const path =
    selected.expectedMime === "application/vnd.google-apps.document"
      ? "document"
      : selected.expectedMime === "application/vnd.google-apps.spreadsheet"
        ? "spreadsheets"
        : selected.expectedMime === "application/vnd.google-apps.presentation"
          ? "presentation"
          : null;
  return path
    ? `https://docs.google.com/${path}/d/${selected.fileId}/edit`
    : `https://drive.google.com/file/d/${selected.fileId}/view`;
}
