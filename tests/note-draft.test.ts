import test from "node:test";
import assert from "node:assert/strict";
import React, { act, useState } from "react";
import { JSDOM } from "jsdom";
import type { Editor } from "@tiptap/core";
import type { RichNote } from "../src/domain/notes.ts";
import type { DraftReference } from "../src/domain/note-drafts.ts";
import { Store } from "../src/storage/store.ts";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { editableNote, richNote } from "../src/domain/notes.ts";
import { richFixture } from "./fixtures/notes.ts";
import { voiceEnvironment } from "./fixtures/voice-capture.ts";

async function fixture(
  options: {
    save?: (
      title: string,
      document: RichNote,
      context?: { baseRevisionId: string | null; draft?: DraftReference },
    ) => Promise<void>;
    module?: () => Promise<void>;
    text?: string;
    recovery?: boolean;
    fetch?: typeof fetch;
    notebookId?: string;
    artifactId?: string;
    baseRevisionId?: string;
    initial?: unknown;
  } = {},
) {
  const dom = new JSDOM('<div id="app"></div>', {
    url: "http://127.0.0.1:4317",
    pretendToBeVisual: true,
  });
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  dom.window.Range.prototype.getClientRects = () =>
    [] as unknown as DOMRectList;
  dom.window.Range.prototype.getBoundingClientRect = () =>
    new dom.window.DOMRect();
  const values: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (fn: () => void) => {
      queueMicrotask(fn);
      return 1;
    },
    cancelAnimationFrame: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch:
      options.fetch ??
      (async () => {
        throw Error("No request should be made in these draft checks.");
      }),
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
      writable: true,
      value,
    });
  const environment = voiceEnvironment({ module: options.module });
  let unmount = async () => {};
  const restore = async () => {
    await unmount();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    environment.restore();
    dom.window.close();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
  try {
    const { createRoot } = await import("react-dom/client"),
      { RichNoteEditor } = await import("../src/web/note-editor.tsx"),
      { NoteEditorDialog } = await import("../src/web/note-dialog.tsx"),
      { RecoverableNoteEditor } =
        await import("../src/web/recoverable-note-editor.tsx"),
      container = dom.window.document.getElementById("app")!,
      root = createRoot(container);
    unmount = async () => {
      await act(async () => root.unmount());
    };
    let closes = 0,
      saves = 0;
    function App() {
      const [open, setOpen] = useState(true);
      return open
        ? React.createElement(NoteEditorDialog, {
            title: "Edit note",
            onClose: () => {
              closes++;
              setOpen(false);
            },
            children: (onDraftState) => {
              const props = {
                initial: options.initial ?? {
                  text: options.text ?? "Original note 🦉",
                },
                initialTitle: "Original title",
                sources: [],
                notebookId: options.notebookId ?? "notebook",
                artifactId: options.artifactId ?? null,
                baseRevisionId: options.baseRevisionId ?? null,
                onDraftState,
                onSave: async (
                  title: string,
                  document: RichNote,
                  context?: {
                    baseRevisionId: string | null;
                    draft?: DraftReference;
                  },
                ) => {
                  saves++;
                  await options.save?.(title, document, context);
                  setOpen(false);
                },
              };
              return options.recovery
                ? React.createElement(RecoverableNoteEditor, props)
                : React.createElement(RichNoteEditor, props);
            },
          })
        : React.createElement("p", {}, "Editor closed");
    }
    await act(async () => root.render(React.createElement(App)));
    const click = async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (button) =>
          button.textContent === label ||
          button.getAttribute("aria-label") === label,
      );
      assert.ok(button, "Missing " + label);
      assert.equal(button.disabled, false);
      await act(async () => {
        button.focus();
        button.click();
      });
    };
    const title = async (value: string) => {
      const input = container.querySelector("input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          dom.window.HTMLInputElement.prototype,
          "value",
        )!.set!.call(input, value);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    };
    const cancel = async () => {
      const event = new dom.window.Event("cancel", { cancelable: true });
      await act(async () => {
        container.querySelector("dialog")!.dispatchEvent(event);
      });
      assert.equal(event.defaultPrevented, true);
    };
    const warned = () => {
      const event = new dom.window.Event("beforeunload", { cancelable: true });
      dom.window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const getEditor = () =>
      (
        container.querySelector('[aria-label="Note body"]') as HTMLElement & {
          editor: Editor;
        }
      ).editor;
    const escapeBody = async () => {
      await act(async () => {
        getEditor().view.dom.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    };
    return {
      container,
      environment,
      get editor() {
        return getEditor();
      },
      click,
      title,
      cancel,
      escapeBody,
      warned,
      closes: () => closes,
      saves: () => saves,
      leave: async () => {
        await act(async () => {
          dom.window.dispatchEvent(new dom.window.Event("pagehide"));
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      },
      close: restore,
    };
  } catch (error) {
    await restore();
    throw error;
  }
}

test("clean notes close immediately; changed title/body ask, keep focus and retain content; undo/reversion removes the leave warning", async () => {
  const clean = await fixture();
  try {
    assert.equal(clean.warned(), false);
    await clean.click("Close dialog");
    assert.equal(clean.closes(), 1);
  } finally {
    await clean.close();
  }
  const ui = await fixture();
  try {
    await ui.title("Unsaved title");
    assert.equal(ui.warned(), true);
    await ui.click("Close dialog");
    assert.equal(ui.closes(), 0);
    assert.match(ui.container.textContent!, /unsaved changes/);
    assert.equal(
      ui.container.ownerDocument.activeElement?.textContent,
      "Keep editing",
    );
    await ui.click("Keep editing");
    assert.equal(ui.container.querySelector("input")!.value, "Unsaved title");
    assert.equal(
      ui.container.ownerDocument.activeElement?.getAttribute("aria-label"),
      "Close dialog",
    );
    await ui.title("Original title");
    assert.equal(ui.warned(), false);
    await act(async () => {
      ui.editor.commands.setTextSelection({
        from: 1,
        to: ui.editor.state.doc.content.size - 1,
      });
      ui.editor.commands.toggleBold();
    });
    assert.equal(ui.warned(), true);
    await ui.escapeBody();
    assert.equal(ui.closes(), 0);
    await ui.cancel();
    assert.equal(
      ui.container.querySelector('[aria-label="Unsaved note"]'),
      null,
    );
    await ui.click("Undo");
    assert.equal(ui.warned(), false);
    await ui.cancel();
    assert.equal(ui.closes(), 1);
  } finally {
    await ui.close();
  }
});

function draftApi(
  store: Store,
  offline: () => boolean = () => false,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input), "http://127.0.0.1:4317"),
      p = url.pathname.split("/");
    assert.equal(p[4], "drafts");
    const n = p[3],
      id = p[5],
      b = init?.body ? JSON.parse(String(init.body)) : null;
    if (offline() && init?.method === "PUT")
      throw Error("Connection unavailable");
    try {
      let result;
      if (init?.method === "PUT") result = store.drafts.save(n, id, b);
      else if (init?.method === "DELETE") {
        store.drafts.discard(n, { id, version: b.version });
        result = { discarded: true };
      } else
        result = id
          ? store.drafts.read(n, id)
          : store.drafts.list(n, url.searchParams.get("artifactId"));
      return new Response(JSON.stringify(result), { status: 200 });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), {
        status: 400,
      });
    }
  };
}

