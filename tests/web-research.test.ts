import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { codexArgs } from "../src/codex/config.ts";
import { WebResearchClient } from "../src/codex/web-research.ts";
import { WebResearchService } from "../src/server/web-research-service.ts";
import {
  candidateURL,
  validateCandidates,
  webQuery,
} from "../src/domain/web-research.ts";
import type { Rpc } from "../src/codex/rpc.ts";
const candidate = {
  title: "PNG specification",
  url: "https://www.w3.org/TR/png-3/",
};
const result = {
  candidates: [candidate],
  searchedAt: "2026-10-10T00:00:00Z",
  model: "fixture",
  searches: 1,
};
test("discovery rejects unsafe URLs, duplicate pages and invalid response shapes; ordinary runtime remains search-disabled", () => {
  assert.ok(codexArgs().includes('web_search="disabled"'));
  assert.ok(codexArgs("live").includes('web_search="live"'));
  assert.throws(() => codexArgs("anything" as any), /Unsupported/);
  for (const value of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://[::1]/",
    "http://10.1.2.3/",
    "https://localhost/",
    "https://a.localhost./",
    "http://thing.home.arpa/",
    "https://www.w3.org:40732/",
    "https://user:password@w3.org/",
  ])
    assert.throws(() => candidateURL(value));
  assert.equal(candidateURL(candidate.url + "#metadata"), candidate.url);
  assert.throws(() => webQuery("line\nbreak"));
  assert.throws(() => webQuery("a".repeat(1001)));
  for (const value of [
    { candidates: [candidate], answer: "claim" },
    { candidates: [candidate, candidate] },
    { candidates: Array(6).fill(candidate) },
    { candidates: [{ ...candidate, snippet: "evidence" }] },
  ])
    assert.throws(() => validateCandidates(value));
  assert.deepEqual(validateCandidates({ candidates: [] }), []);
});
class ScriptedRpc extends EventEmitter {
  searchCount = 1;
  output = JSON.stringify({ candidates: [candidate] });
  sent: any[] = [];
  requests: any[] = [];
  closed = false;
  settled = Promise.resolve();
  constructor(
    readonly search = true,
    readonly isolation = true,
  ) {
    super();
  }
  async request(method: string, params: any): Promise<any> {
    this.requests.push({ method, params });
    if (method === "thread/start")
      return {
        thread: { id: "thread" },
        instructionSources: [],
        activePermissionProfile: { id: "codeboom" },
        sandbox: { type: "readOnly", networkAccess: !this.isolation },
      };
    if (method === "turn/start") {
      setImmediate(() => {
        const emit = (method: string, params: any) =>
          this.emit("message", {
            method,
            params: { threadId: "thread", turnId: "turn", ...params },
          });
        emit("turn/started", { turn: { id: "turn" } });
        this.emit("message", {
          id: 7,
          method: "item/tool/call",
          params: { threadId: "thread", tool: "read_file", arguments: {} },
        });
        emit("item/completed", {
          threadId: "foreign",
          item: {
            id: "foreign",
            type: "webSearch",
            action: { type: "search" },
          },
        });
        if (this.search)
          for (let i = 0; i < this.searchCount; i++)
            emit("item/completed", {
              item: {
                id: "search-" + i,
                type: "webSearch",
                action: { type: "search" },
              },
            });
        emit("item/completed", {
          item: {
            type: "agentMessage",
            text: this.output,
          },
        });
        emit("turn/completed", { turn: { id: "turn", status: "completed" } });
      });
      return { turn: { id: "turn" } };
    }
    return {};
  }
  send(value: any) {
    this.sent.push(value);
  }
  close() {
    this.closed = true;
    this.emit("closed", Error("Closed"));
  }
}
function client(rpc: ScriptedRpc) {
  return new WebResearchClient({
    workspace: "/empty",
    connect: async (_signal, mode) => {
      assert.equal(mode, "live");
      return {
        rpc: rpc as unknown as Rpc,
        models: [{ model: "fixture", id: "fixture", isDefault: true }],
        authenticated: true,
      };
    },
  });
}
test("discovery sends query-only input, rejects capability requests and requires observed search in its own thread", async () => {
  const rpc = new ScriptedRpc(),
    found = await client(rpc).discover({ query: "PNG metadata" });
  assert.deepEqual(found.candidates, [candidate]);
  assert.equal(found.searches, 1);
  const thread = rpc.requests[0].params,
    turn = rpc.requests[1].params;
  assert.deepEqual(thread.dynamicTools, []);
  assert.equal(thread.developerInstructions, "");
  assert.equal(thread.ephemeral, true);
  assert.deepEqual(JSON.parse(turn.input[0].text), { query: "PNG metadata" });
  assert.deepEqual(turn.environments, []);
  assert.equal(turn.permissions, "codeboom");
  assert.equal(rpc.sent[0].error.code, -32601);
  assert.equal(rpc.closed, true);
  await assert.rejects(
    client(new ScriptedRpc(false)).discover({ query: "PNG" }),
    /did not perform/,
  );
  const unsafe = new ScriptedRpc(true, false);
  await assert.rejects(client(unsafe).discover({ query: "PNG" }), /isolation/);
  assert.equal(unsafe.requests.length, 1);
});
test("excessive search activity and malformed/private candidate outputs fail closed", async () => {
  const excessive = new ScriptedRpc();
  excessive.searchCount = 9;
  await assert.rejects(
    client(excessive).discover({ query: "PNG" }),
    /eight-search limit/,
  );
  assert.equal(excessive.closed, true);
  for (const output of [
    "not JSON",
    JSON.stringify({
      candidates: [{ title: "Private", url: "http://127.0.0.1/" }],
    }),
  ]) {
    const rpc = new ScriptedRpc();
    rpc.output = output;
    await assert.rejects(
      client(rpc).discover({ query: "PNG" }),
      /invalid candidate pages/,
    );
    assert.equal(rpc.closed, true);
  }
});
test("cancelled discovery withholds output and waits for the actual transport to settle", async () => {
  const rpc = new ScriptedRpc();
  let exit!: () => void;
  rpc.settled = new Promise((resolve) => {
    exit = resolve;
  });
  const controller = new AbortController(),
    pending = client(rpc).discover({ query: "PNG", signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  let done = false;
  void pending.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  assert.equal(rpc.closed, true);
  exit();
  await assert.rejects(pending, /cancelled/);
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test("service retains bounded capacity after cancellation, suppresses deleted notebooks and awaits shutdown", async () => {
  const notebooks = new Set(["a", "b"]),
    calls: any[] = [],
    gates: ReturnType<typeof deferred<typeof result>>[] = [];
  const service = new WebResearchService(
    {
      notebook: (n: string) => {
        if (!notebooks.has(n)) throw Error("Notebook unavailable");
        return {};
      },
    } as any,
    {
      discover: (options) => {
        calls.push(options);
        const gate = deferred<typeof result>();
        gates.push(gate);
        return gate.promise;
      },
    },
  );
  const firstKey = randomUUID(),
    secondKey = randomUUID();
  const first = service.search("a", { key: firstKey, query: "first" }),
    second = service.search("b", { key: secondKey, query: "second" });
  const firstRejected = assert.rejects(first, /cancelled/),
    secondRejected = assert.rejects(second, /cancelled/);
  await new Promise((resolve) => setImmediate(resolve));
  service.cancel("b", firstKey);
  assert.equal(calls[0].signal.aborted, false);
  service.cancel("a", firstKey);
  assert.equal(calls[0].signal.aborted, true);
  assert.throws(
    () => service.search("a", { key: randomUUID(), query: "third" }),
    /busy/,
  );
  notebooks.delete("b");
  service.cancelNotebook("b");
  let stopped = false;
  const stopping = service.shutdown().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  gates[0].resolve(result);
  gates[1].resolve(result);
  await Promise.all([firstRejected, secondRejected, stopping]);
  assert.equal(stopped, true);
  assert.throws(
    () => service.search("a", { key: randomUUID(), query: "late" }),
    /shutting down/,
  );
});
test("cancel-before-start race and notebook disappearance fail closed without retaining search results", async () => {
  const gate = deferred<typeof result>();
  let exists = true,
    calls = 0;
  const service = new WebResearchService(
    {
      notebook: () => {
        if (!exists) throw Error("Deleted");
        return {};
      },
    } as any,
    {
      discover: () => {
        calls++;
        return gate.promise;
      },
    },
  );
  const key = randomUUID();
  service.cancel("a", key);
  assert.throws(
    () => service.search("a", { key, query: "cancelled" }),
    /cancelled/,
  );
  assert.equal(calls, 0);
  const pending = service.search("a", { key: randomUUID(), query: "search" });
  await new Promise((resolve) => setImmediate(resolve));
  exists = false;
  gate.resolve(result);
  await assert.rejects(pending, /Deleted/);
  await service.shutdown();
});
