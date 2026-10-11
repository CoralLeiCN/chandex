import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexClient } from "../src/codex/client.ts";
import { studyAnswer } from "./fixtures/study.ts";
import { structuredAnswer } from "./fixtures/structured.ts";
import { chunkText } from "../src/domain/evidence.ts";
import { GenerationError, unverifiedDraft } from "../src/codex/errors.ts";
import type { Rpc } from "../src/codex/rpc.ts";
const passages = chunkText("A source recommends SQLite.", "s", "r", "Source");

class ScriptedRpc extends EventEmitter {
  turns = 0;
  responses: unknown[] = [];
  schemas: any[] = [];
  usageEvents: any[][] = [];
  capacityBeforeTools = true;
  capacityAfterTools = false;
  retryToolAfterCapacity = false;
  contextWindow: number | null = 100000;
  constructor(
    readonly outputs: string[],
    readonly providerError?: string,
    readonly failOnTurn = 1,
  ) {
    super();
  }
  async request(method: string, params: any): Promise<any> {
    if (method === "thread/start") {
      assert.equal(params.permissions, "codeboom");
      assert.equal(params.approvalPolicy, "never");
      assert.equal(params.ephemeral, true);
      assert.equal(params.dynamicTools.length, 4);
      return {
        thread: { id: "thread" },
        instructionSources: [],
        activePermissionProfile: { id: "codeboom" },
        sandbox: { type: "readOnly", networkAccess: false },
      };
    }
    if (method === "turn/start") {
      this.schemas.push(params.outputSchema);
      const id = "turn-" + ++this.turns;
      const output = this.outputs.shift() ?? "";
      const providerError =
        this.turns === this.failOnTurn ? this.providerError : undefined;
      setImmediate(() => {
        const capacity = () =>
          this.emit("message", {
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "thread",
              turnId: id,
              tokenUsage: {
                // Test partial telemetry: capacity can be validated independently
                // while missing cumulative usage remains unknown.
                total: null,
                last: {
                  totalTokens: 0,
                  inputTokens: 0,
                  cachedInputTokens: 0,
                  cacheWriteInputTokens: 0,
                  outputTokens: 0,
                  reasoningOutputTokens: 0,
                },
                modelContextWindow: this.contextWindow,
              },
            },
          });
        if (this.capacityBeforeTools) capacity();
        this.emit("message", {
          method: "item/tool/call",
          id: this.turns,
          params: {
            threadId: "thread",
            turnId: id,
            tool: "notebook_read_passage",
            arguments: { passageId: passages[0].id },
          },
        });
        for (const params of this.usageEvents[this.turns - 1] ?? [])
          this.emit("message", {
            method: "thread/tokenUsage/updated",
            params: { threadId: "thread", turnId: id, ...params },
          });
        if (this.capacityAfterTools) capacity();
        if (this.retryToolAfterCapacity)
          this.emit("message", {
            method: "item/tool/call",
            id: id + "-retry",
            params: {
              threadId: "thread",
              turnId: id,
              tool: "notebook_read_passage",
              arguments: { passageId: passages[0].id },
            },
          });
        this.emit("message", {
          method: "item/completed",
          params: {
            threadId: "thread",
            item: { type: "agentMessage", text: output },
          },
        });
        this.emit("message", {
          method: "turn/completed",
          params: {
            threadId: "thread",
            turn: {
              id,
              status: providerError ? "failed" : "completed",
              error: providerError
                ? {
                    message: "Synthetic provider error",
                    codexErrorInfo: providerError,
                  }
                : null,
            },
          },
        });
      });
      return { turn: { id } };
    }
    return {};
  }
  send(response: unknown) {
    this.responses.push(response);
  }
  close() {
    this.emit("closed", new Error("Codex closed."));
  }
}
class ScriptedClient extends CodexClient {
  constructor(
    root: string,
    readonly transport: ScriptedRpc,
  ) {
    super(root);
  }
  override async connect() {
    return {
      rpc: this.transport as unknown as Rpc,
      models: [{ id: "fixture", model: "fixture", isDefault: true }],
      authenticated: true,
    };
  }
}
function invalid(text: string) {
  return JSON.stringify({
    status: "answered",
    title: "Draft",
    blocks: [
      {
        kind: "fact",
        text,
        citations: [
          { passageId: passages[0].id, start: 0, end: 3, quote: "forged" },
        ],
      },
    ],
    coverageWarnings: [],
  });
}

