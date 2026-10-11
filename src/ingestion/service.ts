import { Worker } from "node:worker_threads";
import { MAX_BYTES } from "./url.ts";
import type { Extracted } from "./extract.ts";
import { AUDIO_DEADLINE_MS } from "./audio-limits.ts";
import { AUDIO_STAGES, type AudioProgress } from "./audio-progress.ts";
import { AudioProcess } from "./audio-process.ts";

interface ExtractionWorker {
  once(
    event: "message" | "error" | "exit",
    listener: (...args: any[]) => void,
  ): unknown;
  terminate(): Promise<number>;
}
interface ExtractionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: AudioProgress;
}
export function createIsolatedExtractor(
  workerFactory: (bytes: Buffer, kind: string) => ExtractionWorker = (
    bytes,
    kind,
  ) => {
    if (kind === "audio") return new AudioProcess(bytes);
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      workerData: { bytes, kind },
      ...(process.execArgv.some((arg) => arg.startsWith("--input-type"))
        ? {
            execArgv: process.execArgv.filter(
              (arg) => !arg.startsWith("--input-type"),
            ),
          }
        : {}),
      resourceLimits: { maxOldGenerationSizeMb: 256 },
      stdout: true,
      stderr: true,
    });
    // Parser diagnostics can contain document fragments. Drain worker output
    // without forwarding it to routine application logs or retaining it.
    worker.stdout.resume();
    worker.stderr.resume();
    return worker;
  },
) {
  return function extractIsolated(
    bytes: Buffer,
    kind: string,
    options: ExtractionOptions = {},
  ): Promise<Extracted> {
    if (bytes.length > MAX_BYTES)
      return Promise.reject(new Error("Source exceeds 25 MiB."));
    if (options.signal?.aborted)
      return Promise.reject(new Error("Extraction was cancelled."));
    const maximumDeadline = kind === "audio" ? AUDIO_DEADLINE_MS : 30000;
    const timeoutMs = options.timeoutMs ?? maximumDeadline;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > maximumDeadline
    )
      return Promise.reject(
        new Error(
          `Extraction deadline must be between 1 and ${maximumDeadline.toLocaleString("en-US")} ms.`,
        ),
      );
    return new Promise((resolve, reject) => {
      const worker = workerFactory(bytes, kind);
      let settled = false;
      const finish = (error?: Error, result?: Extracted) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        // Keep the import slot occupied until native work has actually stopped.
        void worker.terminate().then(
          () => {
            if (error) reject(error);
            else resolve(result!);
          },
          () => reject(new Error("Extraction cleanup failed.")),
        );
      };
      const abort = () => finish(new Error("Extraction was cancelled."));
      const timer = setTimeout(
        () => finish(new Error("Extraction exceeded its deadline.")),
        timeoutMs,
      );
      options.signal?.addEventListener("abort", abort, { once: true });
      const messageReceived = (message: any) => {
        if (settled) return;
        if (
          kind === "audio" &&
          message &&
          Object.keys(message).length === 1 &&
          AUDIO_STAGES.includes(message.progress)
        ) {
          try {
            options.onProgress?.(message.progress);
          } catch {
            finish(new Error("Extraction progress handling failed."));
          }
          if (!settled) worker.once("message", messageReceived);
          return;
        }
        if (message?.error) finish(new Error(String(message.error)));
        else if (
          !message?.result ||
          !Array.isArray(message.result.sections) ||
          !Array.isArray(message.result.warnings)
        )
          finish(new Error("Extraction worker returned an invalid result."));
        else finish(undefined, message.result);
      };
      worker.once("message", messageReceived);
      worker.once("error", (error) =>
        finish(
          error instanceof Error
            ? error
            : new Error("Extraction worker failed."),
        ),
      );
      // A clean worker exit without a result is still a failed extraction. It
      // must not clear the deadline and leave an import pending indefinitely.
      worker.once("exit", () =>
        finish(
          new Error("Extraction worker stopped before returning a result."),
        ),
      );
      if (options.signal?.aborted) abort();
    });
  };
}
export const extractIsolated = createIsolatedExtractor();
