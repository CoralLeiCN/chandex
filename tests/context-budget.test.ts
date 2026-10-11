import test from "node:test";
import assert from "node:assert/strict";
import { ContextBudget } from "../src/domain/context-budget.ts";
import { EvidenceTools } from "../src/retrieval/tools.ts";
import { chunkText } from "../src/domain/evidence.ts";
const report = (window: number, tokens = 1000) => ({
  modelContextWindow: window,
  last: {
    totalTokens: tokens,
    inputTokens: tokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  },
});

test("context budget refuses unknown capacity without exposing evidence or claiming read coverage", () => {
  const context = new ContextBudget();
  const passages = chunkText("SOURCE_SECRET_CANARY", "s", "r", "Source");
  const tools = new EvidenceTools(passages, undefined, 20, 200000, (text) =>
    context.admitEvidence(text),
  );
  for (const invalid of [
    null,
    [],
    { modelContextWindow: 10000 },
    report(0),
    report(-1),
    report(Number.MAX_SAFE_INTEGER + 1),
    { ...report(10000), last: { ...report(10000).last, inputTokens: -1 } },
  ])
    context.observe(invalid);
  assert.equal(context.ready, false);
  assert.throws(
    () => tools.invoke("notebook_read_passage", { passageId: passages[0].id }),
    (error) =>
      error instanceof Error &&
      /No evidence was sent/.test(error.message) &&
      !/SOURCE_SECRET_CANARY/.test(error.message),
  );
  assert.equal(tools.characters, 0);
  assert.equal(tools.read.size, 0);
  assert.equal(context.snapshot().capacityRefusals, 1);
  context.observe(report(10000));
  assert.equal(
    (
      tools.invoke("notebook_read_passage", {
        passageId: passages[0].id,
      }) as any
    ).text,
    passages[0].text,
  );
  assert.equal(tools.read.size, 1);
});

test("context admission charges serialized UTF-8 bytes, observes selected capacity and retains conservative headroom", () => {
  const small = new ContextBudget(),
    large = new ContextBudget();
  small.observe(report(10000));
  large.observe(report(20000));
  const text = "🦉".repeat(1900); // 7,600 bytes, despite only 1,900 code points.
  assert.throws(() => small.admitEvidence(text), /context budget/);
  assert.equal(small.reached, true);
  assert.equal(small.snapshot().chargedBytes, 0);
  large.admitEvidence(text);
  assert.equal(large.snapshot().chargedBytes, 7856);
  large.accountProtocol("Tool framing and error response");
  const before = large.snapshot();
  large.observe(report(40000, 500));
  assert.equal(large.snapshot().modelContextWindow, 20000);
  assert.equal(large.snapshot().reportedContextTokens, 1000);
  assert.equal(large.snapshot().chargedBytes, before.chargedBytes);
  large.observe(report(20000, 4000));
  assert.equal(large.snapshot().reportedContextTokens, 4000);
  assert.throws(() => large.admitInput("x".repeat(10000)), /context budget/);
  assert.equal(large.snapshot().chargedBytes, before.chargedBytes);
});

test("context cutoff leaves failed full responses unread and permits a smaller response within the same capacity", () => {
  const context = new ContextBudget();
  context.observe(report(10000));
  const long = chunkText("🦉".repeat(1600), "large", "large-r", "Large");
  const short = chunkText(
    "Small supported evidence",
    "small",
    "small-r",
    "Small",
  );
  const tools = new EvidenceTools(
    [...long, ...short],
    undefined,
    20,
    200000,
    (text) => context.admitEvidence(text),
  );
  context.accountProtocol("x".repeat(1500));
  assert.throws(
    () => tools.invoke("notebook_read_passage", { passageId: long[0].id }),
    /context budget/,
  );
  assert.equal(tools.read.size, 0);
  assert.equal(tools.characters, 0);
  tools.invoke("notebook_read_passage", { passageId: short[0].id });
  assert.deepEqual([...tools.read], [short[0].id]);
  assert.ok(tools.characters > 0);
});
