import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JSDOM } from "jsdom";
import {
  chunkText,
  validateAnswer,
  modelOutputSchema,
  OUTPUT_CONTRACT_VERSION,
  type Answer,
} from "../src/domain/evidence.ts";
import { documentText } from "../src/domain/artifacts.ts";
import { exportMarkdown } from "../src/domain/export.ts";
import { exportHtml } from "../src/domain/export-html.ts";
import {
  exportPptx,
  PPTX_LIMIT,
  slideLines,
} from "../src/domain/export-pptx.ts";
import { officePackage } from "../src/ingestion/office-package.ts";
import { extractIsolated } from "../src/ingestion/service.ts";
import { extract } from "../src/ingestion/extract.ts";
import { Store } from "../src/storage/store.ts";
import { backup, restore } from "../src/storage/backup.ts";
import { slideAnswer, slideSourceText } from "./fixtures/slides.ts";

const passages = chunkText(
  slideSourceText,
  "source",
  "source-revision",
  "Proposal",
);
const revision = {
  revisionId: "artifact-revision",
  created: "2026-10-10T21:00:00Z",
  authored: false,
  historical: true,
  available: true,
};
const resolve = () => ({
  ...passages[0],
  derivation: {
    artifactId: "ancestor-note",
    revisionId: "ancestor-revision",
    origin: "authored",
  },
});

test("slides require exact block ownership, concise supported claims and a single artifact layout", () => {
  const valid = slideAnswer(passages[0]);
  assert.equal(validateAnswer(valid, passages, "slides"), valid);
  assert.deepEqual((modelOutputSchema("slides").properties as any).kind.enum, [
    "slides",
  ]);
  const invalid: ((a: Answer) => void)[] = [
    (a) => {
      a.slides![1].id = a.slides![0].id;
    },
    (a) => {
      a.slides![1].id = " ";
    },
    (a) => {
      a.slides![0].bodyBlockIndexes = [];
    },
    (a) => {
      a.slides![0].bodyBlockIndexes.push(0);
    },
    (a) => {
      a.slides![0].bodyBlockIndexes.push(5);
    },
    (a) => {
      a.slides![0].noteBlockIndexes = [];
    },
    (a) => {
      a.slides![0].headlineBlockIndex = 79;
    },
    (a) => {
      a.slides![0].noteBlockIndexes.push(3, 4);
    },
    (a) => {
      a.blocks[0].text = "x".repeat(71);
    },
    (a) => {
      a.blocks[1].text = "x".repeat(161);
    },
    (a) => {
      a.blocks[2].text = "x".repeat(401);
    },
    (a) => {
      a.blocks[1].text += "\nextra line";
    },
    (a) => {
      a.blocks[1].citations = [];
    },
    (a) => {
      a.blocks[1].citations = Array(5).fill(a.blocks[1].citations[0]);
    },
    (a) => {
      a.blocks[0].citations[0].quote = "forged";
    },
    (a) => {
      a.blocks[0].citations[0].passageId = "foreign";
    },
    (a) => {
      a.sections = [];
    },
    (a) => {
      a.items = [];
    },
    (a) => {
      a.nodes = [];
    },
    (a) => {
      a.status = "insufficient_evidence";
    },
    (a) => {
      a.slides = Array(9).fill(a.slides![0]);
    },
  ];
  for (const mutate of invalid) {
    const answer = structuredClone(valid);
    mutate(answer);
    assert.throws(() => validateAnswer(answer, passages, "slides"));
  }
  assert.throws(() => validateAnswer(valid, passages, "answer"));
  const empty: Answer = {
    kind: "slides",
    status: "insufficient_evidence",
    title: "Unknown",
    blocks: [
      { kind: "notice", text: "No matching information.", citations: [] },
    ],
    coverageWarnings: [],
    slides: [],
  };
  validateAnswer(empty, passages, "slides");
  assert.match(documentText(empty), /No matching information/);
  const complete = structuredClone(valid);
  complete.blocks.pop();
  assert.doesNotMatch(
    documentText(complete),
    /No supported content|Evidence gaps/,
  );
});

