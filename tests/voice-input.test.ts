import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { VoiceInput } from "../src/web/voice-input.tsx";
import type { startVoiceCapture } from "../src/web/voice-capture.ts";
import { speechWav } from "./fixtures/audio-overview.ts";
type Services = NonNullable<
  React.ComponentProps<typeof VoiceInput>["services"]
>;
async function mounted(
  services: Services,
  onInsert: (text: string) => void = () => {},
) {
  const dom = new JSDOM('<div id="app"></div>', {
    url: "http://127.0.0.1:4317",
    pretendToBeVisual: true,
  });
  const values: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    requestAnimationFrame: (fn: () => void) => {
      fn();
      return 1;
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const originals = new Map(
    Object.keys(values).map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  for (const [name, value] of Object.entries(values))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value,
      writable: true,
    });
  const { createRoot } = await import("react-dom/client");
  const container = dom.window.document.getElementById("app")!,
    root = createRoot(container),
    busy: boolean[] = [];
  let starts = 0;
  await act(async () => {
    root.render(
      React.createElement(VoiceInput, {
        notebookId: "notebook",
        disabled: false,
        onStart: () => {
          starts++;
        },
        onInsert,
        onBusy: (value) => busy.push(value),
        services,
      }),
    );
  });
  const click = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === label,
    );
    assert.ok(button, "Missing " + label);
    await act(async () => {
      button.click();
    });
  };
  let closed = false;
  return {
    container,
    busy,
    starts: () => starts,
    click,
    async close() {
      if (closed) return;
      closed = true;
      await act(async () => root.unmount());
      dom.window.close();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}
function captureServices() {
  let args!: Parameters<typeof startVoiceCapture>[0],
    captureCalls = 0,
    cancels = 0,
    finishes = 0;
  const requests: {
    path: string;
    method: string;
    body?: unknown;
    options?: Pick<RequestInit, "signal" | "keepalive">;
  }[] = [];
  const services: Services = {
    capture: async (options) => {
      args = options;
      captureCalls++;
      return {
        finish: async () => {
          finishes++;
          return new Uint8Array(speechWav());
        },
        cancel: () => {
          cancels++;
        },
      };
    },
    request: async (path, method = "GET", body, options) => {
      requests.push({ path, method, body, options });
      return method === "POST"
        ? {
            id: "dictation",
            status: "completed",
            text: "Do not start. <script>literal</script> 🦉",
          }
        : { discarded: true };
    },
  };
  return {
    services,
    requests,
    args: () => args,
    calls: () => ({ captureCalls, cancels, finishes }),
  };
}
test("dictation UI starts only explicitly, requires review, inserts corrected words and discards the transient request", async () => {
  const fake = captureServices(),
    inserted: string[] = [],
    ui = await mounted(fake.services, (text) => inserted.push(text));
  try {
    assert.equal(fake.calls().captureCalls, 0);
    assert.deepEqual(ui.busy, [false]);
    await ui.click("Record voice input");
    assert.equal(ui.starts(), 1);
    assert.equal(fake.calls().captureCalls, 1);
    assert.ok(ui.busy.at(-1));
    await ui.click("Stop and transcribe");
    assert.equal(fake.calls().finishes, 1);
    assert.equal(inserted.length, 0);
    const review = ui.container.querySelector("textarea")!;
    assert.ok(review);
    assert.equal(review.value, "Do not start. <script>literal</script> 🦉");
    assert.equal(ui.container.querySelector("script"), null);
    // Native input dispatch in a disposable unit DOM, never a user browser.
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        ui.container.ownerDocument.defaultView!.HTMLTextAreaElement.prototype,
        "value",
      )!.set!.call(review, "Reviewed: do not start.");
      review.dispatchEvent(
        new ui.container.ownerDocument.defaultView!.Event("input", {
          bubbles: true,
        }),
      );
    });
    await ui.click("Insert into note");
    assert.deepEqual(inserted, ["Reviewed: do not start."]);
    assert.equal(ui.container.querySelector("textarea"), null);
    assert.equal(ui.busy.at(-1), false);
    assert.ok(
      fake.requests.some(
        (request) =>
          request.method === "DELETE" && request.path.endsWith("/dictation"),
      ),
    );
    assert.equal(
      fake.requests.filter((request) => request.method === "POST").length,
      1,
    );
    assert.equal(fake.args().signal.aborted, true);
  } finally {
    await ui.close();
  }
});
test("failed insertion retains the reviewed words and keeps the draft locked until explicit discard", async () => {
  const fake = captureServices(),
    ui = await mounted(fake.services, () => {
      throw Error("Insertion refused; review retained.");
    });
  try {
    await ui.click("Record voice input");
    await ui.click("Stop and transcribe");
    await ui.click("Insert into note");
    assert.equal(
      ui.container.querySelector("textarea")!.value,
      "Do not start. <script>literal</script> 🦉",
    );
    assert.match(
      ui.container.querySelector('[role="alert"]')!.textContent!,
      /review retained/,
    );
    assert.equal(ui.busy.at(-1), true);
    await ui.click("Discard dictation");
    assert.equal(ui.busy.at(-1), false);
    assert.equal(ui.container.querySelector("textarea"), null);
  } finally {
    await ui.close();
  }
});
test("recorder interruption restores idle controls and unmount stops an active microphone", async () => {
  const fake = captureServices(),
    ui = await mounted(fake.services);
  try {
    await ui.click("Record voice input");
    await act(async () =>
      fake.args().onError!("Microphone disconnected; recording discarded."),
    );
    assert.match(
      ui.container.querySelector('[role="alert"]')!.textContent!,
      /disconnected/,
    );
    assert.equal(ui.busy.at(-1), false);
    assert.equal(fake.args().signal.aborted, true);
    await ui.click("Record voice input");
    const current = fake.args();
    await ui.close();
    assert.equal(current.signal.aborted, true);
    assert.ok(fake.calls().cancels >= 1);
  } catch (error) {
    await ui.close();
    throw error;
  }
});
test("cancelling while microphone access is pending stops a late capture without uploading", async () => {
  const fake = captureServices();
  let grant!: (value: Awaited<ReturnType<typeof startVoiceCapture>>) => void,
    cancelled = 0;
  fake.services.capture = () =>
    new Promise((resolve) => {
      grant = resolve;
    });
  const ui = await mounted(fake.services);
  try {
    await ui.click("Record voice input");
    assert.match(ui.container.textContent!, /Waiting for microphone/);
    await ui.click("Cancel voice input");
    await act(async () =>
      grant({
        finish: async () => {
          throw Error("Must not upload");
        },
        cancel: () => {
          cancelled++;
        },
      }),
    );
    assert.equal(cancelled, 1);
    assert.equal(fake.requests.length, 0);
    assert.equal(ui.busy.at(-1), false);
  } finally {
    await ui.close();
  }
});
test("cancelling before the upload response discards its late job and cannot replace a new recording", async () => {
  const fake = captureServices();
  let uploaded!: (value: unknown) => void;
  fake.services.request = async (path, method = "GET", body, options) => {
    fake.requests.push({ path, method, body, options });
    if (method === "POST")
      return new Promise((resolve) => {
        uploaded = resolve;
      });
    return { discarded: true };
  };
  const ui = await mounted(fake.services);
  try {
    await ui.click("Record voice input");
    await ui.click("Stop and transcribe");
    await ui.click("Cancel voice input");
    const upload = fake.requests.find((request) => request.method === "POST")!,
      cancel = fake.requests.find((request) => request.method === "DELETE")!;
    assert.deepEqual(cancel.body, {
      idempotency: (upload.body as { idempotency: string }).idempotency,
    });
    assert.equal(cancel.path, upload.path);
    assert.equal(cancel.options?.keepalive, true);
    assert.equal(upload.options?.signal?.aborted, true);
    await ui.click("Record voice input");
    await act(async () =>
      uploaded({
        id: "late-job",
        status: "completed",
        text: "Must not be shown",
      }),
    );
    assert.equal(ui.container.querySelector("textarea"), null);
    assert.match(ui.container.textContent!, /Recording ·/);
    assert.ok(
      fake.requests.some(
        (request) =>
          request.method === "DELETE" && request.path.endsWith("/late-job"),
      ),
    );
    assert.equal(
      fake.requests.filter((request) => request.method === "GET").length,
      0,
    );
  } finally {
    await ui.close();
  }
});
test("a failed transient job is discarded by its request key and restores the note controls", async () => {
  const fake = captureServices();
  fake.services.request = async (path, method = "GET", body) => {
    fake.requests.push({ path, method, body });
    return method === "POST"
      ? {
          id: "failed-job",
          status: "failed",
          error: "No clear words recognized.",
        }
      : { discarded: true };
  };
  const ui = await mounted(fake.services);
  try {
    await ui.click("Record voice input");
    await ui.click("Stop and transcribe");
    assert.match(
      ui.container.querySelector('[role="alert"]')!.textContent!,
      /No clear words/,
    );
    assert.equal(ui.busy.at(-1), false);
    assert.equal(fake.args().signal.aborted, true);
    const upload = fake.requests.find((request) => request.method === "POST")!,
      cancelled = fake.requests.find((request) => request.method === "DELETE")!;
    assert.equal(cancelled.path, upload.path);
    assert.deepEqual(cancelled.body, {
      idempotency: (upload.body as { idempotency: string }).idempotency,
    });
  } finally {
    await ui.close();
  }
});

