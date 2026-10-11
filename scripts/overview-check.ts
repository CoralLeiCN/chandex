import assert from "node:assert/strict";
import { fork, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, rm, readdir, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexClient } from "../src/codex/client.ts";
import {
  chunkText,
  validateAnswer,
  digest,
  OUTPUT_CONTRACT_VERSION,
  TOOL_CONTRACT_VERSION,
  type Answer,
} from "../src/domain/evidence.ts";
import {
  overviewSpeechText,
  SPEECH_SCRIPT_VERSION,
  SPEECH_RENDERER_VERSION,
} from "../src/domain/audio-overview.ts";
import { speechCatalog, renderMacSpeech } from "../src/media/macos-speech.ts";
import { renderSpeechIsolated } from "../src/media/speech-process.ts";
import { validateSpeechAudio } from "../src/media/speech-audio.ts";
const runFile = promisify(execFile),
  output = process.argv[2];
if (!output || process.argv.length !== 3)
  throw Error("Usage: npm run overview:check -- <new-result.json>");
try {
  await lstat(output);
  throw Error("Choose a new overview result path.");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const root = await mkdtemp(join(tmpdir(), "codeboom-overview-check-")),
  stageRoot = join(root, "speech-staging");
const sources = [
  {
    id: "a",
    text: "Proposal A requests a budget of 240 units and proposes October 12 for delivery. Approval is still pending. Do not start the rollout.",
  },
  {
    id: "b",
    text: "Proposal B requests a budget of 300 units and proposes October 13 for delivery. Both the budget and date are proposals, not approved commitments. Do not start the rollout.",
  },
];
const passages = sources.flatMap((source) =>
  chunkText(
    source.text,
    source.id,
    "overview-v1-" + source.id,
    "Proposal " + source.id.toUpperCase(),
  ),
);
const cases = [
  {
    id: "conflicting-proposals",
    question:
      "Create a short audio overview comparing both selected proposals. Attribute the different numbers and dates to their sources, preserve pending approval and the instruction not to start rollout. Do not resolve the disagreement or invent approval.",
    passages,
    status: "answered",
  },
  {
    id: "sparse-proposal",
    question:
      "Create a short audio overview of the proposal, including the requested budget and proposed date. Preserve approval uncertainty and identify the missing final approval date without inventing it.",
    passages: passages.slice(0, 1),
    status: "answered",
  },
  {
    id: "unanswerable",
    question:
      "Create an audio overview giving the final approval date and approving executive. Neither is present; return insufficient evidence without guessing.",
    passages,
    status: "insufficient_evidence",
  },
];
const report: any = {
  date: new Date().toISOString(),
  corpusVersion: 1,
  corpusHash: digest(JSON.stringify({ sources, cases })),
  sources,
  passages,
  outputContractVersion: OUTPUT_CONTRACT_VERSION,
  toolContractVersion: TOOL_CONTRACT_VERSION,
  speechScriptVersion: SPEECH_SCRIPT_VERSION,
  speechRendererVersion: SPEECH_RENDERER_VERSION,
  results: [],
  native: [],
  humanScriptReview: "pending",
  humanListeningReview: "pending",
  scope:
    "Synthetic source fixtures and real native renders; no human semantic or listening acceptance.",
};
const save = () => writeFile(output, JSON.stringify(report, null, 2));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function ownNative() {
  const { stdout } = await runFile("/bin/ps", ["-axo", "pid=,ppid=,command="], {
    maxBuffer: 1024 * 1024,
  });
  return stdout
    .split("\n")
    .filter(
      (line) =>
        line.includes(stageRoot) && /\/usr\/bin\/(say|sandbox-exec)/.test(line),
    )
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)/.exec(line)!;
      return { pid: Number(match[1]), parentPid: Number(match[2]) };
    });
}
async function nativeStarted(done: () => boolean) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const processes = await ownNative();
    if (processes.length) return processes;
    if (done())
      throw Error("Native render settled before lifecycle observation");
    await wait(10);
  }
  throw Error("Native speech did not start for lifecycle observation");
}
async function clean() {
  assert.deepEqual(await readdir(stageRoot), []);
  assert.deepEqual(await ownNative(), []);
}
try {
  const client = new CodexClient(join(root, "runtime")),
    status = await client.status(),
    model = status.models.find((model) => model.isDefault)?.model;
  if (!model || !status.authenticated)
    throw Error("A logged-in default Codex model is required.");
  report.runtime = status.version;
  report.model = model;
  let supported: Answer | undefined;
  for (const item of cases) {
    const started = performance.now();
    let stats;
    const answer = await client.run({
      question: item.question,
      passages: item.passages,
      kind: "audio-overview",
      model,
      onStats: (value) => {
        stats = value;
      },
    });
    validateAnswer(answer, item.passages, "audio-overview");
    assert.equal(answer.status, item.status);
    const spokenText =
      answer.status === "answered" ? overviewSpeechText(answer) : null;
    report.results.push({
      id: item.id,
      question: item.question,
      selectedRevisionIds: [...new Set(item.passages.map((p) => p.revisionId))],
      answer,
      spokenText,
      spokenTextHash: spokenText ? digest(spokenText) : null,
      expectedStatusMet: true,
      elapsedMs: performance.now() - started,
      stats,
    });
    if (item.id === "conflicting-proposals") supported = answer;
    await save();
    console.log(item.id + " validated");
  }
  const catalog = await speechCatalog();
  assert.equal(catalog.available, true);
  report.catalog = catalog;
  const text = overviewSpeechText(supported!);
  for (const voice of ["samantha", "daniel"]) {
    assert.ok(catalog.voices.some((item) => item.id === voice));
    const started = performance.now(),
      result = await renderSpeechIsolated(text, voice, { stageRoot });
    report.native.push({
      type: "complete-render",
      voice,
      provider: result.provider,
      rendererVersion: result.rendererVersion,
      osVersion: result.osVersion,
      spokenTextHash: digest(text),
      audioHash: digest(result.bytes),
      bytes: result.bytes.length,
      ...validateSpeechAudio(result.bytes),
      elapsedMs: performance.now() - started,
    });
    await clean();
    await save();
    console.log(voice + " rendered and cleaned");
  }
  const longText =
    "The proposed budget is three hundred units. Approval is still pending. Do not start the rollout. ".repeat(
      30,
    );
  const controller = new AbortController();
  let settled = false;
  const cancelled = renderSpeechIsolated(longText, "samantha", {
    stageRoot,
    signal: controller.signal,
  }).finally(() => {
    settled = true;
  });
  // Register rejection before observation so a fast provider failure is handled.
  const cancelledCheck = assert.rejects(cancelled, /cancelled/);
  const cancellationProcesses = await nativeStarted(() => settled),
    cancellationStart = performance.now();
  controller.abort();
  await cancelledCheck;
  await clean();
  report.native.push({
    type: "cancel-after-native-start",
    observedProcesses: cancellationProcesses,
    awaitedExitAndClean: true,
    elapsedAfterSignalMs: performance.now() - cancellationStart,
  });
  await save();
  const child = fork(
    new URL("../src/media/speech-process-entry.ts", import.meta.url),
    [],
    {
      execArgv: ["--import", "tsx", "--max-old-space-size=256"],
      serialization: "advanced",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  child.stdout!.resume();
  child.stderr!.resume();
  const exited = once(child, "exit");
  let disconnected = false;
  try {
    child.send({ text: longText, voiceId: "daniel", stageRoot });
    const processes = await nativeStarted(() => child.exitCode !== null),
      started = performance.now();
    child.disconnect();
    disconnected = true;
    await Promise.race([
      exited,
      wait(5000).then(() => {
        throw Error("Disconnected speech owner did not exit");
      }),
    ]);
    await clean();
    report.native.push({
      type: "parent-disconnect-after-native-start",
      ownerPid: child.pid,
      observedProcesses: processes,
      awaitedExitAndClean: true,
      elapsedAfterSignalMs: performance.now() - started,
    });
    await save();
  } finally {
    if (!disconnected && child.connected) child.disconnect();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
  }
  const deadlineStart = performance.now();
  await assert.rejects(
    renderMacSpeech(longText, "samantha", { stageRoot, timeoutMs: 1 }),
    /deadline/,
  );
  await clean();
  report.native.push({
    type: "native-deadline",
    timeoutMs: 1,
    awaitedExitAndClean: true,
    elapsedMs: performance.now() - deadlineStart,
  });
  report.complete = true;
  await save();
  console.log("Native lifecycle checks complete");
} finally {
  await rm(root, { recursive: true, force: true });
}
