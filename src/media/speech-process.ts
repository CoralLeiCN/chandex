import { fork } from "node:child_process";
import { validateSpeechText, speechVoice } from "../domain/audio-overview.ts";
import { SPEECH_DEADLINE_MS } from "./speech-audio.ts";
import type { RenderedSpeech } from "./macos-speech.ts";

export async function renderSpeechIsolated(
  text: string,
  voiceId: string,
  options: { signal?: AbortSignal; stageRoot: string; timeoutMs?: number },
): Promise<RenderedSpeech> {
  validateSpeechText(text);
  speechVoice(voiceId);
  const timeout = options.timeoutMs ?? SPEECH_DEADLINE_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > SPEECH_DEADLINE_MS
  )
    throw new Error("Invalid speech deadline.");
  if (options.signal?.aborted)
    throw new Error("Speech rendering was cancelled.");
  return new Promise((resolve, reject) => {
    const child = fork(
      new URL("./speech-process-entry.ts", import.meta.url),
      [],
      {
        execArgv: ["--import", "tsx", "--max-old-space-size=256"],
        serialization: "advanced",
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    child.stdout!.resume();
    child.stderr!.resume();
    let settled = false,
      exited = false,
      killTimer: ReturnType<typeof setTimeout> | undefined;
    const exit = new Promise<void>((done) => {
      child.once("exit", () => {
        exited = true;
        done();
      });
      child.once("error", () => {
        if (!child.pid) {
          exited = true;
          done();
        }
      });
    });
    const finish = (error?: Error, result?: RenderedSpeech) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (!exited) {
        // The entry's SIGTERM handler kills say and removes staging before exit.
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
      }
      void exit.then(() => {
        clearTimeout(killTimer);
        if (error) reject(error);
        else resolve(result!);
      });
    };
    const abort = () => finish(new Error("Speech rendering was cancelled."));
    const timer = setTimeout(
      () => finish(new Error("Speech rendering exceeded its deadline.")),
      timeout,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("message", (message: any) => {
      if (message?.error) finish(new Error(String(message.error)));
      else if (!message?.result || !Buffer.isBuffer(message.result.bytes))
        finish(new Error("Speech process returned invalid audio."));
      else finish(undefined, message.result);
    });
    child.once("error", () =>
      finish(new Error("The speech process could not start.")),
    );
    child.once("exit", () =>
      finish(new Error("Speech process stopped before returning audio.")),
    );
    child.send(
      { text, voiceId, stageRoot: options.stageRoot, timeoutMs: timeout },
      (error) => {
        if (error) finish(new Error("Speech input could not be delivered."));
      },
    );
    if (options.signal?.aborted) abort();
  });
}