test("pagehide immediately cancels a pending upload by key, releases capture and restores idle on return", async () => {
  const fake = captureServices();
  let resolveUpload!: (value: unknown) => void;
  fake.services.request = async (path, method = "GET", body, options) => {
    fake.requests.push({ path, method, body, options });
    if (method === "POST")
      return new Promise((resolve) => {
        resolveUpload = resolve;
      });
    return { discarded: true };
  };
  const ui = await mounted(fake.services);
  try {
    await ui.click("Record voice input");
    await ui.click("Stop and transcribe");
    const upload = fake.requests.find((request) => request.method === "POST")!;
    await act(async () => window.dispatchEvent(new window.Event("pagehide")));
    const cancelled = fake.requests.find(
      (request) => request.method === "DELETE",
    )!;
    assert.deepEqual(cancelled.body, {
      idempotency: (upload.body as { idempotency: string }).idempotency,
    });
    assert.equal(cancelled.options?.keepalive, true);
    assert.equal(upload.options?.signal?.aborted, true);
    assert.equal(ui.busy.at(-1), false);
    await ui.click("Record voice input");
    await act(async () =>
      resolveUpload({
        id: "late-page-job",
        status: "completed",
        text: "Discarded words",
      }),
    );
    assert.equal(ui.container.querySelector("textarea"), null);
    assert.match(ui.container.textContent!, /Recording ·/);
    await act(async () => window.dispatchEvent(new window.Event("pagehide")));
    assert.ok(fake.calls().cancels > 0);
    assert.equal(ui.busy.at(-1), false);
    const before = fake.requests.length;
    await ui.close();
    assert.equal(fake.requests.length, before);
  } finally {
    await ui.close();
  }
});

test("closing the editor cancels by key without waiting for an upload response", async () => {
  const fake = captureServices();
  let resolveUpload!: (value: unknown) => void;
  fake.services.request = async (path, method = "GET", body, options) => {
    fake.requests.push({ path, method, body, options });
    if (method === "POST")
      return new Promise((resolve) => {
        resolveUpload = resolve;
      });
    return { discarded: true };
  };
  const ui = await mounted(fake.services);
  try {
    await ui.click("Record voice input");
    await ui.click("Stop and transcribe");
    const upload = fake.requests.find((request) => request.method === "POST")!;
    await ui.close();
    const cancelled = fake.requests.find(
      (request) => request.method === "DELETE",
    )!;
    assert.deepEqual(cancelled.body, {
      idempotency: (upload.body as { idempotency: string }).idempotency,
    });
    assert.equal(cancelled.options?.keepalive, true);
    assert.equal(upload.options?.signal?.aborted, true);
    assert.equal(
      fake.requests.filter((request) => request.method === "GET").length,
      0,
    );
    resolveUpload({
      id: "closed-job",
      status: "completed",
      text: "Must never enter a closed note",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(ui.container.textContent, "");
  } finally {
    await ui.close();
  }
});
