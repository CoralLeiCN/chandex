import { randomUUID } from "node:crypto";
import type { Store } from "../storage/store.ts";
import { digest } from "../domain/evidence.ts";
import { decodeWav } from "../ingestion/audio-pcm.ts";
import { extractIsolated } from "../ingestion/service.ts";
import { AUDIO_ASSET_ERROR } from "../ingestion/audio-assets.ts";
import { limits } from "../domain/limits.ts";

interface Dictation {
  id: string;
  notebookId: string;
  key: string;
  hash: string;
  expires: number;
  status: "processing" | "completed" | "failed";
  stage: string;
  text?: string;
  error?: string;
}
/** Ephemeral recognition, deliberately outside durable source/note storage. */
export class DictationService {
  readonly jobs = new Map<string, Dictation>();
  readonly controllers = new Map<string, AbortController>();
  // Small cancellation requests can arrive before the recording body. Retain
  // only owner/key/expiry, never audio or recognized words, across that race.
  readonly cancelled = new Map<
    string,
    { notebookId: string; expires: number }
  >();
  private timer: ReturnType<typeof setInterval>;
  constructor(
    readonly store: Store,
    readonly extract = extractIsolated,
    readonly otherActive = () => 0,
  ) {
    this.timer = setInterval(() => this.prune(), 30000);
    this.timer.unref();
  }
  private prune() {
    for (const [key, request] of this.cancelled)
      if (request.expires <= Date.now()) this.cancelled.delete(key);
    for (const [id, job] of this.jobs)
      if (job.expires <= Date.now()) {
        this.controllers.get(id)?.abort();
        this.jobs.delete(id);
      }
  }
  private requestKey(key: string) {
    if (!key || key.length > 200)
      throw Error("A dictation request key is required.");
  }
  begin(n: string, bytes: Buffer, key: string) {
    this.store.notebook(n);
    this.prune();
    this.requestKey(key);
    const cancelled = this.cancelled.get(key);
    if (cancelled) {
      if (cancelled.notebookId !== n)
        throw Error("Dictation request key belongs to another recording.");
      throw Error(
        "This voice input was cancelled. Record again to start a new request.",
      );
    }
    if (bytes.length > 24 * 1024 * 1024)
      throw Error("Voice input exceeds its recording limit.");
    const hash = digest(bytes),
      existing = [...this.jobs.values()].find((job) => job.key === key);
    if (existing) {
      if (existing.notebookId !== n || existing.hash !== hash)
        throw Error("Dictation request key belongs to another recording.");
      return this.get(n, existing.id);
    }
    let pcm;
    try {
      pcm = decodeWav(bytes);
    } catch {
      throw Error("Voice input requires a complete mono WAV recording.");
    }
    if (pcm.channels !== 1 || pcm.mono.length / pcm.sampleRate > 120)
      throw Error("Voice input is limited to two minutes of mono audio.");
    if (this.controllers.size + this.otherActive() >= limits.imports)
      throw Error(
        "Recognition is busy. Wait for another recording or import to finish.",
      );
    if (this.jobs.size >= 16)
      throw Error("Discard a recent dictation before recording again.");
    if (this.jobs.size + this.cancelled.size >= 256)
      throw Error(
        "Too many recent voice requests. Wait before recording again.",
      );
    const id = randomUUID(),
      controller = new AbortController();
    this.jobs.set(id, {
      id,
      notebookId: n,
      key,
      hash,
      status: "processing",
      stage: "preparing",
      expires: Date.now() + 300000,
    });
    this.controllers.set(id, controller);
    void this.execute(id, bytes, controller);
    return this.get(n, id);
  }
  private async execute(
    id: string,
    bytes: Buffer,
    controller: AbortController,
  ) {
    const job = this.jobs.get(id)!;
    try {
      const result = await this.extract(bytes, "audio", {
        signal: controller.signal,
        onProgress: (stage) => {
          if (!controller.signal.aborted && this.jobs.has(id))
            job.stage = stage;
        },
      });
      // Recognition segments are timestamp boundaries, not authored paragraphs.
      const text = result.sections.map((section) => section.text).join(" ");
      if (!text.trim() || [...text].length > 32000)
        throw Error("Invalid recognition output");
      if (
        !controller.signal.aborted &&
        this.jobs.has(id) &&
        this.store.db.isOpen
      ) {
        this.store.notebook(job.notebookId);
        job.status = "completed";
        job.text = text;
        job.expires = Date.now() + 300000;
      }
    } catch (error) {
      if (!controller.signal.aborted && this.jobs.has(id)) {
        job.status = "failed";
        job.error =
          error instanceof Error && error.message === AUDIO_ASSET_ERROR
            ? "The local English recognition model is unavailable. Run npm run audio:setup, then try again."
            : "Voice input could not be transcribed. Check that the recording contains clear English speech, then try again.";
      }
    } finally {
      this.controllers.delete(id);
    }
  }
  get(n: string, id: string) {
    this.store.notebook(n);
    this.prune();
    const job = this.jobs.get(id);
    if (!job || job.notebookId !== n)
      throw Error("Dictation request not found.");
    return {
      id: job.id,
      status: job.status,
      stage: job.stage,
      text: job.text,
      error: job.error,
    };
  }
  discard(n: string, id: string) {
    this.get(n, id);
    this.cancelRequest(n, this.jobs.get(id)!.key);
  }
  cancelRequest(n: string, key: string) {
    this.store.notebook(n);
    this.prune();
    this.requestKey(key);
    const cancelled = this.cancelled.get(key),
      job = [...this.jobs.values()].find((value) => value.key === key);
    if (
      (cancelled && cancelled.notebookId !== n) ||
      (job && job.notebookId !== n)
    )
      throw Error("Dictation request key belongs to another recording.");
    if (cancelled) return;
    // Admission reserves room for every admitted request to be cancelled;
    // excess unknown keys cannot evict another request's protection.
    if (!job && this.jobs.size + this.cancelled.size >= 256)
      throw Error(
        "Too many recent voice requests. Wait before recording again.",
      );
    this.cancelled.set(key, { notebookId: n, expires: Date.now() + 600000 });
    if (job) {
      this.controllers.get(job.id)?.abort();
      this.jobs.delete(job.id);
    }
  }
  cancelNotebook(n: string) {
    for (const [id, job] of this.jobs)
      if (job.notebookId === n) {
        this.controllers.get(id)?.abort();
        this.jobs.delete(id);
      }
    for (const [key, request] of this.cancelled)
      if (request.notebookId === n) this.cancelled.delete(key);
  }
  shutdown() {
    clearInterval(this.timer);
    for (const controller of this.controllers.values()) controller.abort();
    this.jobs.clear();
    this.cancelled.clear();
  }
}
