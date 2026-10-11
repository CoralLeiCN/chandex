import { structuredReviewResult } from "./fixtures/evaluation-results.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chunkText,
  validateAnswer,
  modelOutputSchema,
  OUTPUT_CONTRACT_VERSION,
  type Answer,
} from "../src/domain/evidence.ts";
import { structuredAnswer } from "./fixtures/structured.ts";
import {
  orderedMapNodes,
  structuredCitations,
} from "../src/domain/structured.ts";
import { mapLayout } from "../src/web/structured.tsx";
import { documentText } from "../src/domain/artifacts.ts";
import { exportMarkdown } from "../src/domain/export.ts";
import { citationRepairHints } from "../src/domain/repair.ts";
import { Store } from "../src/storage/store.ts";
import { backup, restore } from "../src/storage/backup.ts";
import { extract } from "../src/ingestion/extract.ts";
import { checkStructuredResult } from "../scripts/structured-checks.ts";

const passages = chunkText(
  "SQLite 😀 is proposed; estimated cost is £5 | month.\nThe date is conditional.",
  "s",
  "r",
  "Proposal",
);
test("mind maps reject invalid trees, unsupported relations, wrong spans and incomplete block ownership", () => {
  const valid = structuredAnswer(passages[0], "mind-map");
  assert.equal(validateAnswer(valid, passages, "mind-map"), valid);
  assert.deepEqual(
    (modelOutputSchema("mind-map").properties as any).kind.enum,
    ["mind-map"],
  );
  const invalid: ((a: Answer) => void)[] = [
    (a) => (a.nodes![1].id = "root"),
    (a) => (a.nodes![1].parentId = null),
    (a) => (a.nodes![0].parentId = "database"),
    (a) => (a.nodes![1].parentId = "database"),
    (a) => (a.nodes![1].parentId = "foreign"),
    (a) => a.nodes!.reverse(),
    (a) => (a.nodes![1].relationCitations = []),
    (a) => (a.nodes![1].relation = " "),
    (a) => (a.nodes![1].labelCitations[0].quote = "forged"),
    (a) => (a.nodes![1].relationCitations[0].passageId = "excluded"),
    (a) => (a.nodes![1].blockIndexes = []),
    (a) => (a.nodes![0].blockIndexes = [0]),
    (a) => (a.nodes![1].blockIndexes = [1]),
    (a) => (a.columns = []),
    (a) => (a.nodes![0].relation = "claims a parent"),
    (a) => (a.status = "insufficient_evidence"),
  ];
  for (const mutate of invalid) {
    const answer = structuredClone(valid);
    mutate(answer);
    assert.throws(() => validateAnswer(answer, passages, "mind-map"));
  }
  const deep = structuredClone(valid);
  for (let i = 2; i < 7; i++)
    deep.nodes!.push({
      ...structuredClone(deep.nodes![1]),
      id: "level-" + i,
      parentId: deep.nodes!.at(-1)!.id,
      blockIndexes: [],
    });
  assert.throws(() => validateAnswer(deep, passages, "mind-map"), /six levels/);
  assert.throws(() => validateAnswer(valid, passages, "answer"));
  assert.throws(() =>
    validateAnswer({ ...valid, kind: "quiz", nodes: [] }, passages),
  );
});
test("data tables preserve missing cells and reject duplicate IDs, omitted/misordered cells and uncited values", () => {
  const valid = structuredAnswer(passages[0], "data-table");
  assert.equal(validateAnswer(valid, passages, "data-table"), valid);
  const invalid: ((a: Answer) => void)[] = [
    (a) => (a.columns![1].id = a.columns![0].id),
    (a) => a.rows!.push(structuredClone(a.rows![0])),
    (a) => a.rows![0].cells.pop(),
    (a) => a.rows![0].cells.reverse(),
    (a) => (a.rows![0].cells[1].columnId = "foreign"),
    (a) => (a.rows![0].cells[1].blockIndexes = [0]),
    (a) => (a.rows![0].cells[0].blockIndexes = []),
    (a) => (a.blocks[0].citations = []),
    (a) => a.columns![0].labelCitations[0].end++,
    (a) => (a.rows![0].labelCitations[0].passageId = "foreign"),
    (a) => (a.blocks[0].kind = "notice"),
    (a) => (a.rows = []),
  ];
  for (const mutate of invalid) {
    const answer = structuredClone(valid);
    mutate(answer);
    assert.throws(() => validateAnswer(answer, passages, "data-table"));
  }
  for (const kind of ["mind-map", "data-table"] as const) {
    const empty = {
      ...structuredAnswer(passages[0], kind),
      status: "insufficient_evidence" as const,
      blocks: [
        {
          kind: "notice" as const,
          text: "No matching information.",
          citations: [],
        },
      ],
      ...(kind === "mind-map" ? { nodes: [] } : { columns: [], rows: [] }),
    };
    validateAnswer(empty, passages, kind);
    assert.match(documentText(empty), /No matching information/);
  }
});
test("structured exports and promotion preserve relationships, label citations, qualifiers, inferences and explicit gaps", () => {
  for (const kind of ["mind-map", "data-table"] as const) {
    const answer = structuredAnswer(passages[0], kind);
    answer.blocks[0].kind = "inference";
    const markdown = exportMarkdown(answer.title, answer, () => passages[0]);
    assert.equal((markdown.match(/\]: Proposal/g) ?? []).length, 3);
    assert.match(markdown, /Inference: SQLite 😀/);
    assert.match(markdown, /£5 \\\| month\.<br>The date is conditional/);
    assert.match(markdown, /revision r/);
    assert.match(documentText(answer), /Inference: SQLite 😀/);
    if (kind === "mind-map") {
      assert.match(markdown, /Relationship to Evidence: states/);
      assert.match(documentText(answer), /Evidence → states → SQLite 😀/);
    } else {
      assert.match(markdown, /\| Item \| Database/);
      assert.match(markdown, /Not stated/);
      assert.match(documentText(answer), /Budget: Not stated/);
    }
    const bad = structuredClone(answer);
    structuredCitations(bad).forEach((cite) => {
      cite.start = 1;
      cite.end = 2;
    });
    const hints = citationRepairHints(JSON.stringify(bad), passages) as any[];
    assert.ok(hints.some((hint) => hint.field === "labelCitations"));
    if (kind === "mind-map")
      assert.ok(hints.some((hint) => hint.field === "relationCitations"));
    assert.ok(
      hints.every(
        (hint) =>
          hint.start === 0 && hint.end === Array.from(passages[0].text).length,
      ),
    );
  }
});
test("map presentation follows real parents even for breadth-first output and collapse hides only descendants", () => {
  const nodes = structuredAnswer(passages[0], "mind-map").nodes!;
  nodes.push({
    ...structuredClone(nodes[1]),
    id: "sibling",
    parentId: "root",
    blockIndexes: [],
  });
  nodes.push({
    ...structuredClone(nodes[1]),
    id: "grandchild",
    parentId: "database",
    blockIndexes: [],
  });
  assert.deepEqual(
    orderedMapNodes(nodes).map((n) => n.id),
    ["root", "database", "grandchild", "sibling"],
  );
  const expanded = mapLayout(nodes, new Set()),
    closed = mapLayout(nodes, new Set(["database"]));
  assert.ok(expanded.positioned.every((p) => p.x >= 0 && p.y >= 0));
  assert.ok(expanded.positioned.some((p) => p.node.id === "grandchild"));
  assert.ok(!closed.positioned.some((p) => p.node.id === "grandchild"));
  assert.ok(closed.positioned.some((p) => p.node.id === "sibling"));
  assert.ok(closed.width < expanded.width);
});
test("structured artifacts validate before publication and preserve original revisions through backup, edits and purge", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-structured-"));
  let store = new Store(path.join(root, "data"));
  try {
    const n = store.createNotebook("Structures").id,
      c = store.view(n).conversations[0].id;
    const bytes = Buffer.from(passages[0].text),
      job = store.beginImport(n, "Proposal", "seed");
    store.publishImport(
      n,
      job.id,
      "Proposal",
      "text",
      null,
      bytes,
      await extract(bytes, "text"),
    );
    const p = store.selectedPassages(n, c)[0],
      source = p.sourceId;
    for (const kind of ["mind-map", "data-table"] as const) {
      const run = store.createRun(n, c, "Structure", kind, "fixture", kind);
      assert.equal(run.schema_version, OUTPUT_CONTRACT_VERSION);
      const bad = structuredAnswer(p, kind);
      bad.blocks[0].citations[0].passageId = "foreign";
      assert.throws(() => store.completeRun(run.id, bad));
      assert.equal(
        store.one("SELECT output FROM runs WHERE id=?", run.id).output,
        null,
      );
      assert.equal(store.completeRun(run.id, structuredAnswer(p, kind)), true);
      const failed = store.createRun(
        n,
        c,
        "Retry",
        kind,
        "fixture",
        kind + "-failed",
      );
      store.run("UPDATE runs SET status='failed' WHERE id=?", failed.id);
      assert.throws(
        () =>
          store.createRun(
            n,
            c,
            "Retry",
            kind === "mind-map" ? "data-table" : "mind-map",
            "fixture",
            kind + "-wrong-retry",
            failed.id,
          ),
        /preserve its output kind/,
      );
      const retry = store.createRun(
        n,
        c,
        "Retry",
        kind,
        "fixture",
        kind + "-retry",
        failed.id,
      );
      assert.equal(
        store.one("SELECT retry_of FROM runs WHERE id=?", retry.id).retry_of,
        failed.id,
      );
      assert.equal(
        store.createRun(
          n,
          c,
          "Retry",
          kind,
          "fixture",
          kind + "-retry",
          failed.id,
        ).id,
        retry.id,
      );
      store.run("UPDATE runs SET status='cancelled' WHERE id=?", retry.id);
    }
    const saved = store.view(n).artifacts,
      map = saved.find((a: any) => a.kind === "mind-map"),
      original = map.revision_id;
    store.editArtifact(
      n,
      map.id,
      "Authored",
      documentText(map.content) + "\nMy annotation.",
    );
    store.close();
    backup(path.join(root, "data"), path.join(root, "backup"));
    restore(path.join(root, "backup"), path.join(root, "restored"));
    store = new Store(path.join(root, "restored"));
    const old = JSON.parse(
      store.one("SELECT content FROM artifact_revisions WHERE id=?", original)
        .content,
    );
    validateAnswer(old, [p], "mind-map");
    assert.equal(store.view(n).artifacts.length, 2);
    const table = store
      .view(n)
      .artifacts.find((a: any) => a.kind === "data-table");
    assert.match(
      exportMarkdown(table.title, table.content, (id) => store.passage(n, id)),
      /Not stated/,
    );
    store.purgeSource(n, source);
    const after = store.view(n).artifacts;
    assert.match(
      after.find((a: any) => a.id === map.id).content.text,
      /My annotation/,
    );
    assert.equal(
      after.find((a: any) => a.kind === "data-table").unavailable,
      1,
    );
    assert.doesNotMatch(
      store.one("SELECT content FROM artifact_revisions WHERE id=?", original)
        .content,
      /SQLite/,
    );
  } finally {
    if (store.db.isOpen) store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("structured evaluation binds all eight cases and rechecks sparse facts without inventing a warning requirement", () => {
  const raw = structuredReviewResult();
  const report = checkStructuredResult(raw);
  assert.equal(report.passed, true);
  assert.equal(report.results.length, 8);
  assert.equal(report.semanticHumanReview, "pending");
  const original = JSON.parse(raw.toString());
  assert.equal(
    original.results.find((r: any) => r.id === "mind-map-sparse").sparseMet,
    false,
  );
  assert.equal(
    report.results.find((r) => r.id === "mind-map-sparse")!.sparseMet,
    true,
  );
  for (const field of ["question", "sources"] as const) {
    const changed = structuredClone(original);
    if (field === "question")
      changed.results[0].question = "Changed under the same case ID";
    else changed.results[0].sources[0].text = "Changed evidence";
    assert.throws(
      () => checkStructuredResult(Buffer.from(JSON.stringify(changed))),
      /changed or failed structured case/,
    );
  }
  const missing = structuredClone(original);
  missing.results.pop();
  assert.throws(
    () => checkStructuredResult(Buffer.from(JSON.stringify(missing))),
    /Complete matching/,
  );
  const forged = structuredClone(original);
  forged.corpusHash = "wrong";
  assert.throws(
    () => checkStructuredResult(Buffer.from(JSON.stringify(forged))),
    /Complete matching/,
  );
  const invented = structuredClone(original),
    table = invented.results.find(
      (r: any) => r.id === "data-table-sparse",
    ).answer;
  table.rows[0].cells[1].blockIndexes = [table.blocks.length];
  table.blocks.push({
    ...structuredClone(table.blocks[0]),
    text: "An invented budget",
  });
  const failed = checkStructuredResult(Buffer.from(JSON.stringify(invented)));
  assert.equal(failed.passed, false);
  assert.equal(
    failed.results.find((r) => r.id === "data-table-sparse")!.missingBudgetMet,
    false,
  );
});
