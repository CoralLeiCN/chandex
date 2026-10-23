import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { useNotebookPage } from "../src/web/use-notebook-page.ts";

async function fixture() {
  const dom = new JSDOM('<div id="app"></div>');
  const requests: {
    url: string;
    resolve: (value: Response) => void;
    reject: (error: Error) => void;
  }[] = [];
  const errors: string[] = [];
  const globals = {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (url: unknown) =>
      new Promise<Response>((resolve, reject) =>
        requests.push({ url: String(url), resolve, reject }),
      ),
  };
  const originals = new Map(
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
  let state!: ReturnType<typeof useNotebookPage>;
  const onError = (message: string) => {
    errors.push(message);
  };
  function Notebook({ id }: { id: string }) {
    state = useNotebookPage(id, onError);
    return React.createElement(
      "p",
      {},
      `${state.page?.id ?? "loading"}:${state.convId}`,
    );
  }
  return {
    requests,
    errors,
    get state() {
      return state;
    },
    render: async (id: string) => {
      await act(async () => root.render(React.createElement(Notebook, { id })));
    },
    respond: async (
      index: number,
      id: string,
      conversations = [id + "-chat"],
    ) => {
      await act(async () =>
        requests[index].resolve(
          new Response(
            JSON.stringify({
              id,
              conversations: conversations.map((id) => ({ id })),
            }),
          ),
        ),
      );
    },
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("switching notebooks ignores late pages, conversation IDs and errors, including returning to the same notebook", async () => {
  const f = await fixture();
  try {
    await f.render("A");
    await f.render("B");
    await f.respond(1, "B");
    await f.respond(0, "A");
    assert.equal(f.state.page.id, "B");
    assert.equal(f.state.convId, "B-chat");
    await f.render("A");
    assert.equal(f.state.page === null, true);
    await f.render("B");
    await f.render("A");
    await f.respond(4, "A", ["latest-A-chat"]);
    await f.respond(2, "A", ["stale-A-chat"]);
    await act(async () => f.requests[3].reject(Error("Old notebook failed")));
    assert.equal(f.state.page.id, "A");
    assert.equal(f.state.convId, "latest-A-chat");
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test("overlapping refreshes keep the latest page and preserve a valid selected conversation", async () => {
  const f = await fixture();
  try {
    await f.render("A");
    await f.respond(0, "A", ["first", "chosen"]);
    await act(async () => f.state.setConvId("chosen"));
    const old = f.state.refresh();
    const latest = f.state.refresh();
    await f.respond(2, "A", ["chosen", "new"]);
    await latest;
    await f.respond(1, "A", ["first"]);
    await old;
    assert.deepEqual(
      f.state.page.conversations.map((c: any) => c.id),
      ["chosen", "new"],
    );
    assert.equal(f.state.convId, "chosen");
    const removed = f.state.refresh();
    await f.respond(3, "A", ["replacement"]);
    await removed;
    assert.equal(f.state.convId, "replacement");
    const other = f.state.refresh("B");
    await f.respond(4, "B");
    await other;
    assert.equal(f.state.page.id, "A");
    assert.equal(f.state.convId, "replacement");
  } finally {
    await f.close();
  }
});
