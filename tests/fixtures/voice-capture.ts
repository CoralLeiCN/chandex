/** Deterministic browser-API doubles: no microphone hardware or OS permission. */
export function voiceEnvironment(
  options: { module?: () => Promise<void>; resume?: () => Promise<void> } = {},
) {
  const names = ["navigator", "AudioContext", "AudioWorkletNode"],
    descriptors = new Map(
      names.map((name) => [
        name,
        Object.getOwnPropertyDescriptor(globalThis, name),
      ]),
    );
  const contexts: Context[] = [],
    nodes: Worklet[] = [];
  class Track extends EventTarget {
    readyState = "live";
    stops = 0;
    stop() {
      this.readyState = "ended";
      this.stops++;
    }
    end() {
      this.readyState = "ended";
      this.dispatchEvent(new Event("ended"));
    }
  }
  const track = new Track(),
    stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class Context {
    state = "suspended";
    sampleRate = 16000;
    destination = {};
    closes = 0;
    moduleCalls: string[] = [];
    constructor() {
      contexts.push(this);
    }
    audioWorklet = {
      addModule: async (url: string) => {
        this.moduleCalls.push(url);
        await options.module?.();
      },
    };
    createMediaStreamSource() {
      return { connect: () => {} };
    }
    async resume() {
      await options.resume?.();
      this.state = "running";
    }
    async close() {
      this.closes++;
      this.state = "closed";
    }
  }
  class Worklet {
    onprocessorerror: (() => void) | null = null;
    disconnects = 0;
    outputConnections = 0;
    closes = 0;
    stops = 0;
    tail: Float32Array | null = null;
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      close: () => {
        this.closes++;
      },
      postMessage: (message: string) => {
        if (message !== "stop") return;
        this.stops++;
        queueMicrotask(() => {
          if (this.tail) this.port.onmessage?.({ data: this.tail });
          this.port.onmessage?.({ data: { done: true, limit: false } });
        });
      },
    };
    constructor() {
      nodes.push(this);
    }
    connect() {
      this.outputConnections++;
    }
    disconnect() {
      this.disconnects++;
    }
    samples(values: number[]) {
      this.port.onmessage?.({ data: Float32Array.from(values) });
    }
  }
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "Codeboom unit test browser",
      platform: "",
      mediaDevices: { getUserMedia: async () => stream },
    },
  });
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: Context,
  });
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    configurable: true,
    value: Worklet,
  });
  return {
    track,
    contexts,
    nodes,
    restore() {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}
