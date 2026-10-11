import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { digest, chunkText, validateAnswer } from "../src/domain/evidence.ts";

const [mode, resultPath, reviewPath] = process.argv.slice(2);
const RUBRIC_VERSION = 1;
const REVIEW_INSTRUCTIONS =
  "A human must review every factual or inferred atomic claim, including titles, notices and coverage warnings. Add one claims entry per atomic claim with text, supported, qualifiersPreserved, inferenceLabeled and rationale. Inspect full passages and relevant qualifiers, including both positions on conflicts. Mark complete only after all response components were inspected. Agent review must not be labeled human review. See evals/README.md.";
if (!["prepare", "check"].includes(mode) || !resultPath || !reviewPath)
  throw new Error(
    "Usage: npm run review -- prepare|check results.json review.json",
  );
const raw = readFileSync(resultPath);
const result = JSON.parse(raw.toString());
const corpus = JSON.parse(
  readFileSync("tests/fixtures/evaluation/corpus.json", "utf8"),
);
const corpusHash = digest(JSON.stringify(corpus));
if (
  result.corpusVersion !== corpus.version ||
  result.corpusHash !== corpusHash ||
  result.results.length !== corpus.questions.length
)
  throw new Error(
    "A complete matching evaluation corpus and content hash are required.",
  );
const passages = corpus.sources.flatMap((source: any) =>
  chunkText(source.text, source.id, "eval-v1-" + source.id, source.title),
);
const byPassage = new Map(
  passages.map((passage: any) => [passage.id, passage]),
);
const evidenceFor = (answer: any) =>
  answer.blocks.flatMap((block: any) =>
    block.citations.map((citation: any) => ({
      ...citation,
      passage: byPassage.get(citation.passageId),
    })),
  );
const nonblank = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim();
function validDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(value + "T00:00:00Z");
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
for (const question of corpus.questions) {
  const rows = result.results.filter((row: any) => row.id === question.id);
  if (
    rows.length !== 1 ||
    rows[0].status !== question.expectedStatus ||
    rows[0].question !== question.question ||
    rows[0].expectedStatus !== question.expectedStatus ||
    !rows[0].answer
  )
    throw new Error("Missing or failed answer: " + question.id);
  validateAnswer(rows[0].answer, passages, "answer");
}
if (mode === "prepare") {
  const packet = {
    format: 2,
    rubricVersion: RUBRIC_VERSION,
    corpusHash,
    resultHash: digest(raw),
    corpusVersion: corpus.version,
    model: result.model,
    runtime: result.runtime,
    reviewer: { name: "", kind: "", date: "" },
    instructions: REVIEW_INSTRUCTIONS,
    responses: corpus.questions.map((question: any) => {
      const row = result.results.find((row: any) => row.id === question.id);
      return {
        id: question.id,
        question: question.question,
        expected: question.expected ?? null,
        expectedStatus: question.expectedStatus,
        answer: row.answer,
        evidence: evidenceFor(row.answer),
        complete: false,
        claims: [],
        notes: "",
      };
    }),
  };
  mkdirSync(path.dirname(path.resolve(reviewPath)), { recursive: true });
  writeFileSync(reviewPath, JSON.stringify(packet, null, 2), { flag: "wx" });
  console.log("Prepared unreviewed packet: " + reviewPath);
} else {
  const review = JSON.parse(readFileSync(reviewPath, "utf8"));
  if (review.format !== 2 || review.rubricVersion !== RUBRIC_VERSION)
    throw new Error("Review format or human rubric version does not match.");
  if (
    review.resultHash !== digest(raw) ||
    review.corpusHash !== corpusHash ||
    review.corpusVersion !== corpus.version ||
    review.instructions !== REVIEW_INSTRUCTIONS ||
    review.model !== result.model ||
    review.runtime !== result.runtime
  )
    throw new Error("Review does not match these evaluation results.");
  if (
    review.reviewer?.kind !== "human" ||
    !nonblank(review.reviewer.name) ||
    !validDate(review.reviewer.date)
  )
    throw new Error(
      "A named, dated human review is required; agent review cannot satisfy this gate.",
    );
  if (
    !Array.isArray(review.responses) ||
    review.responses.length !== corpus.questions.length
  )
    throw new Error("Every response must be reviewed.");
  let total = 0,
    supported = 0;
  let abstentions = 0;
  for (const question of corpus.questions) {
    const rows = review.responses.filter((row: any) => row.id === question.id);
    if (
      rows.length !== 1 ||
      rows[0].complete !== true ||
      !Array.isArray(rows[0].claims)
    )
      throw new Error("Incomplete response review: " + question.id);
    const row = rows[0];
    const original = result.results.find(
      (answer: any) => answer.id === question.id,
    );
    if (JSON.stringify(row.answer) !== JSON.stringify(original.answer))
      throw new Error("Reviewed answer was changed: " + question.id);
    if (
      row.question !== question.question ||
      row.expectedStatus !== question.expectedStatus ||
      !isDeepStrictEqual(row.expected, question.expected ?? null) ||
      !isDeepStrictEqual(row.evidence, evidenceFor(original.answer))
    )
      throw new Error(
        "Reviewed question or evidence was changed: " + question.id,
      );
    if (question.expectedStatus === "answered" && !row.claims.length)
      throw new Error(
        "Answerable responses require atomic claim review: " + question.id,
      );
    let allSupported = true;
    for (const claim of row.claims) {
      if (
        !nonblank(claim.text) ||
        typeof claim.supported !== "boolean" ||
        typeof claim.qualifiersPreserved !== "boolean" ||
        typeof claim.inferenceLabeled !== "boolean" ||
        !nonblank(claim.rationale)
      )
        throw new Error("Incomplete claim judgment: " + question.id);
      const supportedClaim =
        claim.supported && claim.qualifiersPreserved && claim.inferenceLabeled;
      allSupported &&= supportedClaim;
      if (question.expectedStatus === "answered") {
        total++;
        if (supportedClaim) supported++;
      }
    }
    if (question.expectedStatus === "insufficient_evidence" && allSupported)
      abstentions++;
  }
  const fraction = total ? supported / total : 0;
  const passed = fraction >= 0.95 && abstentions >= 9;
  console.log(
    JSON.stringify(
      {
        reviewer: review.reviewer,
        totalClaims: total,
        supportedClaims: supported,
        supportFraction: fraction,
        abstentions,
        passed,
      },
      null,
      2,
    ),
  );
  if (!passed) process.exitCode = 1;
}