test("adapter makes only one repair and exposes the last rejected output as unverified plain text", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-client-fault-"));
  const rpc = new ScriptedRpc([
    invalid("First unverified claim"),
    invalid("Last unverified claim"),
  ]);
  try {
    const client = new ScriptedClient(root, rpc);
    await assert.rejects(
      client.run({ passages, question: "Database?" }),
      (error: unknown) => {
        assert.ok(error instanceof GenerationError);
        assert.equal(error.category, "invalid_output");
        assert.equal(error.draft?.text, "Draft\n\nLast unverified claim");
        assert.equal(error.draft?.truncated, false);
        return true;
      },
    );
    assert.equal(rpc.turns, 2);
    assert.equal(rpc.responses.filter((r: any) => r.result?.success).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("reported token usage is scoped, cumulative across repair, sanitized and retained on failure", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-usage-"));
  const usage = (n: number) => ({
    totalTokens: n * 10,
    inputTokens: n * 7,
    cachedInputTokens: n * 2,
    cacheWriteInputTokens: n,
    outputTokens: n * 3,
    reasoningOutputTokens: n,
  });
  const valid = JSON.parse(invalid("SQLite is proposed."));
  valid.blocks[0].citations = [
    {
      passageId: passages[0].id,
      quote: passages[0].text,
      start: 0,
      end: Array.from(passages[0].text).length,
    },
  ];
  const rpc = new ScriptedRpc([invalid("First draft"), JSON.stringify(valid)]);
  rpc.usageEvents = [
    [{ tokenUsage: { total: usage(10) } }],
    [
      {
        tokenUsage: {
          total: { ...usage(20), sourceText: "SOURCE_SECRET_CANARY" },
        },
      },
      { tokenUsage: { total: usage(20) } },
      { threadId: "foreign", tokenUsage: { total: usage(50) } },
      { turnId: "unknown-turn", tokenUsage: { total: usage(50) } },
      { tokenUsage: { total: { ...usage(30), outputTokens: -1 } } },
      { tokenUsage: { total: usage(10) } },
    ],
  ];
  const reports: any[] = [];
  try {
    await new ScriptedClient(root, rpc).run({
      passages,
      question: "Database?",
      onStats: (stats) => reports.push(stats),
    });
    assert.equal(rpc.turns, 2);
    assert.deepEqual(reports.at(-1).usage, usage(20));
    assert.equal(reports.at(-1).toolCalls, 2);
    assert.doesNotMatch(JSON.stringify(reports), /SOURCE_SECRET_CANARY/);
    const failed = new ScriptedRpc([""], "rateLimitExceeded");
    failed.usageEvents = [[{ tokenUsage: { total: usage(5) } }]];
    let final: any;
    await assert.rejects(
      new ScriptedClient(root, failed).run({
        passages,
        question: "Database?",
        onStats: (stats) => {
          final = stats;
        },
      }),
    );
    assert.deepEqual(final.usage, usage(5));
    const missing = new ScriptedRpc([JSON.stringify(valid)]);
    await new ScriptedClient(root, missing).run({
      passages,
      question: "Database?",
      onStats: (stats) => {
        final = stats;
      },
    });
    assert.equal(final.usage, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("context metadata arrives after a rejected read without deadlock; retries read evidence and missing capacity fails explicitly", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-context-client-"));
  const valid = JSON.parse(invalid("SQLite is proposed."));
  valid.blocks[0].citations = [
    {
      passageId: passages[0].id,
      quote: passages[0].text,
      start: 0,
      end: Array.from(passages[0].text).length,
    },
  ];
  try {
    const rpc = new ScriptedRpc([JSON.stringify(valid)]);
    rpc.capacityBeforeTools = false;
    rpc.capacityAfterTools = true;
    rpc.retryToolAfterCapacity = true;
    let final: any;
    const output = await new ScriptedClient(root, rpc).run({
      passages,
      question: "Database?",
      onStats: (stats) => {
        final = stats;
      },
    });
    assert.equal(output.status, "answered");
    assert.equal((rpc.responses[0] as any).result.success, false);
    assert.doesNotMatch(
      JSON.stringify(rpc.responses[0]),
      /A source recommends SQLite/,
    );
    assert.equal((rpc.responses[1] as any).result.success, true);
    assert.equal(final.context.capacityRefusals, 1);
    assert.equal(final.context.modelContextWindow, 100000);
    assert.equal(final.toolCalls, 2);
    assert.equal(output.coverage?.[0].readPassages, 1);

    const missing = new ScriptedRpc([JSON.stringify(valid)]);
    missing.capacityBeforeTools = false;
    await assert.rejects(
      new ScriptedClient(root, missing).run({
        passages,
        question: "Database?",
        onStats: (stats) => {
          final = stats;
        },
      }),
      (error) =>
        error instanceof GenerationError &&
        error.category === "runtime" &&
        /did not report usable model context capacity/.test(error.message),
    );
    assert.equal(missing.turns, 1);
    assert.equal(final.evidenceCharacters, 0);
    assert.equal(final.context.modelContextWindow, null);
    assert.deepEqual(final.budgetReached, ["model_context_unknown"]);

    const limited = new ScriptedRpc([JSON.stringify(valid)]);
    limited.contextWindow = 1000;
    await assert.rejects(
      new ScriptedClient(root, limited).run({
        passages,
        question: "Database?",
        onStats: (stats) => {
          final = stats;
        },
      }),
    );
    assert.equal(final.evidenceCharacters, 0);
    assert.ok(final.budgetReached.includes("model_context"));
    assert.equal(limited.turns, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Studio adapter rejects a flat artifact, repairs once and returns the requested structured schema", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-studio-client-"));
  const flat = JSON.parse(invalid("SQLite is proposed."));
  flat.blocks[0].citations = [
    {
      passageId: passages[0].id,
      quote: passages[0].text,
      start: 0,
      end: Array.from(passages[0].text).length,
    },
  ];
  const structured = {
    ...flat,
    kind: "summary",
    sections: [
      { key: "key_points", blockIndexes: [0] },
      { key: "limitations", blockIndexes: [] },
    ],
  };
  try {
    const rpc = new ScriptedRpc([
      JSON.stringify(flat),
      JSON.stringify(structured),
    ]);
    const answer = await new ScriptedClient(root, rpc).run({
      passages,
      question: "Summarize",
      kind: "summary",
    });
    assert.equal(rpc.turns, 2);
    assert.deepEqual(rpc.schemas[0].properties.kind.enum, ["summary"]);
    assert.ok(rpc.schemas[0].required.includes("sections"));
    assert.deepEqual(answer.sections, structured.sections);
    assert.equal(answer.kind, "summary");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("adapter maps turn error notifications to authentication and rate-limit categories", async () => {
  for (const [providerError, category] of [
    ["unauthorized", "authentication"],
    ["rateLimitExceeded", "rate_limit"],
  ]) {
    const root = mkdtempSync(
      path.join(os.tmpdir(), "codeboom-client-provider-"),
    );
    try {
      const rpc = new ScriptedRpc([], providerError);
      await assert.rejects(
        new ScriptedClient(root, rpc).run({ passages, question: "Database?" }),
        (error: any) => error.category === category,
      );
      assert.equal(rpc.turns, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("unverified previews preserve Unicode limits and malformed output without citation styling", () => {
  const preview = unverifiedDraft("🦉".repeat(200001));
  assert.equal(Array.from(preview.text).length, 200000);
  assert.equal(preview.truncated, true);
  assert.equal(
    unverifiedDraft("<script>untrusted</script>").text,
    "<script>untrusted</script>",
  );
});

test("a provider failure during repair retains the first unverified draft without changing its error category", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-repair-provider-"));
  try {
    const rpc = new ScriptedRpc(
      [invalid("First unverified claim")],
      "rateLimitExceeded",
      2,
    );
    await assert.rejects(
      new ScriptedClient(root, rpc).run({ passages, question: "Database?" }),
      (error: any) => {
        assert.equal(error.category, "rate_limit");
        assert.equal(error.draft?.text, "Draft\n\nFirst unverified claim");
        return true;
      },
    );
    assert.equal(rpc.turns, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("adapter computes source and section omissions while retaining all fifty model warnings", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-coverage-"));
  const omitted = chunkText(
    "Omitted evidence.",
    "s2",
    "r2",
    "Unread source",
    "Conclusions",
  );
  const output = JSON.parse(invalid("A source recommends SQLite."));
  output.blocks[0].citations = [
    {
      passageId: passages[0].id,
      quote: passages[0].text,
      start: 0,
      end: Array.from(passages[0].text).length,
    },
  ];
  output.coverageWarnings = Array.from(
    { length: 50 },
    (_, i) => "Warning " + i,
  );
  try {
    const rpc = new ScriptedRpc([JSON.stringify(output)]);
    const answer = await new ScriptedClient(root, rpc).run({
      passages: [...passages, ...omitted],
      question: "Summarize all sources",
    });
    assert.equal(rpc.turns, 1);
    assert.equal(answer.coverageWarnings.length, 50);
    assert.equal(answer.coverage?.[0].readPassages, 1);
    assert.deepEqual(answer.coverage?.[1].omittedSections, [
      { locator: "Conclusions", totalPassages: 1, unreadPassages: 1 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("study adapter uses typed items and repairs a malformed quiz key only once", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-study-client-"));
  try {
    const valid = studyAnswer(passages[0], "quiz");
    const invalid = structuredClone(valid);
    invalid.items![0].correctOptionId = "forged";
    const rpc = new ScriptedRpc([
      JSON.stringify(invalid),
      JSON.stringify(valid),
    ]);
    const answer = await new ScriptedClient(root, rpc).run({
      passages,
      question: "Quiz",
      kind: "quiz",
      itemCount: 5,
    });
    assert.equal(answer.kind, "quiz");
    assert.equal(answer.items!.length, 1);
    assert.equal(rpc.turns, 2);
    assert.deepEqual(rpc.schemas[0].properties.kind.enum, ["quiz"]);
    assert.ok(rpc.schemas[0].required.includes("items"));
    const twice = new ScriptedRpc([
      JSON.stringify(invalid),
      JSON.stringify(invalid),
    ]);
    await assert.rejects(
      new ScriptedClient(root, twice).run({
        passages,
        question: "Quiz",
        kind: "quiz",
        itemCount: 5,
      }),
    );
    assert.equal(twice.turns, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("structured adapter repairs trees and tables once using the requested schema", async () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "codeboom-structured-client-"),
  );
  try {
    for (const kind of ["mind-map", "data-table"] as const) {
      const valid = structuredAnswer(passages[0], kind),
        invalid = structuredClone(valid);
      if (kind === "mind-map") invalid.nodes![1].parentId = "foreign";
      else invalid.rows![0].cells.reverse();
      const rpc = new ScriptedRpc([
        JSON.stringify(invalid),
        JSON.stringify(valid),
      ]);
      const answer = await new ScriptedClient(root, rpc).run({
        passages,
        question: "Structure",
        kind,
      });
      assert.equal(answer.kind, kind);
      assert.equal(rpc.turns, 2);
      assert.deepEqual(rpc.schemas[0].properties.kind.enum, [kind]);
      assert.ok(
        rpc.schemas[0].required.includes(
          kind === "mind-map" ? "nodes" : "rows",
        ),
      );
      const twice = new ScriptedRpc([
        JSON.stringify(invalid),
        JSON.stringify(invalid),
      ]);
      await assert.rejects(
        new ScriptedClient(root, twice).run({
          passages,
          question: "Structure",
          kind,
        }),
      );
      assert.equal(twice.turns, 2);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
