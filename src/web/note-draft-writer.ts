import { api } from "./api.ts";
import type { DraftInput, DraftReference } from "../domain/note-drafts.ts";

export type DraftStatus = {
  state: "clean" | "saving" | "saved" | "error";
  error?: string;
};

/** One serial writer per mounted editor; different editors use different IDs. */
export class NoteDraftWriter {
  private id: string;
  private reference?: DraftReference;
  private attempted?: DraftReference;
  private pending?: { input: DraftInput; changed: boolean };
  private flight?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private keepalive = false;
  private last = "";

  constructor(
    private notebookId: string,
    private status: (s: DraftStatus) => void,
    recovered?: DraftReference,
  ) {
    this.id = recovered?.id ?? crypto.randomUUID();
    this.reference = recovered;
  }
  change(input: DraftInput, changed: boolean, force = false) {
    if (this.closed) return;
    const serialized = JSON.stringify({ input, changed });
    if (!force && serialized === this.last) return;
    this.last = serialized;
    this.pending = { input, changed };
    clearTimeout(this.timer);
    if (!changed && !this.reference && !this.attempted && !this.flight) {
      this.pending = undefined;
      this.status({ state: "clean" });
      return;
    }
    this.status({ state: "saving" });
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, 400);
  }
  async flush(): Promise<DraftReference | undefined> {
    clearTimeout(this.timer);
    if (this.flight) await this.flight;
    if (this.closed || !this.pending) return this.reference;
    this.flight = this.drain();
    try {
      await this.flight;
    } finally {
      this.flight = undefined;
    }
    return this.reference;
  }
  private async drain() {
    while (this.pending && !this.closed) {
      const work = this.pending;
      this.pending = undefined;
      try {
        if (!work.changed) {
          const ref = this.reference ?? this.attempted;
          if (ref) await this.remove(ref);
          this.reference = undefined;
          this.attempted = undefined;
          this.id = crypto.randomUUID();
          this.status({ state: "clean" });
          continue;
        }
        const write = async () => {
          const ref = {
            id: this.id,
            version: (this.reference?.version ?? 0) + 1,
          };
          this.attempted = ref;
          const payload = { ...work.input, version: ref.version };
          const result: DraftReference = await api(
            `/notebooks/${this.notebookId}/drafts/${ref.id}`,
            "PUT",
            payload,
            this.keepalive &&
              new TextEncoder().encode(JSON.stringify(payload)).length < 60_000
              ? { keepalive: true }
              : undefined,
          );
          this.reference = result;
        };
        try {
          await write();
        } catch (e) {
          if (!/^Draft (changed|closed)\./.test((e as Error).message)) throw e;
          // Another window recovered the same draft. Preserve both versions.
          this.id = crypto.randomUUID();
          this.reference = undefined;
          await write();
        }
        this.status({ state: this.pending ? "saving" : "saved" });
      } catch (e) {
        if (!this.closed) this.pending ??= work;
        this.status({ state: "error", error: (e as Error).message });
        throw e;
      }
    }
  }
  private async remove(ref: DraftReference) {
    await api(`/notebooks/${this.notebookId}/drafts/${ref.id}`, "DELETE", {
      version: ref.version,
    });
  }
  async discard() {
    clearTimeout(this.timer);
    this.closed = true;
    this.pending = undefined;
    await this.flight?.catch(() => {});
    const ref = this.reference ?? this.attempted;
    try {
      if (ref) await this.remove(ref);
    } catch (e) {
      if ((e as Error).message !== "Draft not found.") {
        this.closed = false;
        this.last = "";
        throw e;
      }
    }
  }
  published() {
    this.closed = true;
    this.pending = undefined;
    clearTimeout(this.timer);
  }
  leave() {
    this.keepalive = true;
    void this.flush().catch(() => {});
  }
  dispose() {
    this.status = () => {};
    this.leave();
  }
}