test("automatic drafts recover rich content after editor restart, then explicit Save publishes and clears recovery", async () => {
  const root = mkdtempSync(os.tmpdir() + "/codeboom-draft-ui-");
  const store = new Store(root),
    n = store.createNotebook("Personal").id;
  let ui: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const options = { recovery: true, notebookId: n, fetch: draftApi(store) };
    ui = await fixture(options);
    await ui.title("Recovered title");
    await act(async () => {
      ui!.editor.commands.setContent(richNote(richFixture()).doc);
    });
    const expected = richNote({
      format: "rich-note",
      version: 1,
      doc: ui.editor.getJSON(),
    });
    await ui.leave();
    assert.equal(store.view(n).artifacts.length, 0);
    assert.equal(store.view(n).drafts.length, 1);
    await ui.close();
    ui = undefined;
    ui = await fixture({
      ...options,
      save: async (title, doc, context) => {
        store.drafts.publish(n, context!.draft, null, null, () =>
          store.createRichArtifact(n, title, doc),
        );
      },
    });
    assert.match(ui.container.textContent!, /Unsaved drafts are available/);
    await ui.click("Recover draft");
    assert.equal(ui.container.querySelector("input")!.value, "Recovered title");
    assert.equal(
      ui.container.ownerDocument.activeElement?.getAttribute("aria-label"),
      "Note body",
    );
    assert.deepEqual(
      richNote({ format: "rich-note", version: 1, doc: ui.editor.getJSON() }),
      expected,
    );
    assert.equal(ui.warned(), true);
    await ui.click("Save note");
    assert.equal(store.view(n).artifacts.length, 1);
    assert.equal(store.view(n).drafts.length, 0);
    assert.deepEqual(store.view(n).artifacts[0].content, expected);
  } finally {
    await ui?.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("automatic draft failure is visible and retryable; explicit Discard clears the stored draft", async () => {
  const root = mkdtempSync(os.tmpdir() + "/codeboom-draft-failure-ui-");
  const store = new Store(root),
    n = store.createNotebook("Personal").id;
  let offline = true;
  const ui = await fixture({
    recovery: true,
    notebookId: n,
    fetch: draftApi(store, () => offline),
  });
  try {
    await ui.title("Do not lose this");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    assert.match(
      ui.container.textContent!,
      /Draft recovery could not be updated/,
    );
    assert.equal(
      ui.container.querySelector("input")!.value,
      "Do not lose this",
    );
    assert.equal(store.view(n).drafts.length, 0);
    offline = false;
    await ui.click("Retry draft saving");
    assert.equal(store.view(n).drafts.length, 1);
    await ui.click("Close dialog");
    await ui.click("Keep editing");
    assert.equal(store.view(n).drafts.length, 1);
    await ui.click("Close dialog");
    await ui.click("Discard draft");
    assert.equal(store.view(n).drafts.length, 0);
    assert.equal(store.view(n).artifacts.length, 0);
    assert.match(ui.container.textContent!, /Editor closed/);
  } finally {
    await ui.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("recovered drafts retain their original base and survive failed or stale Save", async () => {
  const root = mkdtempSync(os.tmpdir() + "/codeboom-draft-stale-ui-");
  const store = new Store(root),
    n = store.createNotebook("Personal").id;
  const note = store.createRichArtifact(
    n,
    "Original title",
    editableNote({ text: "Original" }),
  );
  const base = store.view(n).artifacts[0].revision_id;
  store.drafts.save(n, "recover-me", {
    artifactId: note,
    baseRevisionId: base,
    title: "My draft",
    document: editableNote({ text: "My unfinished changes" }),
    version: 1,
  });
  store.editRichArtifact(
    n,
    note,
    "Original title",
    editableNote({ text: "Newer saved version" }),
    base,
  );
  const current = store.view(n).artifacts[0];
  let saves = 0;
  const ui = await fixture({
    recovery: true,
    notebookId: n,
    artifactId: note,
    baseRevisionId: current.revision_id,
    initial: current.content,
    fetch: draftApi(store),
    save: async (title, doc, context) => {
      if (++saves === 1) throw Error("Temporary publication failure");
      store.drafts.publish(
        n,
        context!.draft,
        note,
        context!.baseRevisionId,
        () =>
          store.editRichArtifact(n, note, title, doc, context!.baseRevisionId!),
      );
    },
  });
  try {
    await ui.click("Recover draft");
    assert.match(ui.container.textContent!, /older saved revision/);
    assert.equal(ui.editor.getText(), "My unfinished changes");
    await ui.click("Save note");
    assert.match(ui.container.textContent!, /Temporary publication failure/);
    assert.equal(store.view(n).drafts.length, 1);
    await ui.click("Save note");
    assert.match(ui.container.textContent!, /Note changed/);
    assert.equal(ui.editor.getText(), "My unfinished changes");
    assert.equal(store.view(n).artifacts[0].revision_id, current.revision_id);
    assert.equal(store.drafts.read(n, "recover-me").baseRevisionId, base);
  } finally {
    await ui.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending Save refuses Close/Escape, failed Save retains the draft, and successful explicit Save clears the warning", async () => {
  let finish!: () => void,
    fail!: (error: Error) => void,
    attempt = 0;
  const ui = await fixture({
    save: () => {
      attempt++;
      return attempt === 1
        ? new Promise<void>((resolve, reject) => {
            finish = resolve;
            fail = reject;
          })
        : Promise.resolve();
    },
  });
  try {
    await ui.title("My unsaved note");
    await ui.click("Save note");
    assert.equal(ui.saves(), 1);
    assert.equal(
      ui.container.querySelector<HTMLButtonElement>(
        '[aria-label="Close dialog"]',
      )!.disabled,
      true,
    );
    await ui.cancel();
    assert.equal(ui.closes(), 0);
    assert.equal(ui.warned(), true);
    await act(async () => fail(Error("Temporary save failure.")));
    assert.match(ui.container.textContent!, /Temporary save failure/);
    assert.equal(ui.container.querySelector("input")!.value, "My unsaved note");
    assert.equal(ui.editor.getText(), "Original note 🦉");
    await ui.click("Close dialog");
    assert.equal(ui.closes(), 0);
    await ui.click("Keep editing");
    await ui.click("Save note");
    assert.equal(ui.saves(), 2);
    assert.equal(ui.warned(), false);
    assert.match(ui.container.textContent!, /Editor closed/);
  } finally {
    await ui.close();
  }
});

test("undoing a DOM text edit restores a multiline note's clean baseline without leaving a discard warning", async () => {
  const ui = await fixture({ text: "Ideas to review:\nKeep this note." });
  try {
    const original = ui.editor.getJSON();
    await act(async () => {
      const text = ui.editor.view.dom.querySelector("p")!.firstChild as Text;
      text.insertData(0, "Unsaved idea. ");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(ui.warned(), true);
    await ui.click("Undo");
    assert.deepEqual(ui.editor.getJSON(), original);
    assert.equal(ui.warned(), false);
    await ui.escapeBody();
    assert.equal(ui.closes(), 1);
  } finally {
    await ui.close();
  }
});

test("note editing has no voice capture and an unchanged draft closes immediately", async () => {
  const ui = await fixture();
  try {
    assert.equal(
      ui.container.querySelector('[aria-label="Voice input"]'),
      null,
    );
    assert.equal(
      ui.container.textContent!.includes("Record voice input"),
      false,
    );
    assert.equal(ui.environment.contexts.length, 0);
    assert.equal(ui.warned(), false);
    await ui.click("Close dialog");
    assert.equal(ui.closes(), 1);
    assert.equal(ui.saves(), 0);
  } finally {
    await ui.close();
  }
});
