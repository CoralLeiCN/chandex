import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, stat, readFile, rm } from "node:fs/promises";
import { tmpdir, release } from "node:os";
import { join } from "node:path";
import {
  SPEECH_PROVIDER_ID,
  SPEECH_RENDERER_VERSION,
  SPEECH_VOICES,
  speechVoice,
  validateSpeechText,
} from "../domain/audio-overview.ts";
import {
  SPEECH_MAX_BYTES,
  SPEECH_DEADLINE_MS,
  validateSpeechAudio,
} from "./speech-audio.ts";
const runFile = promisify(execFile);
export async function speechCatalog(signal?: AbortSignal) {
  let voices: (typeof SPEECH_VOICES)[number][] = [];
  if (process.platform === "darwin") {
    try {
      const { stdout } = await runFile("/usr/bin/say", ["-v", "?"], {
        timeout: 5000,
        maxBuffer: 65536,
        signal,
      });
      voices = SPEECH_VOICES.filter((voice) =>
        stdout
          .split("\n")
          .some(
            (line) =>
              line.startsWith(voice.name + " ") &&
              line.includes(voice.language.replace("-", "_")),
          ),
      );
    } catch {}
  }
  return {
    id: SPEECH_PROVIDER_ID,
    label: "macOS speech · on this device",
    available: voices.length > 0,
    voices,
    notice:
      "Generated speech can mispronounce words. Inspect the cited script and listen before sharing. Install missing English voices in macOS settings; Codeboom does not install them.",
  };
}
export interface RenderedSpeech {
  bytes: Buffer;
  provider: string;
  voiceId: string;
  rendererVersion: number;
  osVersion: string;
}
export async function renderMacSpeech(
  text: string,
  voiceId: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    stageRoot?: string;
  } = {},
): Promise<RenderedSpeech> {
  validateSpeechText(text);
  const voice = speechVoice(voiceId);
  if (process.platform !== "darwin")
    throw new Error("Local speech rendering requires supported macOS.");
  if (options.signal?.aborted)
    throw new Error("Speech rendering was cancelled.");
  const catalog = await speechCatalog(options.signal);
  if (options.signal?.aborted)
    throw new Error("Speech rendering was cancelled.");
  if (!catalog.voices.some((item) => item.id === voiceId))
    throw new Error(
      "Install the selected English speech voice in macOS settings before retrying.",
    );
  const timeout = options.timeoutMs ?? SPEECH_DEADLINE_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > SPEECH_DEADLINE_MS
  )
    throw new Error("Invalid speech deadline.");
  let stage: string;
  try {
    const root = options.stageRoot ?? tmpdir();
    await mkdir(root, { recursive: true, mode: 0o700 });
    stage = await realpath(await mkdtemp(join(root, "codeboom-speech-")));
  } catch {
    throw new Error("Speech staging could not be prepared.");
  }
  const output = join(stage, "speech.wav");
  try {
    await new Promise<void>((resolve, reject) => {
      const profile = `(version 1)(allow default)(deny network*)(deny file-write* (require-not (subpath ${JSON.stringify(stage)})))`;
      const child = spawn(
        "/usr/bin/sandbox-exec",
        [
          "-p",
          profile,
          "/usr/bin/say",
          "-v",
          voice.name,
          "-r",
          "170",
          "-o",
          output,
          "--file-format=WAVE",
          "--data-format=LEI16@22050",
          "--channels=1",
          "-f",
          "-",
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.on("error", () => {});
      let failure: Error | undefined,
        checking = false;
      const fail = (error: Error) => {
        failure ??= error;
        child.kill("SIGKILL");
      };
      const abort = () => fail(new Error("Speech rendering was cancelled."));
      const timer = setTimeout(
        () => fail(new Error("Speech rendering exceeded its deadline.")),
        timeout,
      );
      const monitor = setInterval(() => {
        if (checking || failure) return;
        checking = true;
        void stat(output)
          .then(
            (info) => {
              if (info.size > SPEECH_MAX_BYTES)
                fail(new Error("Generated speech exceeds 25 MiB."));
            },
            (error) => {
              if (error.code !== "ENOENT")
                fail(new Error("Speech output could not be checked."));
            },
          )
          .finally(() => {
            checking = false;
          });
      }, 100);
      options.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", () => {
        failure ??= new Error("The local speech provider could not start.");
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        clearInterval(monitor);
        options.signal?.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (code !== 0)
          reject(
            new Error(
              "Local speech rendering failed. Check the installed English voice and retry.",
            ),
          );
        else resolve();
      });
      if (options.signal?.aborted) abort();
      else child.stdin.end(text);
    });
    if (options.signal?.aborted)
      throw new Error("Speech rendering was cancelled.");
    const info = await stat(output);
    if (!info.isFile() || info.size > SPEECH_MAX_BYTES)
      throw new Error("Generated speech is missing or exceeds 25 MiB.");
    const bytes = await readFile(output);
    validateSpeechAudio(bytes);
    return {
      bytes,
      provider: SPEECH_PROVIDER_ID,
      voiceId,
      rendererVersion: SPEECH_RENDERER_VERSION,
      osVersion: `${process.platform} ${release()}`,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      /^Speech rendering was cancelled\.|Speech rendering exceeded its deadline\.|Generated speech|The local speech provider|Local speech rendering|Speech output/.test(
        error.message,
      )
    )
      throw error;
    throw new Error("Local speech output was invalid or unavailable.");
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
