import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  chunkText,
  validateAnswer,
  modelOutputSchema,
  type Answer,
} from "../src/domain/evidence.ts";
import { studyCount } from "../src/domain/study.ts";
import { documentText } from "../src/domain/artifacts.ts";
import { exportMarkdown } from "../src/domain/export.ts";
import { Store } from "../src/storage/store.ts";
import { extract } from "../src/ingestion/extract.ts";
import { backup, restore } from "../src/storage/backup.ts";
import { NotebookService } from "../src/server/service.ts";
import { studyAnswer } from "./fixtures/study.ts";
const passages = chunkText("SQLite is proposed 🦉.", "s", "r", "Source");
test("study material requires distinct bounded items, cited answers and complete block ownership", () => {
  for (const kind of ["flashcards", "quiz"] as const) {
    const answer = studyAnswer(passages[0], kind);
    assert.equal(validateAnswer(answer, passages, kind, 5), answer);
    assert.ok(modelOutputSchema(kind).required.includes("items" as never));
    const invalid: ((a: Answer) => void)[] = [
      (a) => {
        a.items!.push(structuredClone(a.items![0]));
      },
      (a) => {
        a.items![0].question = "  ";
      },
      (a) => {
        a.items![0].answerBlockIndexes = [50];
      },
      (a) => {
        a.blocks.push(structuredClone(a.blocks[0]));
      },
      (a) => {
        a.items![0].questionCitations[0].passageId = "foreign";
      },
      (a) => {
        a.items![0].questionCitations[0].start = 1;
      },
      (a) => {
        a.coverageWarnings = [];
      },
      (a) => {
        a.status = "insufficient_evidence";
      },
    ];
    for (const change of invalid) {
      const bad = structuredClone(answer);
      change(bad);
      assert.throws(() => validateAnswer(bad, passages, kind, 5));
    }
    assert.throws(() => validateAnswer(answer, passages, "answer"));
  }
  for (const count of [0, 4, 21, NaN, "10", 10.5, null])
    assert.throws(() => studyCount(count));
  assert.equal(studyCount(), 10);
});
test("quiz keys require one distinct candidate matching a cited factual answer", () => {
  const valid = studyAnswer(passages[0], "quiz");
  const invalid: ((a: Answer) => void)[] = [
    (a) => {
      a.items![0].correctOptionId = "missing";
    },
    (a) => {
      a.items![0].options![0].text = "Uncited answer";
    },
    (a) => {
      a.items![0].options![1].id = "correct";
    },
    (a) => {
      a.items![0].options![1].text =
        " " + a.items![0].options![0].text.toUpperCase() + " ";
    },
    (a) => {
      a.items![0].explanationBlockIndexes = [0];
    },
    (a) => {
      delete a.items![0].options;
    },
    (a) => {
      a.blocks[0].kind = "inference";
    },
  ];
  for (const change of invalid) {
    const bad = structuredClone(valid);
    change(bad);
    assert.throws(() => validateAnswer(bad, passages, "quiz", 5));
  }
  const gap: Answer = {
    kind: "quiz",
    status: "insufficient_evidence",
    title: "Gap",
    blocks: [{ kind: "notice", text: "Missing evidence", citations: [] }],
    items: [],
    coverageWarnings: [],
  };
  assert.equal(validateAnswer(gap, passages, "quiz", 5), gap);
});
test("study exports retain question/answer evidence and label distractors; promotion omits distractors", () => {
  const answer = studyAnswer(passages[0], "quiz");
  const markdown = exportMarkdown(
    answer.title,
    answer,
    (id) => passages.find((p) => p.id === id) ?? null,
  );
  assert.match(markdown, /Candidate answer \(distractor\)/);
  assert.match(markdown, /Correct answer: SQLite/);
  assert.match(markdown, /Explanation:/);
  assert.match(markdown, /revision r/);
  assert.match(markdown, /Which statement.*\[\^1\]/);
  assert.match(documentText(answer, true), /Candidate answer \(distractor\)/);
  const promoted = documentText(answer);
  assert.match(promoted, /Which statement/);
  assert.match(promoted, /SQLite/);
  assert.doesNotMatch(promoted, /distractor|candidate answer absent/);
  assert.doesNotMatch(
    documentText(studyAnswer(passages[0], "flashcards")),
    /No supported content/,
  );
});
async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-study-"));
  const store = new Store(path.join(root, "data"));
  const n = store.createNotebook("Study").id,
    c = store.view(n).conversations[0].id;
  const bytes = Buffer.from(passages[0].text);
  const source = store.publishImport(
    n,
    store.beginImport(n, "Evidence", "import").id,
    "Evidence",
    "text",
    null,
    bytes,
    await extract(bytes, "text"),
  );
  return { root, store, n, c, source, p: store.selectedPassages(n, c)[0] };
}
test("quiz attempts are local, scoped, immutable on submit, pinned through edits and durable in backups", async () => {
  const f = await fixture();
  let store = f.store;
  try {
    const run = store.createRun(
      f.n,
      f.c,
      "Quiz",
      "quiz",
      "fixture",
      "quiz-run",
      undefined,
      5,
    );
    store.completeRun(run.id, studyAnswer(f.p, "quiz"));
    const artifact = store.view(f.n).artifacts[0],
      rev = artifact.revision_id;
    const forged = studyAnswer(f.p, "quiz");
    forged.title = "Changed content without an originating run";
    const bad = store.saveArtifact(
      f.n,
      forged.title,
      "quiz",
      JSON.stringify(forged),
      false,
      run.id,
    );
    const badRevision = store.one(
      "SELECT id FROM artifact_revisions WHERE artifact_id=?",
      bad,
    ).id;
    assert.throws(() =>
      store.startQuizAttempt(f.n, bad, badRevision, "forged-origin"),
    );
    store.run("DELETE FROM artifacts WHERE id=?", bad);
    const attempt = store.startQuizAttempt(f.n, artifact.id, rev, "attempt-1");
    assert.equal(
      store.startQuizAttempt(f.n, artifact.id, rev, "attempt-1").id,
      attempt.id,
    );
    assert.throws(() =>
      store.startQuizAttempt(
        store.createNotebook("Other").id,
        artifact.id,
        rev,
        "foreign",
      ),
    );
    assert.throws(() =>
      store.saveQuizAnswers(f.n, artifact.id, attempt.id, {
        "foreign-item": "correct",
      }),
    );
    assert.throws(() =>
      store.saveQuizAnswers(f.n, artifact.id, attempt.id, {
        "item-1": "foreign-option",
      }),
    );
    assert.throws(() =>
      store.saveQuizAnswers(f.n, artifact.id, attempt.id, {}, true),
    );
    const draft = store.saveQuizAnswers(f.n, artifact.id, attempt.id, {
      "item-1": "wrong",
    });
    assert.equal(draft.score, null);
    const submitted = store.saveQuizAnswers(
      f.n,
      artifact.id,
      attempt.id,
      { "item-1": "wrong" },
      true,
    );
    assert.equal(submitted.score, 0);
    assert.deepEqual(
      store.saveQuizAnswers(
        f.n,
        artifact.id,
        attempt.id,
        { "item-1": "wrong" },
        true,
      ),
      submitted,
    );
    assert.throws(() =>
      store.saveQuizAnswers(
        f.n,
        artifact.id,
        attempt.id,
        { "item-1": "correct" },
        true,
      ),
    );
    const second = store.startQuizAttempt(f.n, artifact.id, rev, "attempt-2");
    assert.equal(
      store.saveQuizAnswers(
        f.n,
        artifact.id,
        second.id,
        { "item-1": "correct" },
        true,
      ).score,
      1,
    );
    store.editArtifact(f.n, artifact.id, "Edited note", "Authored quiz text");
    assert.throws(() =>
      store.startQuizAttempt(
        f.n,
        artifact.id,
        store.view(f.n).artifacts[0].revision_id,
        "edited",
      ),
    );
    assert.equal(store.quizRevision(f.n, artifact.id, rev).kind, "quiz");
    store.close();
    backup(path.join(f.root, "data"), path.join(f.root, "backup"));
    restore(path.join(f.root, "backup"), path.join(f.root, "restored"));
    store = new Store(path.join(f.root, "restored"));
    assert.equal(store.view(f.n).quizAttempts.length, 2);
    assert.equal(store.view(f.n).quizAttempts[1].score, 1);
    assert.equal(store.view(f.n).quizAttempts[1].revision_id, rev);
    store.purgeSource(f.n, f.source);
    assert.equal(store.view(f.n).quizAttempts.length, 0);
    assert.throws(() => store.quizRevision(f.n, artifact.id, rev));
    assert.match(
      store.view(f.n).artifacts[0].content.text,
      /Authored quiz text/,
    );
  } finally {
    if (store.db.isOpen) store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test("study generation forwards the captured count and refuses invalid material atomically", async () => {
  const f = await fixture();
  let calls = 0;
  const service = new NotebookService(f.store, {
    status: async () => ({
      available: true,
      authenticated: true,
      version: "0.161.0",
      models: [],
    }),
    run: async (options) => {
      calls++;
      assert.equal(options.itemCount, 5);
      return studyAnswer(options.passages[0], "flashcards");
    },
  });
  try {
    assert.throws(() =>
      f.store.createRun(
        f.n,
        f.c,
        "Quiz",
        "quiz",
        "",
        "bad-count",
        undefined,
        4,
      ),
    );
    const run = f.store.createRun(
      f.n,
      f.c,
      "Study",
      "flashcards",
      "fixture",
      "study-run",
      undefined,
      5,
    );
    await service.execute(run.id);
    assert.equal(calls, 1);
    assert.equal(f.store.view(f.n).runs[0].status, "completed");
    assert.equal(f.store.view(f.n).artifacts[0].content.kind, "flashcards");
    const failed = f.store.createRun(
      f.n,
      f.c,
      "Quiz",
      "quiz",
      "fixture",
      "failed",
      undefined,
      5,
    );
    f.store.run("UPDATE runs SET status='failed' WHERE id=?", failed.id);
    assert.throws(() =>
      f.store.createRun(
        f.n,
        f.c,
        "Retry",
        "quiz",
        "fixture",
        "wrong-count",
        failed.id,
        10,
      ),
    );
    const retry = f.store.createRun(
      f.n,
      f.c,
      "Retry",
      "quiz",
      "fixture",
      "retry",
      failed.id,
    );
    assert.equal(retry.study_count, 5);
    const bad = studyAnswer(f.p, "quiz");
    bad.items![0].correctOptionId = "forged";
    assert.throws(() => f.store.completeRun(retry.id, bad));
    assert.equal(f.store.view(f.n).artifacts.length, 1);
    assert.equal(
      f.store.one("SELECT output FROM runs WHERE id=?", retry.id).output,
      null,
    );
  } finally {
    service.shutdown();
    f.store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
