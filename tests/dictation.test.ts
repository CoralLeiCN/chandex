import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { Store } from "../src/storage/store.ts";
import { digest } from "../src/domain/evidence.ts";
import { DictationService } from "../src/server/dictation-service.ts";
import { speechWav } from "./fixtures/audio-overview.ts";
import {
  voiceWav,
  voiceBase64,
  startVoiceCapture,
} from "../src/web/voice-capture.ts";
import { decodeWav } from "../src/ingestion/audio-pcm.ts";
import { AUDIO_ASSET_ERROR } from "../src/ingestion/audio-assets.ts";
import { dictationContent } from "../src/web/voice-capture.ts";
import { getSchema } from "@tiptap/core";
import { noteEditorExtensions } from "../src/web/note-editor.tsx";
import { EditorState } from "@tiptap/pm/state";
import { Fragment } from "@tiptap/pm/model";
const result = {
  sections: [
    {
      text: "Approval is still pending. Do not start the rollout.",
      locator: "Audio · estimated timing",
    },
  ],
  warnings: ["Uncertain recognition"],
};
const settle = async (service: DictationService) => {
  for (let i = 0; i < 100 && service.controllers.size; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(service.controllers.size, 0);
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codeboom-dictation-")),
    store = new Store(root),
    n = store.createNotebook("Personal notes").id,
    other = store.createNotebook("Foreign").id;
  return {
    root,
    store,
    n,
    other,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("dictation returns verbatim review text, scopes idempotency and writes no sources, jobs, notes or audio", async () => {
  const f = fixture();
  let calls = 0;
  const service = new DictationService(f.store, async () => {
    calls++;
    return result;
  });
  try {
    const job = service.begin(f.n, speechWav(), "request");
    assert.equal(service.begin(f.n, speechWav(), "request").id, job.id);
    assert.throws(
      () => service.begin(f.other, speechWav(), "request"),
      /another recording/,
    );
    assert.throws(
      () => service.begin(f.n, speechWav({ seconds: 0.2 }), "request"),
      /another recording/,
    );
    assert.throws(() => service.get(f.other, job.id), /not found/);
    await settle(service);
    assert.equal(calls, 1);
    assert.equal(service.get(f.n, job.id).text, result.sections[0].text);
    for (const table of [
      "sources",
      "jobs",
      "artifacts",
      "speech_jobs",
      "speech_assets",
    ])
      assert.equal(
        f.store.one(`SELECT count(*) AS count FROM ${table}`).count,
        0,
      );
    assert.deepEqual(readdirSync(f.store.blobs), []);
    service.discard(f.n, job.id);
    assert.throws(() => service.get(f.n, job.id), /not found/);
  } finally {
    service.shutdown();
    f.close();
  }
});
test("dictation shares bounded recognition capacity and retains cancelled slots until native settlement", async () => {
  const f = fixture();
  let finish!: (value: typeof result) => void,
    signal!: AbortSignal,
    otherActive = 1;
  const service = new DictationService(
    f.store,
    async (_bytes, _kind, options) => {
      signal = options!.signal!;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    () => otherActive,
  );
  try {
    const job = service.begin(f.n, speechWav(), "one");
    assert.throws(() => service.begin(f.n, speechWav(), "two"), /busy/);
    service.discard(f.n, job.id);
    assert.equal(signal.aborted, true);
    assert.throws(() => service.begin(f.n, speechWav(), "too-soon"), /busy/);
    finish(result);
    await settle(service);
    assert.equal(service.jobs.size, 0);
    otherActive = 0;
    service.begin(f.n, speechWav(), "after-exit");
    service.cancelNotebook(f.n);
    finish(result);
    await settle(service);
    assert.equal(service.jobs.size, 0);
  } finally {
    service.shutdown();
    f.close();
  }
});
test("request-key cancellation beats delayed upload and replay, enforces owner scope and holds native capacity", async () => {
  const f = fixture();
  let calls = 0,
    signal!: AbortSignal,
    finish!: (value: typeof result) => void;
  const service = new DictationService(
    f.store,
    async (_bytes, _kind, options) => {
      calls++;
      signal = options!.signal!;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    () => 1,
  );
  try {
    service.cancelRequest(f.n, "before-upload");
    service.cancelRequest(f.n, "before-upload");
    assert.equal(service.cancelled.size, 1);
    assert.throws(
      () => service.begin(f.n, speechWav(), "before-upload"),
      /cancelled/,
    );
    assert.throws(
      () => service.begin(f.other, speechWav(), "before-upload"),
      /another recording/,
    );
    assert.throws(
      () => service.cancelRequest(f.other, "before-upload"),
      /another recording/,
    );
    assert.equal(calls, 0);
    const first = service.begin(f.n, speechWav(), "in-flight");
    assert.throws(
      () => service.cancelRequest(f.other, "in-flight"),
      /another recording/,
    );
    assert.equal(signal.aborted, false);
    service.cancelRequest(f.n, "in-flight");
    assert.equal(signal.aborted, true);
    assert.throws(() => service.get(f.n, first.id), /not found/);
    assert.throws(() => service.begin(f.n, speechWav(), "new-request"), /busy/);
    assert.throws(
      () => service.begin(f.n, speechWav(), "in-flight"),
      /cancelled/,
    );
    finish(result);
    await settle(service);
    assert.equal(service.jobs.size, 0);
    assert.equal(calls, 1);
    service.cancelNotebook(f.n);
    assert.equal(service.cancelled.size, 0);
    assert.equal(
      f.store.one("SELECT count(*) AS count FROM artifacts").count,
      0,
    );
    assert.deepEqual(readdirSync(f.store.blobs), []);
  } finally {
    service.shutdown();
    f.close();
  }
});
test("bounded cancellation markers reserve space for admitted work, expire and clear without evicting protection", async () => {
  const f = fixture();
  let finish!: (value: typeof result) => void;
  const service = new DictationService(
    f.store,
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    const job = service.begin(f.n, speechWav(), "reserved");
    for (let i = 0; i < 255; i++) service.cancelRequest(f.n, "unknown-" + i);
    assert.throws(() => service.cancelRequest(f.n, "excess"), /Too many/);
    assert.throws(() => service.begin(f.n, speechWav(), "excess"), /Too many/);
    service.discard(f.n, job.id);
    assert.equal(service.cancelled.size, 256);
    assert.throws(
      () => service.begin(f.n, speechWav(), "reserved"),
      /cancelled/,
    );
    assert.throws(
      () => service.begin(f.n, speechWav(), "unknown-0"),
      /cancelled/,
    );
    service.cancelled.get("unknown-0")!.expires = Date.now() - 1;
    service.cancelRequest(f.n, "after-expiry");
    assert.equal(service.cancelled.size, 256);
    assert.equal(service.cancelled.has("unknown-0"), false);
    finish(result);
    await settle(service);
    service.shutdown();
    assert.equal(service.cancelled.size, 0);
  } finally {
    service.shutdown();
    f.close();
  }
});
test("request-key cancellation settles recognition before releasing its slot and persists no recording", async () => {
  const native = process.env.CODEBOOM_TEST_NATIVE_CANCEL === "true",
    output = process.env.CODEBOOM_DICTATION_CANCEL_RESULT;
  if (output && (!native || existsSync(output)))
    throw Error("Choose a new result path for native cancellation.");
  const f = fixture();
  const service = new DictationService(
    f.store,
    native
      ? undefined
      : async (_bytes, _kind, options) => {
          options!.onProgress!("recognizing");
          return new Promise((resolve) =>
            options!.signal!.addEventListener(
              "abort",
              () => setTimeout(() => resolve(result), 5),
              { once: true },
            ),
          );
        },
  );
  let report: unknown;
  try {
    const counts = () =>
      Object.fromEntries(
        [
          "sources",
          "revisions",
          "passages",
          "jobs",
          "artifacts",
          "artifact_revisions",
          "speech_jobs",
          "speech_assets",
        ].map((table) => [
          table,
          f.store.one(`SELECT count(*) AS count FROM ${table}`).count,
        ]),
      );
    const before = counts(),
      bytes = native
        ? readFileSync(new URL("./fixtures/audio/speech.wav", import.meta.url))
        : speechWav(),
      key = "native-key-cancel",
      job = service.begin(f.n, bytes, key);
    const deadline = performance.now() + 15000;
    while (service.get(f.n, job.id).stage !== "recognizing") {
      assert.equal(service.get(f.n, job.id).status, "processing");
      if (performance.now() > deadline)
        throw Error("Recognition stage did not arrive.");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const started = performance.now();
    service.cancelRequest(f.n, key);
    assert.equal(service.jobs.size, 0);
    assert.equal(service.controllers.size, 1);
    assert.throws(() => service.begin(f.n, bytes, key), /cancelled/);
    while (service.controllers.size) {
      if (performance.now() - started > 5000)
        throw Error("Cancelled recognizer did not settle.");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const cancellationMs = performance.now() - started;
    assert.deepEqual(counts(), before);
    assert.deepEqual(readdirSync(f.store.blobs), []);
    report = {
      date: new Date().toISOString(),
      native,
      originalHash: digest(bytes),
      cancelledAfterStage: "recognizing",
      cancellationMs,
      jobRemovedBeforeSettlement: true,
      slotHeldUntilSettlement: true,
      replayRejected: true,
      activeRecognizersAfterSettlement: service.controllers.size,
      storageBefore: before,
      storageAfter: counts(),
      audioBlobs: 0,
      scope:
        "Direct dictation service request-key cancellation after local recognition begins. Native mode uses the installed model and disposable extraction process; separate HTTP/component tests cover pending-response and delayed-body races. No microphone hardware or actual browser exit delivery qualification.",
    };
  } finally {
    service.shutdown();
    const deadline = performance.now() + 5000;
    while (service.controllers.size && performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const remaining = service.controllers.size;
    f.close();
    assert.equal(remaining, 0);
  }
  if (output)
    writeFileSync(output, JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
    });
});
test("dictation refuses oversized, stereo and malformed recordings before starting recognition", () => {
  const f = fixture();
  let calls = 0;
  const service = new DictationService(f.store, async () => {
    calls++;
    return result;
  });
  try {
    for (const bytes of [
      Buffer.from("PRIVATE_CANARY"),
      speechWav({ channels: 2 }),
      speechWav({ seconds: 120.01 }),
      Buffer.alloc(24 * 1024 * 1024 + 1),
    ])
      assert.throws(() => service.begin(f.n, bytes, "invalid"));
    assert.equal(calls, 0);
    assert.equal(service.controllers.size, 0);
  } finally {
    service.shutdown();
    f.close();
  }
});
test("dictation sanitizes private engine failures, reports missing models, expires results and clears shutdown work", async () => {
  const f = fixture();
  let failure = "PRIVATE_CANARY /private/source";
  const service = new DictationService(f.store, async () => {
    throw Error(failure);
  });
  try {
    const first = service.begin(f.n, speechWav(), "failed");
    await settle(service);
    assert.doesNotMatch(
      service.get(f.n, first.id).error!,
      /PRIVATE_CANARY|private\/source/,
    );
    failure = AUDIO_ASSET_ERROR;
    const second = service.begin(f.n, speechWav(), "model");
    await settle(service);
    assert.match(service.get(f.n, second.id).error!, /audio:setup/);
    service.jobs.get(first.id)!.expires = Date.now() - 1;
    assert.throws(() => service.get(f.n, first.id), /not found/);
    service.shutdown();
    assert.equal(service.jobs.size, 0);
  } finally {
    service.shutdown();
    f.close();
  }
});
test("browser PCM encoding preserves complete sample order, rate and amplitude with strict duration bounds", () => {
  const bytes = voiceWav(
      [Float32Array.of(-1, 0), Float32Array.of(0.5, 1)],
      48000,
    ),
    pcm = decodeWav(Buffer.from(bytes));
  assert.equal(pcm.channels, 1);
  assert.equal(pcm.sampleRate, 48000);
  assert.deepEqual([...pcm.mono], [-1, 0, 0.5, 32767 / 32768]);
  assert.deepEqual(
    Buffer.from(voiceBase64(bytes), "base64"),
    Buffer.from(bytes),
  );
  for (const [chunks, rate] of [
    [[], 48000],
    [[Float32Array.of(NaN)], 16000],
    [[new Float32Array(16000 * 120 + 1)], 16000],
    [[Float32Array.of(1)], 96001],
  ] as const)
    assert.throws(() => voiceWav([...chunks], rate));
});
test("worklet flush retains its final partial buffer, enforces two-minute capture and never produces audible output", () => {
  let Processor: any;
  const messages: any[] = [];
  const context = vm.createContext({
    Float32Array,
    sampleRate: 8000,
    AudioWorkletProcessor: class {
      port = {
        onmessage: null,
        postMessage: (message: any) => messages.push(message),
      };
    },
    registerProcessor: (_name: string, value: any) => {
      Processor = value;
    },
  });
  vm.runInContext(
    readFileSync(
      new URL("../src/web/voice-worklet.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  const capture = new Processor();
  capture.process([[Float32Array.of(0.1, 0.2, 0.3)]]);
  capture.port.onmessage({ data: "stop" });
  assert.equal(messages[0].length, 3);
  assert.equal(messages[1].done, true);
  assert.equal(capture.process([]), false);
  messages.length = 0;
  const bounded = new Processor(),
    frame = new Float32Array(128);
  for (let i = 0; i < 8000; i++) if (!bounded.process([[frame]])) break;
  assert.equal(
    messages
      .filter((m) => m instanceof Float32Array)
      .reduce((sum, m) => sum + m.length, 0),
    8000 * 120,
  );
  assert.equal(messages.at(-1).limit, true);
});

test("cancelling while microphone permission is pending stops a late-granted stream before creating an audio graph", async () => {
  const descriptors = new Map(
    ["navigator", "AudioWorkletNode", "AudioContext"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  let grant!: (stream: MediaStream) => void,
    stopped = 0,
    contexts = 0;
  try {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: () =>
            new Promise((resolve) => {
              grant = resolve;
            }),
        },
      },
    });
    Object.defineProperty(globalThis, "AudioWorkletNode", {
      configurable: true,
      value: class {},
    });
    Object.defineProperty(globalThis, "AudioContext", {
      configurable: true,
      value: class {
        constructor() {
          contexts++;
        }
      },
    });
    const controller = new AbortController(),
      pending = startVoiceCapture({
        signal: controller.signal,
        onSeconds: () => {},
        onLimit: () => {},
      });
    controller.abort();
    grant({
      getTracks: () => [
        {
          stop: () => {
            stopped++;
          },
        },
      ],
    } as unknown as MediaStream);
    await assert.rejects(pending, /cancelled/);
    assert.ok(stopped >= 1);
    assert.equal(contexts, 0);
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test("reviewed dictation inserts literal text at the captured position without replacing existing words or creating markup", () => {
  const schema = getSchema(noteEditorExtensions),
    doc = schema.nodeFromJSON({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Before After" }],
        },
      ],
    }),
    state = EditorState.create({ schema, doc });
  const recognized = '<script>alert("private")</script>\r\nDo not start. 🦉';
  const nodes = dictationContent(recognized).map((node) =>
      schema.nodeFromJSON(node),
    ),
    next = state.apply(state.tr.insert(8, Fragment.fromArray(nodes)));
  assert.match(next.doc.textContent, /Before/);
  assert.match(next.doc.textContent, /After/);
  assert.ok(next.doc.textContent.includes('<script>alert("private")</script>'));
  assert.ok(next.doc.textContent.includes("Do not start. 🦉"));
  next.doc.descendants((node) => {
    assert.notEqual(node.type.name, "codeBlock");
    if (node.isText) assert.equal(node.marks.length, 0);
  });
});

test("inline dictation keeps headings, lists and code blocks intact and preserves reviewed line breaks", () => {
  const schema = getSchema(noteEditorExtensions),
    content = [{ type: "text", text: "Before After" }],
    reviewed =
      "<script>literal</script>\r\nDo not start. 🦉\n**not a formatting command**";
  for (const block of [
    { type: "paragraph", content },
    { type: "heading", attrs: { level: 2 }, content },
    { type: "codeBlock", content },
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [{ type: "paragraph", content }] },
      ],
    },
    {
      type: "orderedList",
      attrs: { start: 3 },
      content: [
        { type: "listItem", content: [{ type: "paragraph", content }] },
      ],
    },
  ]) {
    const doc = schema.nodeFromJSON({ type: "doc", content: [block] }),
      state = EditorState.create({ schema, doc });
    let position = 0;
    doc.descendants((node, offset) => {
      if (node.isText) position = offset + "Before ".length;
    });
    const next = state.apply(
      state.tr.insert(
        position,
        Fragment.fromArray(
          dictationContent(reviewed, block.type === "codeBlock").map((node) =>
            schema.nodeFromJSON(node),
          ),
        ),
      ),
    );
    next.doc.check();
    assert.equal(next.doc.firstChild!.type.name, block.type);
    assert.equal(
      next.doc.textBetween(0, next.doc.content.size, "", (node) =>
        node.type.name === "hardBreak" ? "\n" : "",
      ),
      "Before " + reviewed.replace(/\r\n?/g, "\n") + "After",
    );
    assert.equal(next.doc.childCount, doc.childCount);
    const blocks = (value: typeof doc) => {
      const types: string[] = [];
      value.descendants((node) => {
        if (node.isBlock) types.push(node.type.name);
      });
      return types;
    };
    assert.deepEqual(blocks(next.doc), blocks(doc));
  }
});
