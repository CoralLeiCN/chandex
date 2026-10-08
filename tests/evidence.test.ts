import test from "node:test";
import assert from "node:assert/strict";
import {
  chunkText,
  validateAnswer,
  contextKey,
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
