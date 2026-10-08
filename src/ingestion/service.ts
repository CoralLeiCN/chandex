import { Worker } from "node:worker_threads";
import type { Extracted } from "./extract.ts";
export function extractIsolated(
  bytes: Buffer,
  kind: string,
): Promise<Extracted> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      workerData: { bytes, kind },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error("Extraction exceeded 30 seconds."));
    }, 30000);
    worker.once("message", (m) => {
      clearTimeout(timer);
      void worker.terminate();
      if (m.error) reject(new Error(m.error));
      else resolve(m.result);
    });
    worker.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error("Extraction worker stopped."));
    });
  });
}
