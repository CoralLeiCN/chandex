import { renderMacSpeech } from "./macos-speech.ts";
const controller = new AbortController();
let running: Promise<void> = Promise.resolve();
const stop = () => {
  controller.abort();
  void running.finally(() => process.exit(1));
};
process.once("disconnect", stop);
process.once("SIGTERM", stop);
process.once("message", (message: any) => {
  running = (async () => {
    try {
      if (
        typeof message?.text !== "string" ||
        typeof message?.voiceId !== "string" ||
        typeof message?.stageRoot !== "string"
      )
        throw new Error("Invalid speech process input.");
      const result = await renderMacSpeech(message.text, message.voiceId, {
        signal: controller.signal,
        stageRoot: message.stageRoot,
        timeoutMs: message.timeoutMs,
      });
      if (process.connected) process.send!({ result });
    } catch (error) {
      if (process.connected)
        process.send!({
          error:
            error instanceof Error ? error.message : "Speech rendering failed.",
        });
    }
  })();
});
