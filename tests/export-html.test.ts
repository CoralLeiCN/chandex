import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { exportHtml, type ExportRevision } from "../src/domain/export-html.ts";
import { chunkText, type Answer } from "../src/domain/evidence.ts";
import { artifactSections } from "../src/domain/artifacts.ts";
import { authoredReferenceNotice, noteCitations } from "../src/domain/notes.ts";
import { richFixture } from "./fixtures/notes.ts";
import { studyAnswer } from "./fixtures/study.ts";
import { structuredAnswer } from "./fixtures/structured.ts";

const passage = chunkText(
    "Approval 😀 is still pending. Do not start.\nBudget £5 | month.",
    "source",
    "source-revision",
    "Meeting notes",
  )[0],
  citation = {
    passageId: passage.id,
    quote: passage.text,
    start: 0,
    end: Array.from(passage.text).length,
  },
  revision: ExportRevision = {
    revisionId: "saved-revision",
    created: "2026-10-10T12:00:00.000Z",
    authored: true,
    historical: false,
  };
function document(html: string) {
  const dom = new JSDOM(html, { runScripts: "dangerously" });
  return { dom, doc: dom.window.document };
}
test("portable HTML preserves rich structure and exact Unicode references while hostile markup stays literal", () => {
  const content = richFixture(citation),
    html = exportHtml(
      '<script>window.attack=1</script> & "title"',
      content,
      () => ({
        ...passage,
        origin: "https://example.org/report?a=1&b=2",
        derivation: {
          artifactId: "origin-note",
          revisionId: "origin-revision",
          origin: "user",
        },
      }),
      revision,
    ),
    { dom, doc } = document(html);
  try {
    assert.equal(doc.title, '<script>window.attack=1</script> & "title"');
    assert.equal(
      doc.querySelector("script,img,iframe,object,embed,link,form"),
      null,
    );
    assert.equal((dom.window as any).attack, undefined);
    assert.equal(doc.querySelector("article h2")!.textContent, "Research 🦉");
    assert.equal(
      doc.querySelector("em strong,strong em")!.textContent,
      "Conditional budget",
    );
    assert.equal(
      doc.querySelector("s u,u s")!.textContent,
      "<img src=x onerror=alert(1)> *literal*",
    );
    assert.equal(doc.querySelector("ol[start]")!.getAttribute("start"), "3");
    assert.equal(doc.querySelector("ol ul li")!.textContent, "Check approval");
    assert.equal(
      doc.querySelector("article blockquote")!.textContent,
      "Approval remains pending.",
    );
    assert.equal(
      doc.querySelector("pre code")!.textContent,
      "```\n<script>literal()</script>",
    );
    assert.equal(doc.querySelectorAll("article br").length, 1);
    assert.equal(doc.querySelectorAll("article hr").length, 1);
    assert.equal(
      doc.querySelector(".qualification")!.textContent,
      authoredReferenceNotice,
    );
    assert.equal(
      doc.querySelector(".evidence-quote")!.textContent,
      passage.text,
    );
    assert.match(
      doc.querySelector(".footnotes")!.textContent!,
      /source revision source-revision; Unicode span 0–/,
    );
    assert.match(
      doc.querySelector(".footnotes")!.textContent!,
      /note revision origin-revision; user origin/,
    );
    assert.match(
      doc.querySelector(".footnotes")!.textContent!,
      /not independent corroboration/,
    );
    for (const anchor of doc.querySelectorAll('a[href^="#"]'))
      assert.ok(doc.getElementById(anchor.getAttribute("href")!.slice(1)));
    assert.equal(
      doc
        .querySelector(".metadata")!
        .textContent!.includes(revision.revisionId),
      true,
    );
    assert.match(doc.querySelector("style")!.textContent!, /@media print/);
    const hash = createHash("sha256")
        .update(doc.querySelector("style")!.textContent!)
        .digest("base64"),
      policy = doc
        .querySelector('meta[http-equiv="Content-Security-Policy"]')!
        .getAttribute("content")!;
    assert.ok(policy.includes(`style-src 'sha256-${hash}'`));
    assert.ok(policy.includes("default-src 'none'"));
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
    for (const element of doc.querySelectorAll("*"))
      for (const attr of element.attributes)
        assert.doesNotMatch(attr.name, /^on/);
  } finally {
    dom.window.close();
  }
});
test("HTML covers every typed output, explicit gaps, inferences, labels, answers and coverage without learner attempts", () => {
  const base: Answer = {
    status: "answered",
    title: "Generated result",
    blocks: [
      { text: passage.text, kind: "inference", citations: [citation] },
      { text: "Approval is not confirmed.", kind: "notice", citations: [] },
    ],
    coverageWarnings: ["An entire section remains unread."],
    coverage: [
      {
        sourceId: passage.sourceId,
        revisionId: passage.revisionId,
        title: passage.title,
        readPassages: 1,
        totalPassages: 2,
        omittedSections: [
          { locator: "Final decision", unreadPassages: 1, totalPassages: 1 },
        ],
      },
    ],
  };
  const outputs = [
    base,
    ...Object.entries(artifactSections).map(
      ([kind, sections]) =>
        ({
          ...base,
          kind,
          sections: sections.map((section, index) => ({
            key: section.key,
            blockIndexes: index === 0 ? [0, 1] : [],
          })),
        }) as Answer,
    ),
    studyAnswer(passage, "flashcards"),
    studyAnswer(passage, "quiz"),
    structuredAnswer(passage, "mind-map"),
    structuredAnswer(passage, "data-table"),
  ];
  for (const content of outputs) {
    const html = exportHtml(content.title, content, () => passage, {
        ...revision,
        authored: false,
      }),
      { dom, doc } = document(html);
    try {
      assert.equal(
        doc.querySelectorAll(".footnotes li").length,
        noteCitations(content).length,
      );
      assert.match(
        doc.querySelector("article")!.textContent!,
        /Approval 😀 is still pending/,
      );
      assert.match(
        doc.querySelector(".qualification")!.textContent!,
        /Generated material/,
      );
      if (content === base || content.sections) {
        assert.match(doc.querySelector("article")!.textContent!, /Inference:/);
        assert.match(
          doc.querySelector("article")!.textContent!,
          /Evidence limitation:/,
        );
        assert.match(
          doc.querySelector("article")!.textContent!,
          /1 of 2 passages read/,
        );
        assert.match(
          doc.querySelector("article")!.textContent!,
          /Final decision: 1 of 1 passages not read/,
        );
      }
      if (content.kind === "quiz") {
        assert.match(
          doc.querySelector("article")!.textContent!,
          /Candidate answer \(distractor\)/,
        );
        assert.match(
          doc.querySelector("article")!.textContent!,
          /Correct answer:/,
        );
        assert.match(
          doc.querySelector("article")!.textContent!,
          /Explanation:/,
        );
        assert.equal(doc.querySelector("input,button,textarea,form"), null);
      }
      if (content.kind === "mind-map")
        assert.match(
          doc.querySelector("article")!.textContent!,
          /Relationship to Evidence: states/,
        );
      if (content.kind === "data-table") {
        assert.equal(doc.querySelectorAll('th[scope="col"]').length, 3);
        assert.equal(doc.querySelectorAll('th[scope="row"]').length, 1);
        assert.equal(doc.querySelector(".missing")!.textContent, "Not stated");
        assert.equal(
          doc
            .querySelector('[aria-label="Data table"]')!
            .getAttribute("tabindex"),
          "0",
        );
      }
    } finally {
      dom.window.close();
    }
  }
  const empty = {
    ...base,
    status: "insufficient_evidence" as const,
    blocks: [base.blocks[1]],
  };
  assert.match(
    exportHtml("Unavailable", empty, () => null, {
      ...revision,
      authored: false,
    }),
    /selected evidence was insufficient/,
  );
  for (const kind of [
    "mind-map",
    "data-table",
    "quiz",
    "flashcards",
  ] as const) {
    const { dom, doc } = document(
      exportHtml(
        "No supported content",
        {
          ...empty,
          kind,
          nodes: [],
          columns: [],
          rows: [],
          items: [],
        },
        () => null,
        { ...revision, authored: false },
      ),
    );
    try {
      assert.equal(doc.querySelectorAll(".block-notice").length, 1);
      assert.equal(doc.querySelectorAll("table,.footnotes").length, 0);
    } finally {
      dom.window.close();
    }
  }
  assert.match(
    exportHtml(
      "Legacy",
      { text: "Literal <script>text</script>\nSecond line" },
      () => null,
      { ...revision, historical: true, titleRecorded: false },
    ),
    /Historical title was not recorded/,
  );
});
test("missing, purged, foreign or mismatched evidence cannot be exported as a valid quote; unsafe origins never become links", () => {
  for (const resolve of [
    () => null,
    () => ({ ...passage, id: "foreign" }),
    () => ({ ...passage, text: "Different evidence" }),
  ]) {
    const { dom, doc } = document(
      exportHtml("Kept note", richFixture(citation), resolve, revision),
    );
    try {
      assert.match(
        doc.querySelector(".footnotes")!.textContent!,
        /Evidence unavailable/,
      );
      assert.equal(doc.querySelector(".evidence-quote"), null);
      assert.equal(
        doc.querySelector(".footnotes")!.textContent!.includes(passage.text),
        false,
      );
      assert.match(
        doc.querySelector(".reference a")!.getAttribute("aria-label")!,
        /unavailable/,
      );
    } finally {
      dom.window.close();
    }
  }
  const hostile = {
      ...passage,
      title: '<img src="https://attacker.example/leak">',
      locator: '<svg onload="attack()">',
      origin: "javascript:attack()",
    },
    { dom, doc } = document(
      exportHtml("Safe", richFixture(citation), () => hostile, revision),
    );
  try {
    assert.equal(doc.querySelector("img,svg,script"), null);
    assert.equal(doc.querySelector('.footnotes a[href^="javascript:"]'), null);
    assert.match(
      doc.querySelector(".footnotes")!.textContent!,
      /javascript:attack\(\)/,
    );
    assert.equal(
      doc.querySelector(".evidence-quote")!.textContent,
      passage.text,
    );
  } finally {
    dom.window.close();
  }
  assert.throws(
    () =>
      exportHtml(
        "Purged original",
        { text: "PRIVATE_PURGED_CANARY" },
        () => null,
        { ...revision, authored: false, available: false },
      ),
    /unavailable/,
  );
});
test("export validation and size failures never truncate an oversized or malformed document", () => {
  const malformed = richFixture();
  malformed.doc.content!.push({
    type: "img",
    attrs: { src: "https://attacker.example/leak" },
  });
  assert.throws(
    () => exportHtml("Unsafe", malformed, () => null, revision),
    /Invalid note node location/,
  );
  const unsafeLink = richFixture();
  unsafeLink.doc.content![1].content![3].marks![0].attrs!.href =
    "javascript:attack()";
  assert.throws(
    () => exportHtml("Unsafe link", unsafeLink, () => null, revision),
    /HTTP/,
  );
  assert.throws(
    () =>
      exportHtml(
        "Too large",
        { text: "&".repeat(1100000) },
        () => null,
        revision,
      ),
    /five MiB/,
  );
});
