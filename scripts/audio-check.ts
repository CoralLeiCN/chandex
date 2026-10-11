import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AudioProcess } from "../src/ingestion/audio-process.ts";
import { createIsolatedExtractor } from "../src/ingestion/service.ts";
import {
  AUDIO_MODEL,
  AUDIO_MODEL_REVISION,
  verifyAudioAssets,
} from "../src/ingestion/audio-assets.ts";
import { decodeWav } from "../src/ingestion/audio-pcm.ts";
const output = process.argv[2];
if (!output || process.argv.length !== 3)
  throw new Error(
    "Usage: npm run audio:check -- <new-result.json>. Install the fixed assets with npm run audio:setup first.",
  );
try {
  await lstat(output);
  throw new Error(
    "Audio check output already exists; choose a new result path.",
  );
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
await verifyAudioAssets();
const root = await mkdtemp(join(tmpdir(), "codeboom-audio-process-"));
const guard = join(root, "guard.mjs");
await writeFile(
  guard,
  `import http from 'node:http';import https from 'node:https';import net from 'node:net';import dgram from 'node:dgram';const deny=()=>process.exit(76);globalThis.fetch=deny;http.request=https.request=http.get=https.get=deny;net.Socket.prototype.connect=deny;dgram.createSocket=deny;const send=process.send.bind(process);process.send=(message,...args)=>send(message.result?{...message,probeUsage:{peakRssKiB:process.resourceUsage().maxRSS,rss:process.memoryUsage().rss}}:message,...args);`,
);
let active = 0,
  maxActive = 0,
  started = 0,
  completed = 0;
const boundaries: AudioProcess[] = [];
const usage: any[] = [];
let diagnosticBytes = 0;
const extract = createIsolatedExtractor((bytes, kind) => {
  assert.equal(kind, "audio");
  const boundary = new AudioProcess(bytes, [guard]);
  boundaries.push(boundary);
  started++;
  active++;
  maxActive = Math.max(maxActive, active);
  boundary.child.stdout!.on("data", (bytes: Buffer) => {
    diagnosticBytes += bytes.length;
  });
  boundary.child.stderr!.on("data", (bytes: Buffer) => {
    diagnosticBytes += bytes.length;
  });
  boundary.child.on("message", (message: any) => {
    if (message.probeUsage) usage.push(message.probeUsage);
  });
  const terminate = boundary.terminate.bind(boundary);
  let completion: Promise<number> | undefined;
  boundary.terminate = () =>
    (completion ??= terminate().then((code) => {
      active--;
      completed++;
      return code;
    }));
  return boundary;
});
const cases: any[] = [];
const initialRss = process.memoryUsage().rss;
try {
  for (const ext of ["wav", "mp3", "aac", "flac", "ogg", "opus", "m4a"]) {
    const begin = performance.now();
    const stages: string[] = [];
    const bytes = await readFile("tests/fixtures/audio/speech." + ext);
    const result = await extract(bytes, "audio", {
      onProgress: (stage) => stages.push(stage),
    });
    assert.match(
      result.sections.map((s) => s.text).join(" "),
      /240 units.*October 12.*Approval is still pending.*Do not start/,
    );
    cases.push({
      extension: ext,
      originalSha256: createHash("sha256").update(bytes).digest("hex"),
      elapsedMs: performance.now() - begin,
      stages,
      result,
      parentRss: process.memoryUsage().rss,
    });
  }
  // Three identical excerpts at 0, 20 and 36 seconds exercise window overlap,
  // pauses and complete transcript retention. This is synthetic, not human QA.
  const speech = decodeWav(
    await readFile("tests/fixtures/audio/speech.wav"),
  ).mono;
  const pcm = new Float32Array(45 * 16000);
  for (const second of [0, 20, 36]) pcm.set(speech, second * 16000);
  const paused = Buffer.alloc(44 + pcm.length * 2);
  paused.write("RIFF");
  paused.writeUInt32LE(paused.length - 8, 4);
  paused.write("WAVEfmt ", 8);
  paused.writeUInt32LE(16, 16);
  paused.writeUInt16LE(1, 20);
  paused.writeUInt16LE(1, 22);
  paused.writeUInt32LE(16000, 24);
  paused.writeUInt32LE(32000, 28);
  paused.writeUInt16LE(2, 32);
  paused.writeUInt16LE(16, 34);
  paused.write("data", 36);
  paused.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++)
    paused.writeInt16LE(
      Math.round(Math.max(-1, Math.min(32767 / 32768, pcm[i])) * 32768),
      44 + i * 2,
    );
  const pausedResult = await extract(paused, "audio");
  const pausedText = pausedResult.sections.map((s) => s.text).join(" ");
  assert.equal((pausedText.match(/240 units/g) ?? []).length, 3);
  assert.equal((pausedText.match(/October 12/g) ?? []).length, 3);
  assert.equal(
    (pausedText.match(/Approval is still pending/g) ?? []).length,
    3,
  );
  assert.equal((pausedText.match(/Do not start the rollout/g) ?? []).length, 3);
  cases.push({
    type: "45-second-three-excerpts",
    excerptStarts: [0, 20, 36],
    originalSha256: createHash("sha256").update(paused).digest("hex"),
    result: pausedResult,
    parentRss: process.memoryUsage().rss,
  });
  for (const type of [
    "cancel-after-native-token",
    "parent-disconnect-after-native-token",
    "deadline",
  ]) {
    const controller = new AbortController();
    let recognized = false,
      signalled = 0;
    const stages: string[] = [];
    await assert.rejects(
      extract(await readFile("tests/fixtures/audio/speech.wav"), "audio", {
        signal: controller.signal,
        timeoutMs: type === "deadline" ? 1 : 10000,
        onProgress: (stage) => {
          stages.push(stage);
          if (stage === "recognizing") {
            recognized = true;
            signalled = performance.now();
            if (type === "parent-disconnect-after-native-token")
              boundaries.at(-1)!.child.disconnect();
            else controller.abort();
          }
        },
      }),
      type === "deadline"
        ? /deadline/
        : type === "parent-disconnect-after-native-token"
          ? /stopped/
          : /cancelled/,
    );
    if (type !== "deadline") assert.equal(recognized, true);
    cases.push({
      type,
      recognized,
      stages,
      completionAfterSignalMs: signalled ? performance.now() - signalled : null,
    });
  }
  const bytes = await readFile("tests/fixtures/audio/speech.wav");
  const batches: any[] = [];
  for (let batch = 0; batch < 4; batch++) {
    const begin = performance.now();
    const results = await Promise.all([
      extract(bytes, "audio"),
      extract(bytes, "audio"),
    ]);
    batches.push({
      batch,
      elapsedMs: performance.now() - begin,
      parentRss: process.memoryUsage().rss,
      texts: results.map((r) => r.sections.map((s) => s.text).join(" ")),
    });
  }
  assert.equal(active, 0);
  assert.equal(started, completed);
  for (const boundary of boundaries)
    assert.throws(() => process.kill(boundary.child.pid!, 0), {
      code: "ESRCH",
    });
  const result = {
    date: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    model: AUDIO_MODEL,
    modelRevision: AUDIO_MODEL_REVISION,
    extractionVersion: "5",
    runtimeNetworkPolicy:
      "Every audio child exits with status 76 on fetch, HTTP/HTTPS, socket connect or datagram creation. No runtime model download.",
    initialRss,
    finalRss: process.memoryUsage().rss,
    parentPeakRssKiB: process.resourceUsage().maxRSS,
    startedProcesses: started,
    completedExits: completed,
    maxActive,
    active,
    diagnosticBytes,
    childUsage: usage,
    cases,
    batches,
  };
  assert.equal(diagnosticBytes, 0);
  await writeFile(output, JSON.stringify(result, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      output,
      initialRss: result.initialRss,
      finalRss: result.finalRss,
      parentPeakRssKiB: result.parentPeakRssKiB,
      started,
      completed,
      maxActive,
    }),
  );
} finally {
  await Promise.all(boundaries.map((b) => b.terminate()));
  await rm(root, { recursive: true, force: true });
}
