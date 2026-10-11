import type { NoteNode } from "../domain/notes.ts";

export const VOICE_MAX_SECONDS = 120;
export function dictationContent(text: string, codeBlock = false): NoteNode[] {
  // Inline schema text preserves the cursor's paragraph/list/heading and the
  // reviewed line breaks. A plain string here would be parsed as HTML.
  const normalized = text.replace(/\r\n?/g, "\n");
  if (codeBlock) return normalized ? [{ type: "text", text: normalized }] : [];
  return normalized
    .split("\n")
    .flatMap<NoteNode>((line, index) => [
      ...(index ? [{ type: "hardBreak" } as NoteNode] : []),
      ...(line ? [{ type: "text", text: line } as NoteNode] : []),
    ]);
}
export function voiceWav(chunks: Float32Array[], rate: number): Uint8Array {
  const count = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (
    !Number.isSafeInteger(rate) ||
    rate < 8000 ||
    rate > 96000 ||
    !count ||
    count > rate * VOICE_MAX_SECONDS
  )
    throw Error("Voice input requires a recording of up to two minutes.");
  const bytes = new Uint8Array(44 + count * 2),
    view = new DataView(bytes.buffer);
  const label = (offset: number, text: string) =>
    [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  label(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  label(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, "data");
  view.setUint32(40, count * 2, true);
  let offset = 44;
  for (const chunk of chunks)
    for (const sample of chunk) {
      if (!Number.isFinite(sample))
        throw Error("The microphone returned invalid audio.");
      view.setInt16(
        offset,
        Math.round(Math.max(-1, Math.min(32767 / 32768, sample)) * 32768),
        true,
      );
      offset += 2;
    }
  return bytes;
}
export function voiceBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export async function startVoiceCapture(options: {
  signal: AbortSignal;
  onSeconds: (seconds: number) => void;
  onLimit: () => void;
  onError?: (message: string) => void;
}) {
  if (
    !navigator.mediaDevices?.getUserMedia ||
    typeof AudioWorkletNode === "undefined" ||
    typeof AudioContext === "undefined"
  )
    throw Error("Microphone recording is unavailable in this browser.");
  let stream: MediaStream | undefined,
    context: AudioContext | undefined,
    node: AudioWorkletNode | undefined;
  const chunks: Float32Array[] = [];
  let wallTimer: ReturnType<typeof setTimeout> | undefined;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let failure: Error | undefined, finishing: Promise<Uint8Array> | undefined;
  let rejectStartup: ((error: Error) => void) | undefined;
  const removers: (() => void)[] = [];
  let count = 0,
    done = false,
    flush!: () => void;
  const flushed = new Promise<void>((resolve) => {
    flush = resolve;
  });
  const cleanup = () => {
    clearTimeout(wallTimer);
    clearTimeout(startupTimer);
    rejectStartup?.(failure ?? Error("Voice input was cancelled."));
    rejectStartup = undefined;
    for (const remove of removers.splice(0)) remove();
    stream?.getTracks().forEach((track) => track.stop());
    node?.disconnect();
    if (node) {
      node.onprocessorerror = null;
      node.port.onmessage = null;
      node.port.close();
    }
    options.signal.removeEventListener("abort", cleanup);
    if (context && context.state !== "closed")
      void context.close().catch(() => {});
    chunks.length = 0;
    done = true;
    flush();
  };
  const fail = (message: string) => {
    if (failure || options.signal.aborted || done) return;
    failure = Error(message);
    cleanup();
    options.onError?.(message);
  };
  const check = () => {
    if (failure) throw failure;
    if (options.signal.aborted) {
      cleanup();
      throw Error("Voice input was cancelled.");
    }
  };
  options.signal.addEventListener("abort", cleanup, { once: true });
  try {
    check();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
      video: false,
    });
    check();
    for (const track of stream.getAudioTracks()) {
      if (track.readyState !== "live")
        throw Error(
          "The microphone is no longer available. Try recording again.",
        );
      const ended = () =>
        fail(
          "The microphone was disconnected or its permission was revoked. This recording was discarded.",
        );
      track.addEventListener("ended", ended);
      removers.push(() => track.removeEventListener("ended", ended));
    }
    context = new AudioContext();
    if (context.sampleRate < 8000 || context.sampleRate > 96000)
      throw Error("The microphone sample rate is unsupported.");
    const startupDeadline = new Promise<never>((_, reject) => {
      startupTimer = setTimeout(
        () =>
          reject(
            Error(
              "The microphone could not start. Check browser access and try again.",
            ),
          ),
        10000,
      );
    });
    const startupStopped = new Promise<never>((_, reject) => {
      rejectStartup = reject;
    });
    await Promise.race([
      context.audioWorklet.addModule(
        new URL("./voice-worklet.js?no-inline", import.meta.url).href,
      ),
      startupDeadline,
      startupStopped,
    ]);
    check();
    node = new AudioWorkletNode(context, "codeboom-voice-capture", {
      channelCount: 1,
      channelCountMode: "explicit",
    });
    node.onprocessorerror = () =>
      fail(
        "The microphone recorder stopped unexpectedly. This recording was discarded.",
      );
    node.port.onmessage = (event) => {
      if (options.signal.aborted) return;
      if (event.data instanceof Float32Array && !done) {
        if (
          count + event.data.length >
          context!.sampleRate * VOICE_MAX_SECONDS
        ) {
          fail(
            "The microphone exceeded the recording limit. This recording was discarded.",
          );
          return;
        }
        chunks.push(event.data);
        count += event.data.length;
        options.onSeconds(count / context!.sampleRate);
      } else if (event.data?.done) {
        done = true;
        flush();
        stream?.getTracks().forEach((track) => track.stop());
        if (event.data.limit) options.onLimit();
      }
    };
    context.createMediaStreamSource(stream).connect(node);
    node.connect(context.destination);
    await Promise.race([context.resume(), startupDeadline, startupStopped]);
    check();
    clearTimeout(startupTimer);
    if (context.state !== "running")
      throw Error(
        "The microphone could not start. Check browser access and try again.",
      );
    wallTimer = setTimeout(() => {
      stream?.getTracks().forEach((track) => track.stop());
      node?.port.postMessage("stop");
      options.onLimit();
    }, VOICE_MAX_SECONDS * 1000);
    return {
      finish() {
        return (finishing ??= (async () => {
          stream?.getTracks().forEach((track) => track.stop());
          if (!done) node!.port.postMessage("stop");
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              flushed,
              new Promise((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      Error("The microphone could not finish the recording."),
                    ),
                  1000,
                );
              }),
            ]);
            check();
            return voiceWav(chunks, context!.sampleRate);
          } finally {
            clearTimeout(timer);
            cleanup();
          }
        })());
      },
      cancel: cleanup,
    };
  } catch (error) {
    cleanup();
    if (error instanceof DOMException && error.name === "NotAllowedError")
      throw Error(
        "Microphone permission was not granted. Allow access in your browser, then try again.",
      );
    if (error instanceof DOMException && error.name === "NotFoundError")
      throw Error("No microphone is available. Connect one, then try again.");
    throw error;
  }
}
