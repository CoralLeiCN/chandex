import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { InfographicMaterial } from "../src/web/infographic.tsx";
import { chunkText, type Citation } from "../src/domain/evidence.ts";
import {
  infographicAnswer,
  infographicSourceText,
} from "./fixtures/infographic.ts";
test("infographic viewer exposes every claim, inference and exact citation in readable native controls", async () => {
  const dom = new JSDOM('<div id="app"></div>', { pretendToBeVisual: true }),
    values = {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      IS_REACT_ACT_ENVIRONMENT: true,
    },
    original = new Map(
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
  const { createRoot } = await import("react-dom/client"),
    container = dom.window.document.getElementById("app")!,
    root = createRoot(container);
  try {
    const answer = infographicAnswer(
        chunkText(infographicSourceText, "s", "r", "Proposal")[0],
      ),
      opened: Citation[] = [];
    await act(async () =>
      root.render(
        React.createElement(InfographicMaterial, {
          content: answer,
          openPassage: (c: Citation) => opened.push(c),
        }),
      ),
    );
    assert.equal(container.querySelectorAll(".infographic-card").length, 2);
    assert.match(container.textContent!, /€240/);
    assert.match(container.textContent!, /Inference:/);
    assert.match(container.textContent!, /date is not confirmed/);
    assert.equal(container.querySelector(".infographic-order"), null);
    const button = container.querySelector("button")!;
    button.focus();
    assert.equal(dom.window.document.activeElement, button);
    await act(async () => button.click());
    assert.deepEqual(opened, [answer.blocks[0].citations[0]]);
    answer.infographic!.layout = "steps";
    answer.infographic!.orderBlockIndex = answer.blocks.length;
    answer.blocks.push({
      ...answer.blocks[0],
      text: "First record, then ask; schedule only after approval.",
    });
    await act(async () =>
      root.render(
        React.createElement(InfographicMaterial, {
          content: answer,
          openPassage: (c: Citation) => opened.push(c),
        }),
      ),
    );
    assert.match(
      container.querySelector(".infographic-order")!.textContent!,
      /First record/,
    );
    assert.equal(container.querySelectorAll('[aria-label^="Step "]').length, 2);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [name, value] of original)
      if (value) Object.defineProperty(globalThis, name, value);
      else Reflect.deleteProperty(globalThis, name);
  }
});
