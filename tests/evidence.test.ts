import test from "node:test";
import assert from "node:assert/strict";
import {
  chunkText,
  validateAnswer,
  contextKey,
  evidenceCoverage,
  type Answer,
} from "../src/domain/evidence.ts";
import { EvidenceTools } from "../src/retrieval/tools.ts";
const ps = chunkText(
  "🦉 Evidence says delivery takes 3 days.",
  "s1",
  "r1",
  "Delivery",
);
const answer: Answer = {
  status: "answered",
  title: "Delivery",
  blocks: [
    {
      kind: "fact",
      text: "Delivery takes 3 days.",
      citations: [
        {
          passageId: ps[0].id,
          quote: ps[0].text,
          start: 0,
          end: Array.from(ps[0].text).length,
        },
      ],
    },
  ],
  coverageWarnings: [],
};
test("Unicode citation offsets resolve exact evidence", () =>
  assert.deepEqual(validateAnswer(answer, ps), answer));
test("unknown, excluded, changed and malformed citations fail", () => {
  for (const change of [
    { passageId: "foreign" },
    { quote: "invented" },
    { end: 9999 },
    { start: -1 },
  ]) {
    const copy = structuredClone(answer);
    Object.assign(copy.blocks[0].citations[0], change);
    assert.throws(() => validateAnswer(copy, ps));
  }
  const noEvidence = structuredClone(answer);
  noEvidence.blocks[0].citations = [];
  assert.throws(() => validateAnswer(noEvidence, ps));
});
test("source boundaries and tool budgets are enforced", () => {
  const tools = new EvidenceTools(ps, undefined, 3);
  assert.throws(() =>
    tools.invoke("notebook_read_passage", { passageId: "other" }),
  );
  assert.throws(() => tools.invoke("shell", { command: "cat private" }));
  assert.throws(() =>
    tools.invoke("notebook_list_sources", { notebookId: "other" }),
  );
  assert.throws(() => tools.invoke("notebook_list_sources", {}), /budget/);
});
test("retriever cannot return evidence outside manifest", () => {
  const other = chunkText("Other notebook secret", "s2", "r2", "Other");
  assert.throws(
    () =>
      new EvidenceTools(ps, () => other).invoke("notebook_search", {
        query: "secret",
        limit: 1,
      }),
    /escaped/,
  );
});
test("manifest order is stable and revisions and instructions invalidate context", () => {
  assert.equal(contextKey(["r1", "r2"], "a"), contextKey(["r2", "r1"], "a"));
  assert.notEqual(contextKey(["r1"], "a"), contextKey(["r2"], "a"));
  assert.notEqual(contextKey(["r1"], "a"), contextKey(["r1"], "b"));
});

test("evidence budgets include metadata and rejected reads never claim coverage", () => {
  const oversized = {
    ...ps[0],
    origin: "https://public.example/" + "x".repeat(2000),
  };
  const tools = new EvidenceTools([oversized], undefined, 10, 500);
  assert.throws(
    () => tools.invoke("notebook_list_sources", {}),
    /character budget/,
  );
  assert.throws(
    () => tools.invoke("notebook_read_passage", { passageId: oversized.id }),
    /character budget/,
  );
  assert.equal(tools.characters, 0);
  assert.equal(tools.read.size, 0);
  assert.deepEqual([...tools.budgetReached], ["evidence_characters"]);
  const small = new EvidenceTools(ps, undefined, 10, 2000);
  const returned = small.invoke("notebook_read_passage", {
    passageId: ps[0].id,
  });
  assert.equal(small.characters, Array.from(JSON.stringify(returned)).length);
  assert.equal(small.read.has(ps[0].id), true);
  const limited = new EvidenceTools(ps, undefined, 1, 2000);
  limited.invoke("notebook_read_passage", { passageId: ps[0].id });
  assert.throws(
    () => limited.invoke("notebook_list_sources", {}),
    /call budget/,
  );
  assert.deepEqual([...limited.budgetReached], ["evidence_calls"]);
});

test("search results resolve to canonical manifest content even when a retriever returns a forged matching ID", () => {
  const forged = {
    ...ps[0],
    text: "EXCLUDED_OTHER_NOTEBOOK_EVIDENCE",
    origin: "file:///private",
  };
  const tools = new EvidenceTools(ps, () => [forged, forged, forged]);
  assert.deepEqual(
    tools.invoke("notebook_search", { query: "evidence", limit: 1 }),
    [ps[0]],
  );
  assert.ok(
    !JSON.stringify(
      tools.invoke("notebook_search", { query: "evidence", limit: 1 }),
    ).includes("EXCLUDED_OTHER_NOTEBOOK_EVIDENCE"),
  );
});
test("coverage identifies entirely omitted sources and partly read sections without changing model warnings", () => {
  const first = chunkText("a".repeat(3000), "a", "ra", "First", "Introduction");
  const last = chunkText("b", "b", "rb", "Second", "Conclusions");
  const coverage = evidenceCoverage(
    [...first, ...last],
    new Set([first[0].id, "foreign"]),
  );
  assert.equal(coverage[0].readPassages, 1);
  assert.equal(coverage[0].totalPassages, first.length);
  assert.deepEqual(coverage[0].omittedSections, [
    {
      locator: "Introduction",
      totalPassages: first.length,
      unreadPassages: first.length - 1,
    },
  ]);
  assert.equal(coverage[1].readPassages, 0);
  assert.deepEqual(coverage[1].omittedSections, [
    { locator: "Conclusions", totalPassages: 1, unreadPassages: 1 },
  ]);
  const value = structuredClone(answer);
  value.coverageWarnings = Array.from(
    { length: 50 },
    (_, i) => "Model warning " + i,
  );
  value.coverage = coverage;
  assert.deepEqual(
    validateAnswer(value, ps).coverageWarnings,
    value.coverageWarnings,
  );
});
