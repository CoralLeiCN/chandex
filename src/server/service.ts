import { limits } from "../domain/limits.ts";
import { Store } from "../storage/store.ts";
import { CodexClient } from "../codex/client.ts";
import { extractIsolated } from "../ingestion/service.ts";
import { fetchPublic, MAX_BYTES } from "../ingestion/url.ts";
export class NotebookService {
  readonly imports = new Set<string>();
  readonly controllers = new Map<string, AbortController>();
  constructor(
    readonly store: Store,
    readonly codex: CodexClient,
  ) {}
  cancelNotebook(n: string) {
    for (const [run, controller] of this.controllers) {
      if (
        this.store.one("SELECT notebook_id FROM runs WHERE id=?", run)
          ?.notebook_id === n
      )
        controller.abort();
    }
  }
  cancel(n: string, id: string) {
    const run = this.store.one(
      "SELECT * FROM runs WHERE notebook_id=? AND id=?",
      n,
      id,
    );
    if (!run) throw new Error("Run not found.");
    this.store.run(
      "UPDATE runs SET status='cancelled',ended=? WHERE id=? AND status IN ('queued','running','validating')",
      new Date().toISOString(),
      id,
    );
    this.controllers.get(id)?.abort();
    this.store.event(id, { type: "cancelled" });
  }
  async import(
    n: string,
    job: string,
    options: {
      title: string;
      kind: string;
      bytes?: Buffer;
      url?: string;
      sourceId?: string;
      derivedFrom?: string;
    },
  ) {
    if (this.imports.has(job)) return;
    this.imports.add(job);
    try {
      let { bytes, kind, title } = options;
      let origin = options.url ?? null;
      if (options.url) {
        const fetched = await fetchPublic(options.url);
        bytes = fetched.bytes;
        origin = fetched.url;
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
      const result = await extractIsolated(bytes, kind);
      if (kind === "pdf" && result.warnings.length)
        throw new Error(
          "This PDF has pages without usable text. OCR or a text-only copy is required.",
        );
      this.cancelNotebook(n);
      this.store.publishImport(
        n,
        job,
        title || result.title || "Imported source",
        kind,
        origin,
        bytes,
        result,
        options.sourceId,
        options.derivedFrom,
      );
    } catch (error) {
      this.store.run(
        "UPDATE jobs SET status='failed',error=? WHERE id=?",
        error instanceof Error ? error.message : "Import failed.",
        job,
      );
    } finally {
      this.imports.delete(job);
    }
  }
  async execute(runId: string) {
    if (this.controllers.has(runId)) return;
    const run = this.store.one("SELECT * FROM runs WHERE id=?", runId);
    if (!run || !this.store.active(runId)) return;
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    let lastProgress = "";
    try {
      this.store.run("UPDATE runs SET status='running' WHERE id=?", runId);
      const nb = this.store.notebook(run.notebook_id),
        passages = this.store.selectedPassages(nb.id, run.conversation_id);
      const history = this.store
        .all(
          "SELECT m.role,m.content FROM messages m JOIN runs r ON r.id=m.run_id WHERE m.conversation_id=? AND r.context_key=? AND r.status='completed' ORDER BY m.created DESC LIMIT 8",
          run.conversation_id,
          run.context_key,
        )
        .reverse();
      const answer = await this.codex.run({
        passages,
        question: run.question,
        instructions: nb.instructions,
        model: run.model || undefined,
        kind: run.kind,
        signal: controller.signal,
        history: JSON.stringify(history),
        timeoutMs: run.kind === "answer" ? limits.chatMs : limits.artifactMs,
        onThread: (id) =>
          this.store.run(
            "UPDATE runs SET runtime_thread_id=? WHERE id=?",
            id,
            runId,
          ),
        onStats: (stats) =>
          this.store.run(
            "UPDATE runs SET stats=? WHERE id=?",
            JSON.stringify(stats),
            runId,
          ),
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
            this.store.event(runId, event);
            lastProgress = key;
          }
        },
      });
      this.store.completeRun(runId, answer);
    } catch (error) {
      if (this.store.active(runId)) {
        const message =
          error instanceof Error ? error.message : "Generation failed.";
        const status =
          /Codex process exited|Invalid runtime protocol|Codex request timed out|Codex closed/.test(
            message,
          )
            ? "interrupted"
            : "failed";
        this.store.run(
          "UPDATE runs SET status=?,error=?,ended=? WHERE id=?",
          status,
          message,
          new Date().toISOString(),
          runId,
        );
        this.store.event(runId, { type: "failed", text: message });
      }
    } finally {
      this.controllers.delete(runId);
    }
  }
  shutdown() {
    for (const controller of this.controllers.values()) controller.abort();
  }
}
