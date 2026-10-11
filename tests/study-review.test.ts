import { studyReviewResult } from "./fixtures/evaluation-results.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { loadStudyCorpus } from "../scripts/study-corpus.ts";
import {
  prepareStudyReview,
  checkStudyReview,
} from "../scripts/study-review.ts";

const raw = studyReviewResult();
const corpus = loadStudyCorpus();
const prepare = () => prepareStudyReview(raw, corpus);
// Synthetic judgments only exercise the verifier. They are never saved as release evidence.
function judgedFixture() {
  const packet = prepare();
  packet.reviewer = {
    name: "Test fixture, not an actual reviewer",
    kind: "human",
    date: "2026-10-10",
  };
  for (const response of packet.responses) {
    response.complete = true;
    for (const component of response.components) {
      component.reviewed = true;
      component.factual = true;
      component.rationale = "Synthetic verifier fixture.";
      component.claims = [
        {
          text: component.text,
          supported: true,
          qualifiersPreserved: true,
          inferenceLabeled: true,
          rationale: "Synthetic verifier fixture.",
        },
      ];
    }
    for (const quiz of response.quizItems) {
      quiz.reviewed = true;
      quiz.correctOptionIds = [
        response.context.answer.items!.find((item) => item.id === quiz.id)!
          .correctOptionId!,
      ];
      quiz.candidatesClearlyLabeled = true;
      quiz.rationale = "Synthetic verifier fixture.";
    }
    response.sufficiency = {
      statusAppropriate: true,
      distinctItemsOnly: true,
      countLimitationClear: true,
      rationale: "Synthetic verifier fixture.",
    };
  }
  return packet;
}
test("study review preserves the versioned six-case corpus and cannot accept absent, stale or modified context", () => {
  const packet = prepare(),
    result = JSON.parse(raw.toString());
  assert.equal(corpus.hash, result.corpusHash);
  assert.equal(packet.responses.length, 6);
  assert.equal(packet.responses.flatMap((r) => r.quizItems).length, 6);
  assert.ok(
    packet.responses.every(
      (r) =>
        !r.complete &&
        r.components.every((c) => !c.reviewed && !c.claims.length),
    ),
  );
  const supported = packet.responses.find((r) => r.id === "quiz-supported")!;
  for (const item of supported.context.answer.items!)
    assert.deepEqual(
      supported.components.find((c) => c.id === `item:${item.id}:question`)!
        .citations,
      item.questionCitations,
    );
  const sparse = packet.responses.find((r) => r.id === "quiz-sparse")!;
  const front = sparse.components.find((c) => c.id.endsWith(":question"))!;
  assert.equal(front.citations.length, 1);
  assert.ok(
    sparse.context.passages.some((p) => p.id === front.citations[0].passageId),
  );
  assert.throws(
    () => checkStudyReview(raw, corpus, packet),
    /named, dated human/,
  );
  const mutate = (fn: (value: any) => void, pattern: RegExp) => {
    const fixture = judgedFixture();
    fn(fixture);
    assert.throws(() => checkStudyReview(raw, corpus, fixture), pattern);
  };
  mutate((p) => p.rubricVersion++, /rubric version/);
  mutate((p) => (p.model = "different"), /does not match/);
  mutate((p) => (p.requestedCount = 10), /does not match/);
  mutate((p) => (p.corpusDocumentHash = "changed"), /does not match/);
  mutate((p) => (p.reviewer.kind = "agent"), /named, dated human/);
  mutate((p) => (p.reviewer.date = "2026-02-30"), /named, dated human/);
  mutate(
    (p) => (p.responses[0].context.case.sources[0].text = "Changed source"),
    /changed study response/,
  );
  mutate(
    (p) => (p.responses[0].context.answer.title = "Changed title"),
    /changed study response/,
  );
  mutate(
    (p) => (p.responses[0].context.passages[0].text = "Changed passage"),
    /changed study response/,
  );
  mutate((p) => p.responses[0].components.pop(), /Every study component/);
  mutate(
    (p) => (p.responses[0].components[0].text = "Changed component"),
    /component review/,
  );
  mutate(
    (p) => (p.responses[0].components[0].claims[0].supported = null),
    /Incomplete atomic claim/,
  );
  mutate(
    (p) =>
      p.responses[0].components[0].claims.push(
        p.responses[0].components[0].claims[0],
      ),
    /Duplicate atomic claim/,
  );
  mutate(
    (p) => (p.responses[0].sufficiency.rationale = ""),
    /sufficiency judgment/,
  );
  const changed = structuredClone(result);
  changed.results[0].question = "Different question under the same ID";
  assert.throws(
    () => prepareStudyReview(Buffer.from(JSON.stringify(changed)), corpus),
    /changed or failed study case/,
  );
  changed.results[0].question = result.results[0].question;
  changed.results[0].sources[0].text = "Different source";
  assert.throws(
    () => prepareStudyReview(Buffer.from(JSON.stringify(changed)), corpus),
    /changed or failed study case/,
  );
  changed.results = result.results.slice(1);
  assert.throws(
    () => prepareStudyReview(Buffer.from(JSON.stringify(changed)), corpus),
    /Complete matching/,
  );
});

