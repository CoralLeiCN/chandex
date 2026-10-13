import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { NoteTrash } from "../src/web/note-trash.tsx";

const note = {
  id: "saved",
  title: "Research 🦉",
  trashed_at: "2026-10-13T10:00:00Z",
  trash_version: 3,
  revision_count: 2,
  draft_count: 1,
  snapshot_count: 2,
  conversation_count: 1,
};
async function fixture(request: typeof fetch) {
  const dom = new JSDOM(
    '<button id="opener">Trash</button><div id="app"></div>',
    { url: "http://127.0.0.1:4317", pretendToBeVisual: true },
  );
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  const globals = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: request,
  };
  const original = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("app")!);
  dom.window.document.getElementById("opener")!.focus();
  let closes = 0,
    changes = 0;
  await act(async () =>
    root.render(
      React.createElement(NoteTrash, {
        notebookId: "notebook",
        onClose: () => {
          closes++;
        },
        onChange: async () => {
          changes++;
        },
      }),
    ),
  );
  return {
    dom,
    get closes() {
      return closes;
    },
    get changes() {
      return changes;
    },
    button: (name: string) =>
      [...dom.window.document.querySelectorAll("button")].find(
        (b) => b.textContent === name,
      )!,
    click: async (button: HTMLButtonElement) => {
      await act(async () => button.click());
    },
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

test("Trash dialog restores the scoped version, names permanent effects and requires an explicit final deletion click", async () => {
  const writes: { url: string; method: string; body: any }[] = [];
  let items = [note];
  const f = await fixture((async (url, options) => {
    if (!options?.method || options.method === "GET") return json(items);
    writes.push({
      url: String(url),
      method: options.method,
      body: JSON.parse(options.body as string),
    });
    items = [];
    return json({ deleted: true });
  }) as typeof fetch);
  try {
    await f.click(f.button("Delete permanently…"));
    assert.equal(writes.length, 0);
    const text = f.dom.window.document.body.textContent!;
    for (const phrase of [
      "2 saved revisions",
      "pinned note conversations",
      "snapshots (2) will be purged",
      "references in authored notes",
      "Original imported sources",
      "backups",
      "cannot be undone",
    ])
      assert.ok(text.includes(phrase), phrase);
    assert.equal(
      f.dom.window.document.activeElement,
      f.button("Keep in Trash"),
    );
    await f.click(f.button("Keep in Trash"));
    assert.equal(writes.length, 0);
    await f.click(f.button("Restore"));
    assert.deepEqual(writes[0], {
      url: "/api/notebooks/notebook/artifacts/saved/trash/restore",
      method: "POST",
      body: { trashVersion: 3 },
    });
    assert.equal(f.changes, 1);
    assert.match(f.dom.window.document.body.textContent!, /Trash is empty/);
    assert.equal(
      f.dom.window.document.activeElement?.textContent,
      "Trashed notes",
    );
  } finally {
    await f.close();
  }
});

test("failed and pending permanent deletion retains the note, shows retryable errors and blocks close/repeated actions", async () => {
  let resolve!: (result: Response) => void;
  let fail = true;
  const writes: any[] = [];
  const f = await fixture((async (url, options) => {
    if (!options?.method || options.method === "GET")
      return json(writes.length > 1 && !fail ? [] : [note]);
    writes.push(JSON.parse(options.body as string));
    if (fail) return json({ error: "Trash changed. Reopen Trash." }, 400);
    return new Promise<Response>((r) => {
      resolve = r;
    });
  }) as typeof fetch);
  try {
    await f.click(f.button("Delete permanently…"));
    await f.click(f.button("Delete permanently"));
    assert.equal(f.changes, 0);
    assert.match(
      f.dom.window.document.querySelector('[role="alert"]')!.textContent!,
      /Trash changed/,
    );
    assert.ok(f.button("Keep in Trash"));
    fail = false;
    await f.click(f.button("Delete permanently"));
    assert.equal(f.button("Deleting…").disabled, true);
    assert.equal(f.button("Keep in Trash").disabled, true);
    const close = f.dom.window.document.querySelector<HTMLButtonElement>(
      '[aria-label="Close dialog"]',
    )!;
    assert.equal(close.disabled, true);
    await f.click(close);
    await act(async () =>
      f.dom.window.document
        .querySelector("dialog")!
        .dispatchEvent(new f.dom.window.Event("cancel", { cancelable: true })),
    );
    assert.equal(f.closes, 0);
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1], { trashVersion: 3, confirm: true });
    await act(async () => resolve(json({ deleted: true })));
    assert.equal(f.changes, 1);
    assert.match(f.dom.window.document.body.textContent!, /Trash is empty/);
  } finally {
    await f.close();
  }
});
