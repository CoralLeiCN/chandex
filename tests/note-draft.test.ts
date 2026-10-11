import test from "node:test";
import assert from "node:assert/strict";
import React, { act, useState } from "react";
import { JSDOM } from "jsdom";
import type { Editor } from "@tiptap/core";
import type { RichNote } from "../src/domain/notes.ts";
import { voiceEnvironment } from "./fixtures/voice-capture.ts";

async function fixture(
  options: {
    save?: (title: string, document: RichNote) => Promise<void>;
    module?: () => Promise<void>;
    text?: string;
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
    fetch: async () => {
      throw Error("No request should be made in these draft checks.");
    },
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
            children: (onDraftState) =>
              React.createElement(RichNoteEditor, {
                initial: { text: options.text ?? "Original note 🦉" },
                initialTitle: "Original title",
                sources: [],
                notebookId: "notebook",
                onDraftState,
                onSave: async (title, document) => {
                  saves++;
                  await options.save?.(title, document);
                  setOpen(false);
                },
              }),
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
    const editor = (
      container.querySelector('[aria-label="Note body"]') as HTMLElement & {
        editor: Editor;
      }
    ).editor;
    const escapeBody = async () => {
      await act(async () => {
        editor.view.dom.dispatchEvent(
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
      editor,
      click,
      title,
      cancel,
      escapeBody,
      warned,
      closes: () => closes,
      saves: () => saves,
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
