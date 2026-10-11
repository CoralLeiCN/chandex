import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getSchema } from "@tiptap/core";
import { RichNoteView } from "../src/web/notes.tsx";
import {
  noteEditorExtensions,
  noteReferencePlugins,
  noteEditorDocument,
} from "../src/web/note-editor.tsx";
import { EditorState } from "@tiptap/pm/state";
import {
  richNote,
  editableNote,
  noteCitations,
  noteLink,
  richText,
  type RichNote,
  type NoteNode,
} from "../src/domain/notes.ts";
import {
  artifactSections,
  documentText,
  type ArtifactKind,
} from "../src/domain/artifacts.ts";
import { chunkText, type Answer } from "../src/domain/evidence.ts";
import { exportMarkdown } from "../src/domain/export.ts";
import { richFixture } from "./fixtures/notes.ts";
import { studyAnswer } from "./fixtures/study.ts";
import { structuredAnswer } from "./fixtures/structured.ts";
import { Store } from "../src/storage/store.ts";
import { extract } from "../src/ingestion/extract.ts";
import { backup, restore } from "../src/storage/backup.ts";
const passage = chunkText(
  "Café 🦉: the budget is provisional.",
  "source",
  "revision",
  "Proposal",
)[0];
const citation = { passageId: passage.id, quote: "🦉", start: 5, end: 6 };
const doc = (content: NoteNode[]): RichNote => ({
  format: "rich-note",
  version: 1,
  doc: { type: "doc", content },
});
test("opening multiline notes preserves breaks, marks, citations and code through the editor schema", () => {
  const input = doc([
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Before\nAfter", marks: [{ type: "bold" }] },
      ],
    },
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "First\nLast" }],
    },
    { type: "paragraph", content: [{ type: "citation", attrs: { citation } }] },
    {
      type: "codeBlock",
      content: [{ type: "text", text: "line one\n<script>literal</script>" }],
    },
  ]);
  const output = noteEditorDocument(input);
  assert.equal(richText(output), richText(input));
  assert.deepEqual(noteCitations(output), [citation]);
  const schema = getSchema(noteEditorExtensions),
    parsed = schema.nodeFromJSON(output.doc);
  parsed.check();
  assert.deepEqual(richNote({ ...output, doc: parsed.toJSON() }), output);
  assert.equal(output.doc.content![0].content![1].type, "hardBreak");
  assert.deepEqual(output.doc.content![0].content![2].marks, [
    { type: "bold" },
  ]);
  assert.equal(output.doc.content![3].content!.length, 1);
  const html = renderToStaticMarkup(
    React.createElement(RichNoteView, {
      content: output,
      openPassage: () => {},
    }),
  );
  assert.equal((html.match(/<br\/?\s*>/g) ?? []).length, 2);
  assert.doesNotMatch(html, /<script>/);
});
test("rich documents preserve semantic structures in editor schema, safe rendering, plain text and Markdown", () => {
  const value = richNote(richFixture(citation), () => passage);
  const schema = getSchema(noteEditorExtensions);
  const editorDoc = schema.nodeFromJSON(value.doc);
  editorDoc.check();
  assert.deepEqual(richNote({ ...value, doc: editorDoc.toJSON() }), value);
  assert.deepEqual(noteCitations(value), [citation]);
  const html = renderToStaticMarkup(
    React.createElement(RichNoteView, {
      content: value,
      openPassage: () => {},
      availability: { [passage.id]: false },
    }),
  );
  assert.match(html, /<h2>Research 🦉<\/h2>/);
  assert.match(html, /<ol start="3">/);
  assert.match(html, /<ul>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<em><strong>Conditional budget<\/strong><\/em>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img|<script>/);
  assert.match(html, /noopener noreferrer nofollow/);
  assert.match(html, /evidence unavailable/);
  const md = exportMarkdown("<script>Title</script>", value, () => passage);
  assert.match(md, /## Research 🦉/);
  assert.match(md, /3\. Review qualifiers\n\s+\n\s+- Check approval/);
  assert.match(md, /\*\*Conditional budget\*\*/);
  assert.match(md, /&lt;img/);
  assert.match(md, /````\n```\n<script>literal\(\)<\/script>\n````/);
  assert.match(md, /\[\^1\]: Proposal — Text; revision revision/);
  assert.match(md, /not been revalidated/);
  assert.doesNotMatch(md, /^# <script>/);
  assert.match(documentText(value), /Attached reference: 🦉/);
  assert.equal(documentText(value), richText(value));
});
test("formatting a selection across an attached reference preserves its span without formatting the citation atom", () => {
  const schema = getSchema(noteEditorExtensions);
  const input = richNote(richFixture(citation));
  let state = EditorState.create({
    schema,
    doc: schema.nodeFromJSON(input.doc),
    plugins: noteReferencePlugins(),
  });
  state = state.applyTransaction(
    state.tr.addMark(0, state.doc.content.size, schema.marks.bold.create()),
  ).state;
  const output = richNote({ ...input, doc: state.doc.toJSON() });
  assert.deepEqual(noteCitations(output), [citation]);
  state.doc.descendants((node) => {
    if (node.type.name === "citation") assert.equal(node.marks.length, 0);
  });
  assert.ok(
    output.doc.content![0].content![0].marks!.some((m) => m.type === "bold"),
  );
});
test("rich note validation refuses executable links, unknown structures, malformed spans, marks and nesting atomically", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///etc/passwd",
    "https://u:p@example.org",
    "//example.org",
    "https://example.org/\nhi",
    "mailto:a@example.org",
  ])
    assert.throws(() => noteLink(url));
  assert.equal(noteLink("https://example.org"), "https://example.org/");
  const bad: unknown[] = [
    { ...richFixture(), version: 2 },
    { ...richFixture(), html: "<script>" },
    doc([{ type: "image", attrs: { src: "https://example.org" } }]),
    doc([{ type: "paragraph", attrs: { onclick: "hi" } }]),
    doc([{ type: "heading", attrs: { level: 6 } }]),
    doc([{ type: "text", text: "outside" }]),
    doc([{ type: "paragraph", content: [{ type: "paragraph" }] }]),
    doc([{ type: "listItem", content: [{ type: "paragraph" }] }]),
    doc([{ type: "orderedList", attrs: { start: -1 }, content: [] }]),
    doc([
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [{ type: "heading", attrs: { level: 1 } }],
          },
        ],
      },
    ]),
    doc([{ type: "paragraph", content: [{ type: "text", text: "x\0y" }] }]),
    doc([
      {
        type: "codeBlock",
        content: [{ type: "text", text: "x", marks: [{ type: "bold" }] }],
      },
    ]),
    doc([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "x",
            marks: [{ type: "bold" }, { type: "bold" }],
          },
        ],
      },
    ]),
    doc([
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "x",
            marks: [
              {
                type: "link",
                attrs: { href: "https://example.org", target: "_self" },
              },
            ],
          },
        ],
      },
    ]),
    doc([
      {
        type: "paragraph",
        content: [
          { type: "citation", attrs: { citation: { ...citation, start: 4 } } },
        ],
      },
    ]),
    doc([
      {
        type: "paragraph",
        content: [
          { type: "citation", attrs: { citation: { ...citation, start: -1 } } },
        ],
      },
    ]),
    doc([
      {
        type: "paragraph",
        content: [
          {
            type: "citation",
            attrs: { citation: { ...citation, quote: "other" } },
          },
        ],
      },
    ]),
  ];
  let deep: NoteNode = { type: "paragraph" };
  for (let i = 0; i < 13; i++) deep = { type: "blockquote", content: [deep] };
  bad.push(doc([deep]));
  for (const value of bad) assert.throws(() => richNote(value, () => passage));
  assert.throws(() => richNote(richFixture(citation), () => null));
  assert.doesNotThrow(() =>
    richNote(richFixture(citation), () => null, [citation]),
  );
  assert.throws(() =>
    richNote(richFixture({ ...citation, quote: "forged" }), () => null, [
      citation,
    ]),
  );
});
test("rich note Unicode, node, JSON and depth budgets are independent and refuse oversized saves", () => {
  assert.doesNotThrow(() =>
    richNote(
      doc([
        {
          type: "paragraph",
          content: [{ type: "text", text: "🦉".repeat(100000) }],
        },
      ]),
    ),
  );
  assert.throws(
    () =>
      richNote(
        doc([
          {
            type: "paragraph",
            content: [{ type: "text", text: "🦉".repeat(100001) }],
          },
        ]),
      ),
    /text limit/,
  );
  assert.throws(
    () =>
      richNote(
        doc(Array.from({ length: 5000 }, () => ({ type: "paragraph" }))),
      ),
    /node or nesting/,
  );
  const url = "https://example.org/" + "a".repeat(2000);
  assert.throws(
    () =>
      richNote(
        doc(
          Array.from({ length: 500 }, () => ({
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "x",
                marks: [{ type: "link", attrs: { href: url } }],
              },
            ],
          })),
        ),
      ),
    /JSON limit/,
  );
  const cyclic: any = { type: "blockquote", content: [] };
  cyclic.content.push(cyclic);
  assert.throws(() => richNote(doc([cyclic])), /node or nesting/);
});
test("conversion retains citations, qualifiers and labels across chat, every document/study/structured kind and legacy text", () => {
  const answer: Answer = {
    title: "Findings",
    status: "answered",
    blocks: [
      {
        text: "Budget is provisional.",
        kind: "inference",
        citations: [citation],
      },
    ],
    coverageWarnings: ["Approval is pending."],
    coverage: [
      {
        sourceId: passage.sourceId,
        revisionId: passage.revisionId,
        title: passage.title,
        totalPassages: 2,
        readPassages: 1,
        omittedSections: [
          { locator: "Unseen section", totalPassages: 1, unreadPassages: 1 },
        ],
      },
    ],
  };
  const outputs: Answer[] = [
    answer,
    ...Object.keys(artifactSections).map((kind) => ({
      ...answer,
      kind: kind as ArtifactKind,
      sections: artifactSections[kind as ArtifactKind].map((s, i) => ({
        key: s.key,
        blockIndexes: i === 0 ? [0] : [],
      })),
    })),
    studyAnswer(passage, "flashcards"),
    studyAnswer(passage, "quiz"),
    structuredAnswer(passage, "mind-map"),
    structuredAnswer(passage, "data-table"),
  ];
  for (const original of outputs) {
    const converted = editableNote(original);
    const key = (c: any) =>
      JSON.stringify([c.passageId, c.quote, c.start, c.end]);
    assert.deepEqual(
      new Set(noteCitations(converted).map(key)),
      new Set(noteCitations(original).map(key)),
    );
    for (const b of original.blocks)
      assert.ok(richText(converted).includes(b.text));
    for (const warning of original.coverageWarnings)
      assert.ok(richText(converted).includes(warning));
    assert.equal((converted as any).items, undefined);
    if (original.coverage)
      assert.match(richText(converted), /Unseen section: 1 of 1/);
    if (original.kind === "quiz")
      assert.match(richText(converted), /Candidate answer \(distractor\)/);
    if (original.kind === "data-table")
      assert.match(richText(converted), /Budget\n\nNot stated/);
    if (original.kind === "mind-map")
      assert.match(richText(converted), /Relationship to Evidence: states/);
  }
  assert.match(
    richText(editableNote({ text: "Legacy\n\nsecond paragraph" })),
    /Legacy\n\nsecond paragraph/,
  );
});
async function setup(store: Store, n: string) {
  const bytes = Buffer.from("Café 🦉: the budget is provisional."),
    job = store.beginImport(n, "Evidence", crypto.randomUUID());
  const s = store.publishImport(
    n,
    job.id,
    "Evidence",
    "text",
    null,
    bytes,
    await extract(bytes, "text"),
  );
  const p = store.selectedPassages(n, store.view(n).conversations[0].id)[0];
  return {
    s,
    p,
    c: {
      passageId: p.id,
      quote: p.text,
      start: 0,
      end: Array.from(p.text).length,
    },
  };
}
test("editing and restoring a quiz keeps its generated original and attempts pinned without giving authored revisions a scoring key", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-rich-quiz-")),
    store = new Store(root);
  try {
    const n = store.createNotebook("Quiz history").id,
      { p } = await setup(store, n),
      conversation = store.view(n).conversations[0].id;
    const run = store.createRun(
      n,
      conversation,
      "Quiz",
      "quiz",
      "fixture",
      "rich-quiz",
      undefined,
      5,
    );
    store.completeRun(run.id, studyAnswer(p, "quiz"));
    const original = store.view(n).artifacts[0],
      originalContent = structuredClone(original.content);
    const attempt = store.startQuizAttempt(
      n,
      original.id,
      original.revision_id,
      "before-edit",
    );
    const edited = store.editRichArtifact(
      n,
      original.id,
      "Authored study",
      editableNote(original.content),
      original.revision_id,
    );
    assert.throws(
      () => store.startQuizAttempt(n, original.id, edited, "edited-key"),
      /unavailable/,
    );
    const restored = store.restoreArtifact(
      n,
      original.id,
      original.revision_id,
      edited,
    );
    assert.throws(
      () => store.startQuizAttempt(n, original.id, restored, "restored-key"),
      /unavailable/,
    );
    const preserved = store.artifactRevision(
      n,
      original.id,
      original.revision_id,
    );
    assert.deepEqual(preserved.content, originalContent);
    assert.equal(preserved.authored, 0);
    const scored = store.saveQuizAnswers(
      n,
      original.id,
      attempt.id,
      { "item-1": "correct" },
      true,
    );
    assert.equal(scored.score, 1);
    assert.equal(scored.revision_id, original.revision_id);
    assert.equal(store.view(n).artifacts[0].content.items, undefined);
    assert.deepEqual(
      noteCitations(store.view(n).artifacts[0].content),
      noteCitations(editableNote(originalContent)),
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("rich saves/history reject foreign IDs and stale bases, preserve originals, update FTS and restore as new authored revisions", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-rich-")),
    store = new Store(root);
  try {
    const n = store.createNotebook("Rich notes").id,
      other = store.createNotebook("Other").id,
      { p, c } = await setup(store, n);
    assert.throws(() =>
      store.createRichArtifact(other, "Foreign", richFixture(c)),
    );
    const run = store.createRun(
      n,
      store.view(n).conversations[0].id,
      "Question",
      "answer",
      "fixture",
      "rich-run",
    );
    const generated: Answer = {
      title: "Generated original",
      status: "answered",
      blocks: [{ text: p.text, kind: "fact", citations: [c] }],
      coverageWarnings: [],
    };
    store.completeRun(run.id, generated);
    const a = store.saveArtifact(
      n,
      generated.title,
      "note",
      JSON.stringify(generated),
      false,
      run.id,
    );
    const base = store.artifactHistory(n, a).results[0].id;
    const next = store.editRichArtifact(
      n,
      a,
      "Edited rich",
      richFixture(c),
      base,
    );
    assert.deepEqual(store.artifactRevision(n, a, base).content, generated);
    assert.equal(store.artifactRevision(n, a, next).authored, 1);
    assert.ok(store.discover("qualifiers").results.some((r) => r.id === a));
    assert.equal(
      store.editRichArtifact(n, a, "Edited rich", richFixture(c), next),
      next,
    );
    assert.throws(
      () => store.editRichArtifact(n, a, "Stale", richFixture(c), base),
      /changed/,
    );
    assert.throws(
      () => store.editArtifact(n, a, "Stale plain", "x", base),
      /changed/,
    );
    assert.throws(() => store.artifactHistory(other, a));
    assert.throws(() => store.artifactRevision(other, a, base));
    assert.throws(() => store.artifactHistory(n, a, 0, 51));
    const page = store.artifactHistory(n, a, 0, 1);
    assert.equal(page.nextOffset, 1);
    assert.equal(store.artifactHistory(n, a, 1, 1).results[0].id, base);
    assert.throws(() => store.restoreArtifact(n, a, base, base), /changed/);
    const restored = store.restoreArtifact(n, a, base, next);
    assert.equal(store.artifactRevision(n, a, restored).authored, 1);
    assert.deepEqual(
      noteCitations(store.artifactRevision(n, a, restored).content),
      [c],
    );
    assert.doesNotMatch(
      richText(store.artifactRevision(n, a, restored).content),
      /Review qualifiers/,
    );
    assert.equal(
      store.discover("qualifiers").results.some((r) => r.id === a),
      false,
    );
    assert.equal(store.artifactHistory(n, a).results.length, 3);
    assert.deepEqual(store.artifactRevision(n, a, base).content, generated);
    const legacy = store.saveArtifact(
      n,
      "Legacy title",
      "note",
      JSON.stringify({ text: "Older plain note" }),
      true,
    );
    const legacyRevision = store.artifactHistory(n, legacy).results[0].id;
    store.run(
      "UPDATE artifact_revisions SET title=NULL WHERE id=?",
      legacyRevision,
    );
    store.editArtifact(
      n,
      legacy,
      "Current title",
      "Current body",
      legacyRevision,
    );
    const currentLegacy = store.artifactHistory(n, legacy).results[0].id;
    const legacyMetadata = store.artifactRevision(n, legacy, legacyRevision);
    assert.equal(legacyMetadata.titleRecorded, false);
    assert.equal(legacyMetadata.title, "Current title");
    const legacyRestore = store.restoreArtifact(
      n,
      legacy,
      legacyRevision,
      currentLegacy,
    );
    assert.equal(
      store.artifactRevision(n, legacy, legacyRestore).title,
      "Current title",
    );
    assert.match(
      documentText(store.artifactRevision(n, legacy, legacyRestore).content),
      /Older plain note/,
    );
    assert.equal(
      store
        .artifactHistory(n, legacy)
        .results.find((r: any) => r.id === legacyRevision).title,
      null,
    );
    assert.equal(store.view(n).runs.length, 1); // only the seeded generation
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("purge retains authored rich notes and inherited missing references, erases generated originals and survives stopped backup/restore", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-rich-backup-")),
    data = path.join(root, "data");
  let store = new Store(data);
  try {
    const n = store.createNotebook("Retained authored").id,
      { s, p, c } = await setup(store, n);
    const run = store.createRun(
      n,
      store.view(n).conversations[0].id,
      "Question",
      "summary",
      "fixture",
      "purge-rich",
    );
    store.completeRun(run.id, {
      title: "Summary",
      status: "answered",
      kind: "summary",
      sections: [
        { key: "key_points", blockIndexes: [0] },
        { key: "limitations", blockIndexes: [] },
      ],
      blocks: [{ text: p.text, kind: "fact", citations: [c] }],
      coverageWarnings: [],
    });
    const original = store.view(n).artifacts[0],
      base = original.revision_id;
    const authored = store.editRichArtifact(
      n,
      original.id,
      "Kept edit",
      richFixture(c),
      base,
    );
    const manual = store.createRichArtifact(n, "Manual rich", richFixture(c));
    store.purgeSource(n, p.sourceId);
    assert.equal(store.artifactRevision(n, original.id, base).available, false);
    assert.throws(
      () => store.restoreArtifact(n, original.id, base, authored),
      /unavailable/,
    );
    const kept = store.view(n).artifacts.find((a: any) => a.id === original.id);
    assert.equal(kept.referenceAvailability[p.id], false);
    assert.equal(kept.referencesUnavailable, true);
    assert.match(documentText(kept.content), /Conditional budget/);
    assert.match(
      exportMarkdown(kept.title, kept.content, () => null),
      /Evidence unavailable/,
    );
    const changed = structuredClone(kept.content);
    changed.doc.content![0].content![0].text = "Kept revised";
    const next = store.editRichArtifact(
      n,
      kept.id,
      "Kept revised",
      changed,
      authored,
    );
    assert.throws(() => store.createRichArtifact(n, "Forged old", changed));
    const forged = structuredClone(changed);
    forged.doc.content![1].content!.find(
      (v: any) => v.type === "citation",
    )!.attrs!.citation.quote = "forged";
    assert.throws(() =>
      store.editRichArtifact(n, kept.id, "Forged", forged, next),
    );
    const restored = store.restoreArtifact(n, kept.id, authored, next);
    assert.equal(
      store.artifactRevision(n, kept.id, restored).referenceAvailability[p.id],
      false,
    );
    assert.ok(
      store.discover("qualifiers").results.some((r) => r.id === manual),
    );
    store.close();
    store = new Store(data);
    assert.equal(
      store.view(n).artifacts.find((a: any) => a.id === manual)
        .referencesUnavailable,
      true,
    );
    store.close();
    backup(data, path.join(root, "backup"));
    restore(path.join(root, "backup"), path.join(root, "restored"));
    store = new Store(path.join(root, "restored"));
    assert.equal(store.artifactHistory(n, kept.id).results.length, 4);
    assert.equal(
      store.view(n).artifacts.find((a: any) => a.id === manual)
        .referenceAvailability[p.id],
      false,
    );
    assert.equal(store.discover("qualifiers").results.length, 2);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
