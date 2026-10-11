import path from "node:path";
import type { Store } from "../storage/store.ts";
import { renderSpeechIsolated } from "../media/speech-process.ts";
const publicFailures = new Set([
  "Speech rendering was cancelled.",
  "Speech rendering exceeded its deadline.",
  "Local speech rendering requires supported macOS.",
  "Install the selected English speech voice in macOS settings before retrying.",
  "Local speech rendering failed. Check the installed English voice and retry.",
  "Local speech output was invalid or unavailable.",
  "Generated speech exceeds 25 MiB.",
  "Generated speech exceeds five minutes.",
  "Generated speech has an unsupported audio format.",
  "The speech provider produced no usable audio.",
  "Speech staging could not be prepared.",
  "Speech output could not be checked.",
  "The local speech provider could not start.",
  "The speech process could not start.",
  "Speech input could not be delivered.",
  "Speech process returned invalid audio.",
  "Speech process stopped before returning audio.",
  "The speech script changed or is unavailable.",
  "Speech requires an available, supported generated audio overview revision.",
  "Speech result does not match its immutable request.",
]);
export class SpeechService {
  readonly controllers = new Map<string, AbortController>();
  constructor(
    readonly store: Store,
    readonly render = renderSpeechIsolated,
  ) {}
  async execute(id: string) {
    if (this.controllers.has(id)) return;
    const job = this.store.one("SELECT * FROM speech_jobs WHERE id=?", id);
    if (job?.status !== "processing") return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    this.store.speech.rendering.add(id);
    try {
      const script = this.store.speech.script(
        job.notebook_id,
        job.artifact_id,
        job.revision_id,
      );
      if (script.hash !== job.script_hash)
        throw new Error("The speech script changed or is unavailable.");
      const result = await this.render(script.text, job.voice_id, {
        signal: controller.signal,
        stageRoot: path.join(this.store.root, "speech-staging"),
      });
      if (!controller.signal.aborted && this.store.db.isOpen)
        this.store.speech.publish(job.notebook_id, job.artifact_id, id, result);
    } catch (error) {
      const message =
        error instanceof Error && publicFailures.has(error.message)
          ? error.message
          : "Speech rendering failed. Check the script, selected installed voice and data directory, then retry.";
      if (this.store.db.isOpen)
        this.store.run(
          "UPDATE speech_jobs SET status='failed',error=?,ended=? WHERE id=? AND status='processing'",
          message,
          new Date().toISOString(),
          id,
        );
    } finally {
      this.controllers.delete(id);
      this.store.speech.rendering.delete(id);
    }
  }
  cancel(n: string, a: string, id: string) {
    const job = this.store.speech.cancel(n, a, id);
    this.controllers.get(id)?.abort();
    return job;
  }
  cancelNotebook(n: string) {
    for (const [id, controller] of this.controllers) {
      const job = this.store.one(
        "SELECT artifact_id FROM speech_jobs WHERE id=? AND notebook_id=?",
        id,
        n,
      );
      if (job) {
        this.store.speech.cancel(n, job.artifact_id, id);
        controller.abort();
      }
    }
  }
  shutdown() {
    for (const [id, controller] of this.controllers) {
      const job = this.store.one(
        "SELECT notebook_id,artifact_id FROM speech_jobs WHERE id=?",
        id,
      );
      if (job) this.store.speech.cancel(job.notebook_id, job.artifact_id, id);
      controller.abort();
    }
  }
}
