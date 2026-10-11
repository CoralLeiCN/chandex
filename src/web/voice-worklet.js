// Fixed same-origin PCM capture; outputs remain silent to avoid feedback.
class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.used = 0;
    this.total = 0;
    this.stopped = false;
    this.port.onmessage = (event) => {
      if (event.data === "stop") this.stop(false);
    };
  }
  flush() {
    if (this.used) {
      const chunk = this.buffer.slice(0, this.used);
      this.port.postMessage(chunk, [chunk.buffer]);
      this.used = 0;
    }
  }
  stop(limit) {
    if (this.stopped) return;
    this.stopped = true;
    this.flush();
    this.port.postMessage({ done: true, limit });
  }
  process(inputs) {
    if (this.stopped) return false;
    const input = inputs[0]?.[0];
    if (input)
      for (const sample of input) {
        if (this.total >= sampleRate * 120) {
          this.stop(true);
          return false;
        }
        this.buffer[this.used++] = sample;
        this.total++;
        if (this.used === this.buffer.length) this.flush();
      }
    return true;
  }
}
registerProcessor("codeboom-voice-capture", VoiceCaptureProcessor);
