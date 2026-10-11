import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  artifactSections,
  documentGroups,
  documentText,
  type ArtifactKind,
} from "../src/domain/artifacts.ts";
import {
  chunkText,
  validateAnswer,
  modelOutputSchema,
  type Answer,
} from "../src/domain/evidence.ts";
import { exportMarkdown } from "../src/domain/export.ts";
import { Store } from "../src/storage/store.ts";
import { extract } from "../src/ingestion/extract.ts";
const passages = chunkText(
  "SQLite is proposed for the release.",
  "s",
  "r",
  "Proposal",
);
function output(kind: ArtifactKind, p = passages[0]): Answer {
  return {
    status: "answered",
    title: "Release research",
    kind,
    blocks: [
      {
        kind: "fact",
        text: "The proposal uses SQLite.",
        citations: [
          {
            passageId: p.id,
            quote: p.text,
            start: 0,
            end: Array.from(p.text).length,
          },
        ],
      },
    ],
    sections: artifactSections[kind].map((section, i) => ({
      key: section.key,
      blockIndexes: i === 0 ? [0] : [],
    })),
    coverageWarnings: [],
  };
}
test("every Studio format requires its own ordered sections and exact cited blocks", () => {
  for (const kind of Object.keys(artifactSections) as ArtifactKind[]) {
    const answer = output(kind);
    assert.equal(validateAnswer(answer, passages, kind), answer);
    assert.deepEqual((modelOutputSchema(kind).properties as any).kind.enum, [
      kind,
    ]);
    const text = exportMarkdown(answer.title, answer, () => passages[0]);
    for (const section of artifactSections[kind]) {
      assert.ok(text.includes("## " + section.title));
      assert.ok(documentText(answer).includes(section.title));
    }
    assert.match(text, /revision r/);
    assert.match(text, /Evidence: SQLite/);
    assert.equal(
      documentGroups(answer).flatMap((group) => group.blocks).length,
      1,
    );
  }
});
test("artifact layout cannot omit, duplicate or misplace blocks or escape citation boundaries", () => {
  const invalid: ((value: Answer) => void)[] = [
    (value) => {
      delete value.kind;
    },
    (value) => {
      delete value.sections;
    },
    (value) => {
      value.kind = "faq";
    },
    (value) => {
      value.sections!.reverse();
    },
    (value) => {
      value.sections![0].key = "invented";
    },
    (value) => {
      value.sections![0].blockIndexes = [];
    },
    (value) => {
      value.sections![1].blockIndexes = [0];
    },
    (value) => {
      value.sections![0].blockIndexes = [1];
    },
    (value) => {
      value.blocks[0].citations[0].passageId = "other-notebook";
    },
    (value) => {
      value.blocks[0].citations[0].quote = "forged";
    },
  ];
  for (const change of invalid) {
    const value = output("summary");
    change(value);
    assert.throws(() => validateAnswer(value, passages, "summary"));
  }
  assert.throws(() => validateAnswer(output("summary"), passages, "answer"));
});
test("legacy flat documents remain readable while new generated artifacts must be structured", () => {
  const value = output("summary");
  delete value.kind;
  delete value.sections;
  assert.equal(validateAnswer(value, passages), value);
  assert.throws(() => validateAnswer(value, passages, "summary"));
  assert.match(documentText(value), /The proposal uses SQLite/);
  assert.match(
    exportMarkdown(value.title, value, () => passages[0]),
    /The proposal uses SQLite/,
  );
});
test("structured artifacts survive restart and edits preserve the original cited revision", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-artifacts-"));
  let store = new Store(root);
  try {
    const n = store.createNotebook("Artifact fixture").id;
    const c = store.view(n).conversations[0].id;
    const bytes = Buffer.from(passages[0].text);
    const job = store.beginImport(n, "Proposal", "source");
    store.publishImport(
      n,
      job.id,
      "Proposal",
      "text",
      null,
      bytes,
      await extract(bytes, "text"),
    );
    const p = store.selectedPassages(n, c)[0];
    for (const kind of Object.keys(artifactSections) as ArtifactKind[]) {
      const run = store.createRun(
        n,
        c,
        "Create document",
        kind,
        "fixture",
        kind,
      );
      assert.throws(() =>
        store.completeRun(run.id, { ...output(kind, p), sections: [] }),
      );
      assert.equal(
        store.one("SELECT status FROM runs WHERE id=?", run.id).status,
        "queued",
      );
      assert.equal(store.completeRun(run.id, output(kind, p)), true);
    }
    store.close();
    store = new Store(root);
    const saved = store.view(n).artifacts;
    assert.equal(saved.length, Object.keys(artifactSections).length);
    for (const note of saved) validateAnswer(note.content, [p], note.kind);
    const before = saved[0].content;
    store.editArtifact(
      n,
      saved[0].id,
      "Edited",
      documentText(before) + "\n\nMy annotation",
    );
    const edited = store
      .view(n)
      .artifacts.find((a: any) => a.id === saved[0].id);
    assert.equal(edited.authored, 1);
    assert.equal(edited.content.blocks, undefined);
    assert.match(edited.content.text, /My annotation/);
    const revisions = store.all(
      "SELECT * FROM artifact_revisions WHERE artifact_id=? ORDER BY created",
      saved[0].id,
    );
    assert.deepEqual(JSON.parse(revisions[0].content), before);
    assert.equal(store.passage(n, p.id).text, p.text);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
