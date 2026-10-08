import { parentPort, workerData } from "node:worker_threads";
import { extract } from "./extract.ts";
try {
  const result = await extract(Buffer.from(workerData.bytes), workerData.kind);
  parentPort!.postMessage({ result });
} catch (error) {
  parentPort!.postMessage({
    error: error instanceof Error ? error.message : "Extraction failed.",
  });
}