test("study review enforces claim support, both abstentions, every quiz key and sparse sufficiency", () => {
  const fixture = judgedFixture();
  const report = checkStudyReview(raw, corpus, fixture);
  assert.equal(report.passed, true);
  assert.equal(report.supportFraction, 1);
  assert.equal(report.abstentions, 2);
  assert.equal(report.unambiguousQuizItems, 6);
  const answeredClaims = fixture.responses
    .filter((r) => r.context.answer.status === "answered")
    .flatMap((r) => r.components.flatMap((c) => c.claims));
  answeredClaims[0].supported = false;
  assert.equal(checkStudyReview(raw, corpus, fixture).passed, true);
  for (const claim of answeredClaims.slice(
    0,
    Math.ceil(report.totalClaims * 0.06),
  ))
    claim.qualifiersPreserved = false;
  assert.equal(checkStudyReview(raw, corpus, fixture).passed, false);
  const inference = judgedFixture();
  inference.responses
    .flatMap((r) => r.components)
    .flatMap((c) => c.claims)
    .forEach((claim) => (claim.inferenceLabeled = false));
  assert.equal(checkStudyReview(raw, corpus, inference).passed, false);
  const abstention = judgedFixture();
  abstention.responses.find(
    (r) => r.context.answer.status === "insufficient_evidence",
  )!.components[0].claims[0].supported = false;
  const abstentionReport = checkStudyReview(raw, corpus, abstention);
  assert.ok(abstentionReport.supportFraction >= 0.95);
  assert.equal(abstentionReport.passed, false);
  for (const scenario of ["ambiguous", "wrong-key", "unlabeled", "missing"]) {
    const quiz = judgedFixture(),
      response = quiz.responses.find((r) => r.id === "quiz-supported")!;
    const judgment = response.quizItems[0],
      item = response.context.answer.items![0];
    const wrong = item.options!.find((o) => o.id !== item.correctOptionId)!.id;
    if (scenario === "ambiguous") judgment.correctOptionIds.push(wrong);
    if (scenario === "wrong-key") judgment.correctOptionIds = [wrong];
    if (scenario === "unlabeled") judgment.candidatesClearlyLabeled = false;
    if (scenario === "missing") {
      response.quizItems.pop();
      assert.throws(
        () => checkStudyReview(raw, corpus, quiz),
        /Every quiz item/,
      );
    } else assert.equal(checkStudyReview(raw, corpus, quiz).passed, false);
  }
  const sparse = judgedFixture();
  sparse.responses.find(
    (r) => r.id === "quiz-sparse",
  )!.sufficiency.distinctItemsOnly = false;
  assert.equal(checkStudyReview(raw, corpus, sparse).passed, false);
  const omitted = judgedFixture();
  const block = omitted.responses
    .flatMap((r) => r.components)
    .find((c) => c.requiresClaims)!;
  block.factual = false;
  block.claims = [];
  assert.throws(
    () => checkStudyReview(raw, corpus, omitted),
    /component review/,
  );
});

test("study review CLI prepares without overwriting and refuses an unreviewed packet", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-study-review-"));
  const reviewPath = path.join(root, "packet.json");
  const resultPath = path.join(root, "result.json");
  writeFileSync(resultPath, raw);
  const run = (mode: string) =>
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/review-study.ts",
        mode,
        resultPath,
        reviewPath,
      ],
      { encoding: "utf8", stdio: "pipe" },
    );
  try {
    run("prepare");
    const saved = readFileSync(reviewPath, "utf8");
    assert.throws(
      () => run("prepare"),
      (error: any) => /EEXIST/.test(String(error.stderr)),
    );
    assert.equal(readFileSync(reviewPath, "utf8"), saved);
    assert.throws(
      () => run("check"),
      (error: any) => /named, dated human/.test(String(error.stderr)),
    );
    // Corpus changes under the same version must break the original hash.
    const corpusPath = path.join(root, "corpus.json"),
      changed = JSON.parse(
        readFileSync("tests/fixtures/evaluation/study-corpus.json", "utf8"),
      );
    changed.cases[0].sources[0].text += " Altered qualifier.";
    writeFileSync(corpusPath, JSON.stringify(changed));
    assert.throws(
      () => prepareStudyReview(raw, loadStudyCorpus(corpusPath)),
      /Complete matching/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
