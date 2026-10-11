import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadImage } from "@napi-rs/canvas";
import { JSDOM } from "jsdom";
import {
  chunkText,
  validateAnswer,
  modelOutputSchema,
  type Answer,
} from "../src/domain/evidence.ts";
import {
  exportInfographic,
  infographicLines,
} from "../src/domain/export-infographic.ts";
import { exportMarkdown } from "../src/domain/export.ts";
import { exportHtml } from "../src/domain/export-html.ts";
import { documentText } from "../src/domain/artifacts.ts";
import { imageDimensions } from "../src/ingestion/ocr.ts";
import { extract } from "../src/ingestion/extract.ts";
import { Store } from "../src/storage/store.ts";
import { backup, restore } from "../src/storage/backup.ts";
import {
  infographicAnswer,
  infographicSourceText,
} from "./fixtures/infographic.ts";
const p = chunkText(
    infographicSourceText,
    "source",
    "source-revision",
    "Proposal",
  )[0],
  revision = {
    revisionId: "artifact-revision",
    created: "2026-10-10T21:00:00Z",
    authored: false,
    historical: true,
    available: true,
  };
const resolve = () => ({
  ...p,
  derivation: {
    artifactId: "ancestor-note",
    revisionId: "ancestor-revision",
    origin: "authored",
  },
});
export function pngMetadata(bytes: Buffer) {
  imageDimensions(bytes); // Validates every CRC, bounds and exact termination.
  let offset = 8;
  while (offset < bytes.length) {
    const size = bytes.readUInt32BE(offset),
      type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "iTXt") {
      const data = bytes.subarray(offset + 8, offset + 8 + size),
        separator = data.indexOf(0);
      if (data.toString("ascii", 0, separator) === "Codeboom provenance") {
        assert.equal(data[separator + 1], 0);
        assert.equal(data[separator + 2], 0);
        const langEnd = data.indexOf(0, separator + 3),
          translatedEnd = data.indexOf(0, langEnd + 1);
        assert.equal(data.toString("ascii", separator + 3, langEnd), "en");
        return JSON.parse(data.toString("utf8", translatedEnd + 1));
      }
    }
    offset += size + 12;
  }
  throw Error("Missing PNG provenance");
}
test("infographics require exclusive, bounded, exact card ownership and supported steps", () => {
  assert.equal(
    validateAnswer(infographicAnswer(p), [p], "infographic").kind,
    "infographic",
  );
  assert.deepEqual(
    (modelOutputSchema("infographic").properties as any).kind.enum,
    ["infographic"],
  );
  const mutations: ((a: Answer) => void)[] = [
    (a) => {
      a.infographic!.cards[1].id = "approval";
    },
    (a) => {
      a.infographic!.cards[1].bodyBlockIndexes = [1];
    },
    (a) => {
      a.infographic!.cards[0].bodyBlockIndexes = [1];
    },
    (a) => {
      a.blocks[0].text = "x".repeat(71);
    },
    (a) => {
      a.blocks[1].text = "x".repeat(161);
    },
    (a) => {
      a.blocks[0].text = "bad\nclaim";
    },
    (a) => {
      a.blocks[1].citations = [];
    },
    (a) => {
      a.blocks[1].citations[0].quote = "changed";
    },
    (a) => {
      a.sections = [];
    },
    (a) => {
      a.slides = [];
    },
    (a) => {
      a.infographic!.cards.push(a.infographic!.cards[0]);
      a.infographic!.layout = "comparison";
    },
    (a) => {
      a.infographic!.layout = "steps";
    },
    (a) => {
      a.infographic!.orderBlockIndex = 2;
    },
    (a) => {
      a.blocks[0].citations = Array(5).fill(a.blocks[0].citations[0]);
    },
  ];
  for (const mutate of mutations) {
    const a = infographicAnswer(p);
    mutate(a);
    assert.throws(() => validateAnswer(a, [p], "infographic"));
  }
  const steps = infographicAnswer(p);
  steps.infographic!.layout = "steps";
  steps.infographic!.orderBlockIndex = steps.blocks.length;
  steps.blocks.push({
    kind: "fact",
    text: "First record, then ask the reviewer; schedule only after approval.",
    citations: structuredClone(steps.blocks[0].citations),
  });
  validateAnswer(steps, [p], "infographic");
  steps.blocks.at(-1)!.kind = "inference";
  assert.throws(() => validateAnswer(steps, [p]), /factual order/);
  assert.throws(
    () => validateAnswer(infographicAnswer(p), [p], "answer"),
    /chat answer/,
  );
});
test("sparse and insufficient infographic evidence remains explicit without filling cards", async () => {
  const a = infographicAnswer(p);
  a.infographic!.cards = a.infographic!.cards.slice(0, 1);
  a.blocks = a.blocks.slice(0, 3);
  validateAnswer(a, [p], "infographic");
  a.status = "insufficient_evidence";
  a.blocks = [
    {
      kind: "notice",
      text: "No selected evidence answers the request.",
      citations: [],
    },
  ];
  a.infographic!.cards = [];
  a.infographic!.layout = "comparison";
  validateAnswer(a, [], "infographic");
  assert.ok(!documentText(a).includes("No supported content"));
  await assert.rejects(
    exportInfographic(a.title, a, resolve, revision, "png"),
    /available generated/,
  );
});
test("SVG is inert and complete; native PNG is decodable with CRC-checked Unicode citation ancestry", async () => {
  const a = infographicAnswer(p);
  a.title = 'Proposal <script>alert("x")</script> & Zoë';
  const svg = await exportInfographic(a.title, a, resolve, revision, "svg"),
    dom = new JSDOM(svg.toString(), { contentType: "image/svg+xml" });
  assert.equal(
    dom.window.document.querySelector(
      "script, foreignObject, image, use, a, style",
    ),
    null,
  );
  assert.ok(
    [...dom.window.document.querySelectorAll("*")].every((e) =>
      [...e.attributes].every(
        (x) => !x.name.startsWith("on") && !/href/iu.test(x.name),
      ),
    ),
  );
  assert.ok(
    dom.window.document
      .querySelector("title")!
      .textContent!.includes("<script>"),
  );
  const metadata = JSON.parse(
    dom.window.document.querySelector("metadata")!.textContent!,
  );
  assert.equal(metadata.references[0].citation.quote, p.text);
  assert.equal(
    metadata.references[0].derivation.revisionId,
    "ancestor-revision",
  );
  assert.equal(metadata.revision.revisionId, revision.revisionId);
  assert.deepEqual(metadata.content, a);
  const bytes = await exportInfographic(a.title, a, resolve, revision, "png"),
    dimensions = imageDimensions(bytes),
    image = await loadImage(bytes);
  assert.equal(image.width, 1200);
  assert.equal(image.height, dimensions.height);
  const svgImage = await loadImage(svg);
  assert.equal(svgImage.width, image.width);
  assert.equal(svgImage.height, image.height);
  assert.ok(image.height <= 4000);
  assert.ok(bytes.length < 8 * 1024 * 1024);
  assert.deepEqual(pngMetadata(bytes), metadata);
  const unusualEvidence = { ...p, text: p.text + "\ufffe" },
    unusual = infographicAnswer(unusualEvidence);
  const unusualSvg = await exportInfographic(
    unusual.title,
    unusual,
    () => unusualEvidence,
    revision,
    "svg",
  );
  const unusualDom = new JSDOM(unusualSvg.toString(), {
    contentType: "image/svg+xml",
  });
  assert.equal(
    JSON.parse(
      unusualDom.window.document.querySelector("metadata")!.textContent!,
    ).references[0].citation.quote,
    unusualEvidence.text,
  );
  unusualDom.window.close();
  const visible = [...dom.window.document.querySelectorAll("text")]
    .map((e) => e.textContent)
    .join(" ");
  assert.match(visible, /€240/);
  assert.match(visible, /not an approved budget/);
  assert.match(visible, /Inference:/);
  assert.match(visible, /Derived note evidence/);
  assert.equal(
    dom.window.document.querySelectorAll('rect[width="540"]').length,
    2,
    "comparison/card rows keep equal area",
  );
  dom.window.close();
});
test("image export preserves readable words/graphemes and refuses unsafe, unavailable or excessive content", async () => {
  const lines = infographicLines("ordinary words stay together", 22, 180);
  assert.equal(lines.join(" "), "ordinary words stay together");
  const combined = "e\u0301".repeat(120);
  assert.equal(infographicLines(combined, 22, 60).join(""), combined);
  assert.ok(
    infographicLines(combined, 22, 60).every((s) => !s.startsWith("\u0301")),
  );
  assert.throws(() => infographicLines("bad\u0000text", 22, 400));
  assert.throws(() => infographicLines("\ud800", 22, 400));
  const a = infographicAnswer(p);
  await assert.rejects(
    exportInfographic(a.title, a, () => null, revision, "png"),
    /evidence/,
  );
  for (const flags of [{ authored: true }, { available: false }])
    await assert.rejects(
      exportInfographic(a.title, a, resolve, { ...revision, ...flags }, "svg"),
      /available generated/,
    );
  a.coverageWarnings = Array(50).fill(
    "Important unresolved limitation. ".repeat(30),
  );
  validateAnswer(a, [p], "infographic");
  await assert.rejects(
    exportInfographic(a.title, a, resolve, revision, "png"),
    /does not fit/,
  );
});
test("readable exports retain infographic groups, limitations, exact quotes and promotion ancestry", () => {
  const a = infographicAnswer(p),
    md = exportMarkdown(a.title, a, resolve),
    html = exportHtml(a.title, a, resolve, revision),
    text = documentText(a);
  for (const value of [md, html, text]) {
    assert.match(value, /conditional on reviewer approval/);
    assert.match(value, /not an approved budget/);
    assert.match(value, /Inference:/);
  }
  assert.match(md, /ancestor-note/);
  assert.match(html, /ancestor-revision/);
  a.infographic!.layout = "steps";
  a.infographic!.orderBlockIndex = a.blocks.length;
  a.blocks.push({
    ...a.blocks[0],
    text: "First record, then ask; schedule only after approval.",
  });
  assert.ok(
    documentText(a).indexOf("Source-supported order") <
      documentText(a).indexOf("Step 1"),
  );
});
test("infographics validate atomically and retain retry identity, backup/history and purge boundaries", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-info-"));
  let store = new Store(path.join(root, "data"));
  try {
    const n = store.createNotebook("Infographic").id,
      c = store.view(n).conversations[0].id,
      job = store.beginImport(n, "Proposal", "seed"),
      bytes = Buffer.from(infographicSourceText);
    store.publishImport(
      n,
      job.id,
      "Proposal",
      "text",
      null,
      bytes,
      await extract(bytes, "text"),
    );
    const source = store.selectedPassages(n, c)[0];
    const run = store.createRun(
        n,
        c,
        "Visualize",
        "infographic",
        "fixture",
        "seed-run",
      ),
      bad = infographicAnswer(source);
    bad.infographic!.cards[0].bodyBlockIndexes = [];
    assert.throws(() => store.completeRun(run.id, bad));
    assert.equal(store.view(n).artifacts.length, 0);
    assert.equal(
      store.one("SELECT output FROM runs WHERE id=?", run.id).output,
      null,
    );
    assert.equal(store.completeRun(run.id, infographicAnswer(source)), true);
    const saved = store.view(n).artifacts[0],
      original = saved.revision_id;
    const failed = store.createRun(
      n,
      c,
      "Retry",
      "infographic",
      "fixture",
      "fail",
    );
    store.run("UPDATE runs SET status='failed' WHERE id=?", failed.id);
    assert.throws(
      () =>
        store.createRun(n, c, "Retry", "slides", "fixture", "wrong", failed.id),
      /preserve its output kind/,
    );
    const retried = store.createRun(
      n,
      c,
      "Retry",
      "infographic",
      "fixture",
      "retry",
      failed.id,
    );
    assert.equal(
      store.createRun(
        n,
        c,
        "Retry",
        "infographic",
        "fixture",
        "retry",
        failed.id,
      ).id,
      retried.id,
    );
    store.run("UPDATE runs SET status='cancelled' WHERE id=?", retried.id);
    store.editArtifact(
      n,
      saved.id,
      "My annotation",
      documentText(saved.content) + "\nMy annotation.",
    );
    store.close();
    backup(path.join(root, "data"), path.join(root, "backup"));
    restore(path.join(root, "backup"), path.join(root, "restored"));
    store = new Store(path.join(root, "restored"));
    const historical = store.artifactRevision(n, saved.id, original);
    validateAnswer(historical.content, [source], "infographic");
    await exportInfographic(
      historical.title,
      historical.content,
      (id) => store.passage(n, id),
      { ...revision, revisionId: original },
      "png",
    );
    store.purgeSource(n, source.sourceId);
    assert.equal(
      store.artifactRevision(n, saved.id, original).available,
      false,
    );
    assert.match(store.view(n).artifacts[0].content.text, /My annotation/);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
