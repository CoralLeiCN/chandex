import test from "node:test";
import assert from "node:assert/strict";
import React, { act, useRef, useState } from "react";
import { JSDOM } from "jsdom";
import { VoiceQuestion } from "../src/web/voice-question.tsx";

async function mounted(initial: string, recognized: string) {
  const dom = new JSDOM('<div id="app"></div>', {
    url: "http://127.0.0.1:4317",
    pretendToBeVisual: true,
  });
  const frames: (() => void)[] = [];
  const values: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    requestAnimationFrame: (fn: () => void) => frames.push(fn),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const original = new Map(
    Object.keys(values).map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  for (const [name, value] of Object.entries(values))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("app")!);
  const requests: { path: string; method: string }[] = [];
  let signal: AbortSignal | undefined,
    sends = 0,
    cancels = 0;
  const services: NonNullable<
    React.ComponentProps<typeof VoiceQuestion>["services"]
  > = {
    capture: async (options) => {
      signal = options.signal;
      return {
        finish: async () => new Uint8Array([1, 2]),
        cancel: () => {
          cancels++;
        },
      };
    },
    request: async (path, method = "GET") => {
      requests.push({ path, method });
      return method === "POST"
        ? { id: "recognized", status: "completed", text: recognized }
        : { discarded: true };
    },
  };
  function Composer() {
    const [value, setValue] = useState(initial),
      [busy, setBusy] = useState(false);
    const textarea = useRef<HTMLTextAreaElement>(null);
    return React.createElement(
      "form",
      {
        onSubmit: (e: React.FormEvent) => {
          e.preventDefault();
          if (!busy) sends++;
        },
      },
      React.createElement("textarea", {
        "aria-label": "Question",
        ref: textarea,
        value,
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) =>
          setValue(e.target.value),
        disabled: busy,
      }),
      React.createElement(VoiceQuestion, {
        notebookId: "personal",
        disabled: false,
        value,
        onChange: setValue,
        textarea,
        onBusy: setBusy,
        services,
      }),
      React.createElement("button", { disabled: busy }, "Send"),
    );
  }
  await act(async () => root.render(React.createElement(Composer)));
  const container = dom.window.document.getElementById("app")!;
  const click = async (label: string) => {
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === label,
    );
    assert.ok(button, label);
    await act(async () => button.click());
    await act(async () => {
      while (frames.length) frames.shift()!();
    });
  };
  return {
    container,
    requests,
    click,
    sends: () => sends,
    signal: () => signal,
    cancels: () => cancels,
    async close() {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [name, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}
test("voice question preserves surrounding text, reviews literal words, locks submission and sends only explicitly", async () => {
  const ui = await mounted(
    "Before replace after",
    "Do not approve <script> 🦉",
  );
  try {
    const question = ui.container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Question"]',
    )!;
    question.setSelectionRange(7, 14);
    assert.equal(ui.requests.length, 0);
    await ui.click("Dictate question");
    assert.ok(question.disabled);
    await ui.click("Send");
    assert.equal(ui.sends(), 0);
    await ui.click("Stop and transcribe");
    assert.equal(question.value, "Before replace after");
    assert.match(ui.container.textContent!, /does not send/);
    assert.equal(ui.container.querySelector("script"), null);
    await ui.click("Insert into question");
    assert.equal(question.value, "Before Do not approve <script> 🦉 after");
    assert.equal(ui.sends(), 0);
    assert.equal(
      question.selectionStart,
      7 + "Do not approve <script> 🦉".length,
    );
    assert.ok(!question.disabled);
    assert.equal(ui.container.querySelectorAll("textarea").length, 1);
    assert.ok(ui.signal()?.aborted);
    assert.ok(ui.requests.every((r) => r.path.includes("/dictation")));
    await ui.click("Send");
    assert.equal(ui.sends(), 1);
  } finally {
    await ui.close();
  }
});
test("voice question refuses overflow without truncation and unmount stops owned recording", async () => {
  const ui = await mounted("x".repeat(9999), "Too long");
  try {
    const question = ui.container.querySelector<HTMLTextAreaElement>(
      '[aria-label="Question"]',
    )!;
    question.setSelectionRange(9999, 9999);
    await ui.click("Dictate question");
    await ui.click("Stop and transcribe");
    await ui.click("Insert into question");
    assert.equal(question.value.length, 9999);
    assert.match(
      ui.container.querySelector('[role="alert"]')!.textContent!,
      /10,000/,
    );
    assert.equal(
      ui.container.querySelectorAll("textarea")[1].value,
      "Too long",
    );
    await ui.click("Discard dictation");
    await ui.click("Dictate question");
  } finally {
    await ui.close();
  }
  assert.ok(ui.signal()?.aborted);
  assert.equal(ui.cancels(), 1);
});
