import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { digest } from "../src/domain/evidence.ts";
import {
  AUDIO_MODEL,
  AUDIO_MODEL_REVISION,
} from "../src/ingestion/audio-assets.ts";
const [root, n, base, output] = process.argv.slice(2);
if (
  process.argv.length !== 6 ||
  !root ||
  !n ||
  !/^http:\/\/127\.0\.0\.1:\d+$/.test(base ?? "") ||
  !output
)
  throw Error(
    "Usage: npm run dictation:check -- <disposable-data-root> <notebook-id> <http://127.0.0.1:port> <new-result.json>",
  );
if (existsSync(output)) throw Error("Choose a new dictation result path.");
const fixture = { root, n },
  db = new DatabaseSync(fixture.root + "/codeboom.sqlite", { readOnly: true });
const counts = () =>
  Object.fromEntries(
    [
      "sources",
      "revisions",
      "passages",
      "jobs",
      "artifacts",
      "artifact_revisions",
      "speech_assets",
    ].map((table) => [
      table,
      (db.prepare("SELECT count(*) AS count FROM " + table).get() as any).count,
    ]),
  );
try {
  const cookie = (await fetch(base + "/api/session")).headers
      .get("set-cookie")!
      .split(";")[0],
    headers = {
      Cookie: cookie,
      Origin: base,
      "Content-Type": "application/json",
    },
    root = "/api/notebooks/" + fixture.n + "/dictation";
  const call = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(response.status, method === "POST" ? 202 : 200);
    return response.json();
  };
  const before = counts(),
    bytes = readFileSync("tests/fixtures/audio/speech.wav"),
    started = performance.now(),
    job = await call(root, "POST", {
      base64: bytes.toString("base64"),
      idempotency: "real-dictation-check",
    });
  let result = job;
  for (let i = 0; i < 1200 && result.status === "processing"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    result = await call(root + "/" + job.id);
  }
  assert.equal(result.status, "completed");
  assert.match(
    result.text,
    /240 units.*October 12.*Approval is still pending.*Do not start/s,
  );
  const recognitionMs = performance.now() - started;
  await call(root + "/" + job.id, "DELETE");
  assert.deepEqual(counts(), before);
  const cancelled = await call(root, "POST", {
    base64: bytes.toString("base64"),
    idempotency: "cancel-native",
  });
  let recognized = false;
  for (let i = 0; i < 400; i++) {
    const value = await call(root + "/" + cancelled.id);
    if (value.stage === "recognizing") {
      recognized = true;
      break;
    }
    if (value.status !== "processing") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(recognized, true);
  await call(root + "/" + cancelled.id, "DELETE");
  const status = await call("/api/status");
  assert.equal(status.audioOverviewsEnabled, false);
  const report = {
    date: new Date().toISOString(),
    model: AUDIO_MODEL,
    modelRevision: AUDIO_MODEL_REVISION,
    originalHash: digest(bytes),
    result,
    recognitionMs,
    storageBefore: before,
    storageAfter: counts(),
    cancelledAfterNativeRecognitionStage: recognized,
    audioGenerationEnabled: status.audioOverviewsEnabled,
    microphoneHardwareReview: "pending",
    scope:
      "Actual local recognition over a synthetic recording; browser permission cancellation checked separately. No human microphone/listening acceptance.",
  };
  writeFileSync(output, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(
    JSON.stringify({
      recognized: result.status,
      recognitionMs,
      storageUnchanged: true,
      cancelledAfterNativeStage: true,
    }),
  );
} finally {
  db.close();
}
