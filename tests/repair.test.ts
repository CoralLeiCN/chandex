import test from "node:test";
import assert from "node:assert/strict";
import { citationRepairHints } from "../src/domain/repair.ts";
import { chunkText } from "../src/domain/evidence.ts";
import { exportMarkdown } from "../src/domain/export.ts";
test("repair hints locate exact unique quotes only within the cited selected passage", () => {
  const p = chunkText("🦉 Use SQLite. Repeat. Repeat.", "s", "r", "Fixture")[0];
  const raw = (quote: string, passageId = p.id) =>
    JSON.stringify({ blocks: [{ citations: [{ passageId, quote }] }] });
  assert.deepEqual(citationRepairHints(raw("Use SQLite."), [p]), [
    { blockIndex: 0, citationIndex: 0, passageId: p.id, start: 2, end: 13 },
  ]);
  assert.deepEqual(citationRepairHints(raw("Repeat."), [p]), []);
  assert.deepEqual(citationRepairHints(raw("Use SQLite.", "foreign"), [p]), []);
  assert.deepEqual(citationRepairHints(raw("Fabricated"), [p]), []);
});
test("Markdown exports retain public origin, historical revision and unavailable evidence", () => {
  const p = chunkText("Exact evidence", "s", "r", "Web source")[0];
  const content = {
    blocks: [
      {
        kind: "fact" as const,
        text: "Claim",
        citations: [{ passageId: p.id, quote: p.text, start: 0, end: 14 }],
      },
    ],
  };
  assert.match(
    exportMarkdown("Note", content, () => ({
      ...p,
      origin: "https://example.com/article",
    })),
    /https:\/\/example.com\/article/,
  );
  assert.match(
    exportMarkdown("Note", content, () => null),
    /Evidence unavailable/,
  );
});
