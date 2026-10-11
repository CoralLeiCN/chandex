import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { SlideMaterial } from "../src/web/slides.tsx";
import { chunkText, type Citation } from "../src/domain/evidence.ts";
import { slideAnswer, slideSourceText } from "./fixtures/slides.ts";

test("slide viewer supports bounded keyboard navigation, full notes/outline and exact citation callbacks", async () => {
  const dom = new JSDOM('<div id="app"></div>', { pretendToBeVisual: true });
  const values = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
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
  const container = dom.window.document.getElementById("app")!,
    root = createRoot(container);
  try {
    const answer = slideAnswer(
        chunkText(slideSourceText, "s", "r", "Proposal")[0],
      ),
      opened: Citation[] = [];
    await act(async () =>
      root.render(
        React.createElement(SlideMaterial, {
          content: answer,
          openPassage: (citation: Citation) => opened.push(citation),
        }),
      ),
    );
    const status = () =>
      container.querySelector('[role="status"]')!.textContent;
    const viewer = container.querySelector('[aria-label="Slide viewer"]')!;
    const key = async (target: Element, key: string) =>
      act(async () => {
        target.dispatchEvent(
          new dom.window.KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    assert.equal(status(), "Slide 1 of 2");
    assert.ok(
      (container.querySelector("button") as HTMLButtonElement).disabled,
    );
    await key(viewer, "ArrowLeft");
    assert.equal(status(), "Slide 1 of 2");
    const reference = viewer.querySelector("button")!;
    await key(reference, "ArrowRight");
    assert.equal(
      status(),
      "Slide 1 of 2",
      "nested citation controls do not turn slides",
    );
    await act(async () => reference.click());
    assert.deepEqual(opened, [answer.blocks[0].citations[0]]);
    assert.match(
      viewer.querySelector(".deck-notes")!.textContent!,
      /Treat approval as a prerequisite/,
    );
    await key(viewer, "ArrowRight");
    assert.equal(status(), "Slide 2 of 2");
    await key(viewer, "ArrowRight");
    assert.equal(status(), "Slide 2 of 2");
    assert.match(viewer.textContent!, /No launch commitment/);
    assert.equal(
      container.querySelectorAll(".deck-outline .deck-slide").length,
      2,
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((b) => b.textContent === "Previous slide")!
        .click(),
    );
    assert.equal(status(), "Slide 1 of 2");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, descriptor] of original)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
  }
});