test("slide text, Markdown and inert HTML preserve order, notes, qualifications and ancestry", () => {
  const answer = slideAnswer(passages[0]);
  const markdown = exportMarkdown(answer.title, answer, resolve);
  const text = documentText(answer);
  const html = exportHtml(
    "<script>alert(1)</script>",
    answer,
    resolve,
    revision,
  );
  const dom = new JSDOM(html);
  assert.equal(
    dom.window.document.querySelectorAll("script,iframe,img,video,audio")
      .length,
    0,
  );
  assert.equal(dom.window.document.querySelectorAll(".slide").length, 2);
  assert.equal(dom.window.document.querySelectorAll(".slide aside").length, 1);
  for (const representation of [
    text,
    markdown,
    dom.window.document.body.textContent!,
  ]) {
    for (const block of answer.blocks)
      assert.ok(representation.includes(block.text), block.text);
    assert.ok(
      representation.indexOf(answer.blocks[0].text) <
        representation.indexOf(answer.blocks[3].text),
    );
    assert.ok(representation.includes(answer.coverageWarnings[0]));
    assert.match(representation, /Inference:/);
  }
  for (const representation of [markdown, html]) {
    assert.match(representation, /ancestor-note/);
    assert.match(representation, /ancestor-revision/);
    assert.match(representation, /source-revision/);
    assert.match(representation, /not independent corroboration/);
  }
  assert.equal(
    dom.window.document.querySelector("h1")!.textContent,
    "<script>alert(1)</script>",
  );
  dom.window.close();
});

test("PowerPoint is native editable text with complete cited notes and no remote/media relationships", async () => {
  const answer = slideAnswer(passages[0]);
  let resolves = 0;
  const bytes = await exportPptx(
    answer.title,
    answer,
    () => {
      resolves++;
      return resolve();
    },
    revision,
  );
  assert.equal(resolves, 1, "assemble from one captured evidence view");
  assert.ok(bytes.length > 1000 && bytes.length < PPTX_LIMIT);
  const pkg = await officePackage(bytes);
  const slideNames = [...pkg.names].filter((name) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(name),
  );
  const noteNames = [...pkg.names].filter((name) =>
    /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name),
  );
  assert.equal(slideNames.length, 3);
  assert.equal(noteNames.length, 3);
  assert.ok(
    ![...pkg.names].some(
      (name) => !name.endsWith("/") && /media\/|vba|embeddings\//i.test(name),
    ),
  );
  for (const [name, part] of pkg.parts)
    if (name.endsWith(".rels"))
      assert.doesNotMatch(part.toString(), /TargetMode="External"/);
  for (const name of slideNames) {
    const xml = pkg.parts.get(name)!.toString();
    assert.match(xml, /<p:sp>/);
    assert.doesNotMatch(xml, /<p:pic>/);
  }
  const noteXml = noteNames
    .map((name) => pkg.parts.get(name)!.toString())
    .join("\n");
  for (const expected of [
    "Zoë",
    "€240",
    "conditional on reviewer approval",
    "not confirmed",
    "No launch commitment",
    "artifact-revision",
    "source-revision",
    "ancestor-note",
    "ancestor-revision",
    "Unicode span",
    "Historical saved revision",
    "not independent corroboration",
    answer.coverageWarnings[0],
    answer.blocks[5].text,
  ])
    assert.ok(noteXml.includes(expected), expected);
  const extracted = await extractIsolated(bytes, "pptx");
  const text = extracted.sections.map((section) => section.text).join("\n");
  assert.match(text, /Zoë/);
  assert.match(text, /€240/);
  assert.match(text, /No launch commitment/);
  assert.match(text, /Evidence and export notes/);
});

test("PowerPoint fails authored, unavailable, missing-evidence, invalid and oversized exports", async () => {
  const answer = slideAnswer(passages[0]);
  for (const changed of [
    { ...revision, authored: true },
    { ...revision, available: false },
  ])
    await assert.rejects(
      exportPptx(answer.title, answer, resolve, changed),
      /available generated/,
    );
  await assert.rejects(
    exportPptx(answer.title, answer, () => null, revision),
    /evidence is unavailable/,
  );
  const invalid = structuredClone(answer);
  invalid.blocks[1].citations[0].end++;
  await assert.rejects(exportPptx(answer.title, invalid, resolve, revision));
  const oversized = structuredClone(answer);
  oversized.coverageWarnings = ["x".repeat(1024 * 1024)];
  await assert.rejects(
    exportPptx(answer.title, oversized, resolve, revision),
    /one MiB/,
  );
});

