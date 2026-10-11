import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { WebResearchDialog } from "../src/web/web-research.tsx";
test("web dialog imports only an explicit selection and suppresses cancelled or unmounted search responses", async () => {
  const dom = new JSDOM('<div id="app"></div>', { pretendToBeVisual: true });
  dom.window.HTMLDialogElement.prototype.showModal = function () {};
  const values = {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const original = new Map(
    Object.keys(values).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const fetchOriginal = globalThis.fetch;
  const calls: { path: string; options: RequestInit }[] = [],
    searches: ((value: Response) => void)[] = [];
  globalThis.fetch = (async (path: string, options: RequestInit) => {
    calls.push({ path, options });
    if (path.endsWith("web-research") && options.method === "POST")
      return new Promise<Response>((resolve) => searches.push(resolve));
    return new Response(JSON.stringify({ status: "processing" }), {
      status: 202,
    });
  }) as typeof fetch;
  const { createRoot } = await import("react-dom/client"),
    container = dom.window.document.getElementById("app")!,
    root = createRoot(container);
  let imported = 0;
  const respond = (index: number, title: string) =>
    searches[index](
      new Response(
        JSON.stringify({
          candidates: [{ title, url: "https://www.w3.org/TR/png-3/" }],
          searchedAt: "2026-10-10T00:00:00Z",
        }),
      ),
    );
  const submit = async () => {
    const input = container.querySelector("input")!;
    // React's controlled value tracker requires the native setter.
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "PNG metadata");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      container
        .querySelector("form")!
        .dispatchEvent(
          new dom.window.Event("submit", { bubbles: true, cancelable: true }),
        );
    });
  };
  try {
    await act(async () =>
      root.render(
        React.createElement(WebResearchDialog, {
          notebookId: "a",
          onClose: () => {},
          onImported: async () => {
            imported++;
          },
        }),
      ),
    );
    await submit();
    assert.equal(calls.filter((c) => c.path.endsWith("/import")).length, 0);
    await act(async () => respond(0, "First candidate"));
    assert.match(container.textContent!, /First candidate/);
    assert.equal(calls.filter((c) => c.path.endsWith("/import")).length, 0);
    const button = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Import snapshot",
    )!;
    await act(async () => button.click());
    assert.equal(imported, 1);
    const input = JSON.parse(
      calls.find((c) => c.path.endsWith("/import"))!.options.body as string,
    );
    assert.equal(input.url, "https://www.w3.org/TR/png-3/");
    assert.equal(input.kind, "url");
    await submit();
    const cancel = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Cancel search",
    )!;
    await act(async () => cancel.click());
    await act(async () => respond(1, "Cancelled candidate"));
    assert.doesNotMatch(container.textContent!, /Cancelled candidate/);
    assert.equal(calls.filter((c) => c.options.method === "DELETE").length, 1);
    assert.equal(
      (
        calls.filter(
          (c) => c.options.method === "POST" && c.path.endsWith("web-research"),
        )[1].options.signal as AbortSignal
      ).aborted,
      true,
    );
    await submit();
    await act(async () => root.unmount());
    respond(2, "Unmounted candidate");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.filter((c) => c.options.method === "DELETE").length, 2);
    assert.equal(imported, 1);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = fetchOriginal;
    dom.window.close();
    for (const [key, descriptor] of original)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