test("PowerPoint wraps words/graphemes readably and refuses dense overflow without dropping claims", async () => {
  const words = "Zoë proposes €240 conditional on reviewer approval";
  const lines = slideLines(words, 17, 2);
  assert.ok(lines.length > 1);
  assert.equal(lines.join(" "), words);
  const grapheme = "👩🏽‍🔬",
    token = grapheme.repeat(12);
  const emojiLines = slideLines(token, 17, 2);
  assert.equal(emojiLines.join(""), token);
  assert.ok(
    emojiLines.every((line) =>
      new RegExp(`^(?:${grapheme})+$`, "u").test(line),
    ),
  );
  const p = { ...passages[0], text: "W".repeat(160) };
  const citations = [{ passageId: p.id, quote: p.text, start: 0, end: 160 }];
  const answer: Answer = {
    kind: "slides",
    status: "answered",
    title: "Dense wide text",
    blocks: [
      { kind: "fact", text: "W", citations },
      ...Array.from({ length: 4 }, () => ({
        kind: "fact" as const,
        text: p.text,
        citations,
      })),
    ],
    coverageWarnings: [],
    slides: [
      {
        id: "dense",
        headlineBlockIndex: 0,
        bodyBlockIndexes: [1, 2, 3, 4],
        noteBlockIndexes: [],
      },
    ],
  };
  validateAnswer(answer, [p], "slides");
  await assert.rejects(
    exportPptx(answer.title, answer, () => p, revision),
    /does not fit/,
  );
  assert.equal(answer.blocks.length, 5);
  assert.equal(answer.blocks[4].text, p.text);
});

test("slides validate before atomic publication and retain history, retry identity, backup and purge behavior", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-slides-"));
  let store = new Store(path.join(root, "data"));
  try {
    const n = store.createNotebook("Slides").id,
      c = store.view(n).conversations[0].id;
    const bytes = Buffer.from(slideSourceText),
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
    const p = store.selectedPassages(n, c)[0];
    const run = store.createRun(
      n,
      c,
      "Present proposal",
      "slides",
      "fixture",
      "slides-first",
    );
    assert.equal(run.schema_version, OUTPUT_CONTRACT_VERSION);
    const bad = slideAnswer(p);
    bad.slides![0].bodyBlockIndexes = [];
    assert.throws(() => store.completeRun(run.id, bad));
    assert.equal(
      store.one("SELECT output FROM runs WHERE id=?", run.id).output,
      null,
    );
    assert.equal(store.view(n).artifacts.length, 0);
    assert.equal(store.completeRun(run.id, slideAnswer(p)), true);
    const saved = store.view(n).artifacts[0],
      original = saved.revision_id;
    const failed = store.createRun(
      n,
      c,
      "Retry",
      "slides",
      "fixture",
      "slides-fail",
    );
    store.run("UPDATE runs SET status='failed' WHERE id=?", failed.id);
    assert.throws(
      () =>
        store.createRun(
          n,
          c,
          "Retry",
          "summary",
          "fixture",
          "wrong",
          failed.id,
        ),
      /preserve its output kind/,
    );
    const retry = store.createRun(
      n,
      c,
      "Retry",
      "slides",
      "fixture",
      "slides-retry",
      failed.id,
    );
    assert.equal(
      store.createRun(
        n,
        c,
        "Retry",
        "slides",
        "fixture",
        "slides-retry",
        failed.id,
      ).id,
      retry.id,
    );
    store.run("UPDATE runs SET status='cancelled' WHERE id=?", retry.id);
    store.editArtifact(
      n,
      saved.id,
      "Authored proposal",
      documentText(saved.content) + "\nMy annotation.",
    );
    assert.equal(
      store.artifactRevision(n, saved.id, original).content.kind,
      "slides",
    );
    store.close();
    backup(path.join(root, "data"), path.join(root, "backup"));
    restore(path.join(root, "backup"), path.join(root, "restored"));
    store = new Store(path.join(root, "restored"));
    const old = store.artifactRevision(n, saved.id, original);
    validateAnswer(old.content, [p], "slides");
    await exportPptx(old.title, old.content, (id) => store.passage(n, id), {
      ...revision,
      revisionId: original,
    });
    store.purgeSource(n, p.sourceId);
    assert.equal(
      store.artifactRevision(n, saved.id, original).available,
      false,
    );
    assert.match(store.view(n).artifacts[0].content.text, /My annotation/);
    await assert.rejects(
      exportPptx(old.title, old.content, (id) => store.passage(n, id), {
        ...revision,
        available: false,
      }),
      /available generated/,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
