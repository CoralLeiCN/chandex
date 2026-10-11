import {
  digest,
  validateAnswer,
  type Answer,
  type Citation,
} from "../src/domain/evidence.ts";
import {
  loadStudyCorpus,
  studyPassages,
  type StudyCase,
} from "./study-corpus.ts";

const FORMAT = 1,
  RUBRIC = 1;
type Corpus = ReturnType<typeof loadStudyCorpus>;
interface Claim {
  text: string;
  supported: boolean | null;
  qualifiersPreserved: boolean | null;
  inferenceLabeled: boolean | null;
  rationale: string;
}
interface Component {
  id: string;
  text: string;
  citations: Citation[];
  requiresClaims: boolean;
  reviewed: boolean;
  factual: boolean | null;
  rationale: string;
  claims: Claim[];
}
function components(answer: Answer): Component[] {
  const rows: Component[] = [];
  const add = (
    id: string,
    text: string,
    citations: Citation[] = [],
    requiresClaims = false,
  ) =>
    rows.push({
      id,
      text,
      citations,
      requiresClaims,
      reviewed: false,
      factual: requiresClaims ? true : null,
      rationale: "",
      claims: [],
    });
  add("title", answer.title);
  for (const item of answer.items ?? [])
    add(`item:${item.id}:question`, item.question, item.questionCitations);
  answer.blocks.forEach((block, i) =>
    add(`block:${i}`, block.text, block.citations, block.kind !== "notice"),
  );
  answer.coverageWarnings.forEach((warning, i) => add(`warning:${i}`, warning));
  (answer.coverage ?? []).forEach((coverage, i) =>
    add(`coverage:${i}`, JSON.stringify(coverage)),
  );
  return rows;
}
function checkedRows(raw: Buffer, corpus: Corpus) {
  const result = JSON.parse(raw.toString());
  if (
    result.corpusVersion !== corpus.version ||
    result.corpusHash !== corpus.hash ||
    (result.requestedCount !== undefined &&
      result.requestedCount !== corpus.requestedCount) ||
    ![4, 5, 6].includes(result.outputContractVersion) ||
    result.toolContractVersion !== 4 ||
    typeof result.model !== "string" ||
    !result.model.trim() ||
    typeof result.runtime !== "string" ||
    !result.runtime.trim() ||
    !Array.isArray(result.results) ||
    result.results.length !== corpus.cases.length
  )
    throw new Error(
      "Complete matching study corpus, contracts, count and runtime metadata are required.",
    );
  const rows = corpus.cases.map((item) => {
    const matches = result.results.filter((row: any) => row.id === item.id);
    const row = matches[0];
    if (
      matches.length !== 1 ||
      row.error ||
      !row.answer ||
      JSON.stringify(caseFields(row)) !== JSON.stringify(item)
    )
      throw new Error("Missing, changed or failed study case: " + item.id);
    const answer: Answer = row.answer;
    const passages = studyPassages(item, corpus.version);
    validateAnswer(answer, passages, item.kind, corpus.requestedCount);
    if (
      answer.status !== item.expectedStatus ||
      (item.id.endsWith("-sparse") &&
        (answer.items!.length !== 1 || !answer.coverageWarnings.length))
    )
      throw new Error("Study evidence sufficiency failed: " + item.id);
    return { item, answer, passages };
  });
  return { result, rows };
}
function caseFields(row: StudyCase): StudyCase {
  return {
    id: row.id,
    kind: row.kind,
    expectedStatus: row.expectedStatus,
    sources: row.sources,
    question: row.question,
  };
}
export function prepareStudyReview(raw: Buffer, corpus: Corpus) {
  const { result, rows } = checkedRows(raw, corpus);
  return {
    format: FORMAT,
    rubricVersion: RUBRIC,
    corpusVersion: corpus.version,
    corpusHash: corpus.hash,
    corpusDocumentHash: corpus.documentHash,
    resultHash: digest(raw),
    requestedCount: corpus.requestedCount,
    outputContractVersion: result.outputContractVersion,
    toolContractVersion: result.toolContractVersion,
    model: result.model,
    runtime: result.runtime,
    reviewer: { name: "", kind: "", date: "" },
    instructions:
      "Named human review only. Inspect every component against full selected passages, including qualifications and conflicts. For each component mark reviewed, decide whether it contains factual or inferred claims, supply a rationale, and enter every atomic claim. Supported answer/explanation blocks require claims. For each quiz item inspect all candidate options and record all options that could correctly answer the question; exactly the stored key must be correct. Confirm candidates are clearly labeled. Inspect evidence sufficiency and distinctness, including sparse limitations and abstentions. Do not relabel agent review as human review. See evals/README.md.",
    responses: rows.map(({ item, answer, passages }) => ({
      id: item.id,
      // Entire immutable review context is compared again during checking.
      context: { case: structuredClone(item), answer, passages },
      complete: false,
      components: components(answer),
      quizItems: (answer.kind === "quiz" ? (answer.items ?? []) : []).map(
        (q) => ({
          id: q.id,
          reviewed: false,
          correctOptionIds: [] as string[],
          candidatesClearlyLabeled: null as boolean | null,
          rationale: "",
        }),
      ),
      sufficiency: {
        statusAppropriate: null as boolean | null,
        distinctItemsOnly: null as boolean | null,
        countLimitationClear: null as boolean | null,
        rationale: "",
      },
      notes: "",
    })),
  };
}
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
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
export function checkStudyReview(raw: Buffer, corpus: Corpus, review: any) {
  const expected = prepareStudyReview(raw, corpus);
  if (review.format !== FORMAT || review.rubricVersion !== RUBRIC)
    throw new Error("Study review format or rubric version does not match.");
  for (const field of [
    "corpusVersion",
    "corpusHash",
    "corpusDocumentHash",
    "resultHash",
    "requestedCount",
    "outputContractVersion",
    "toolContractVersion",
    "model",
    "runtime",
  ] as const)
    if (review[field] !== expected[field])
      throw new Error("Study review does not match corpus/results: " + field);
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
    review.responses.length !== expected.responses.length
  )
    throw new Error("Every study response must be reviewed.");
  let totalClaims = 0,
    supportedClaims = 0,
    quizItems = 0,
    unambiguousQuizItems = 0,
    sufficiencyPasses = 0,
    abstentions = 0;
  for (const original of expected.responses) {
    const matches = review.responses.filter(
        (row: any) => row.id === original.id,
      ),
      row = matches[0];
    if (
      matches.length !== 1 ||
      row.complete !== true ||
      !same(row.context, original.context)
    )
      throw new Error("Incomplete or changed study response: " + original.id);
    if (
      !Array.isArray(row.components) ||
      row.components.length !== original.components.length
    )
      throw new Error("Every study component requires review: " + original.id);
    let allSupported = true;
    for (const component of original.components) {
      const entries = row.components.filter(
          (entry: any) => entry.id === component.id,
        ),
        entry = entries[0];
      if (
        entries.length !== 1 ||
        entry.reviewed !== true ||
        typeof entry.factual !== "boolean" ||
        !nonblank(entry.rationale) ||
        !Array.isArray(entry.claims) ||
        entry.text !== component.text ||
        !same(entry.citations, component.citations) ||
        entry.requiresClaims !== component.requiresClaims ||
        (component.requiresClaims && entry.factual !== true) ||
        (entry.factual ? !entry.claims.length : entry.claims.length > 0)
      )
        throw new Error(
          "Incomplete or changed component review: " +
            original.id +
            "/" +
            component.id,
        );
      const claimTexts = new Set<string>();
      for (const claim of entry.claims) {
        if (
          !nonblank(claim.text) ||
          !nonblank(claim.rationale) ||
          typeof claim.supported !== "boolean" ||
          typeof claim.qualifiersPreserved !== "boolean" ||
          typeof claim.inferenceLabeled !== "boolean"
        )
          throw new Error(
            "Incomplete atomic claim judgment: " +
              original.id +
              "/" +
              component.id,
          );
        const text = claim.text.trim().normalize("NFC").toLocaleLowerCase("en");
        if (claimTexts.has(text))
          throw new Error(
            "Duplicate atomic claim judgment: " +
              original.id +
              "/" +
              component.id,
          );
        claimTexts.add(text);
        totalClaims++;
        const supported =
          claim.supported &&
          claim.qualifiersPreserved &&
          claim.inferenceLabeled;
        if (supported) supportedClaims++;
        allSupported &&= supported;
      }
    }
    if (
      !Array.isArray(row.quizItems) ||
      row.quizItems.length !== original.quizItems.length
    )
      throw new Error(
        "Every quiz item requires ambiguity review: " + original.id,
      );
    for (const q of original.quizItems) {
      const entries = row.quizItems.filter((entry: any) => entry.id === q.id),
        entry = entries[0];
      const item = original.context.answer.items!.find(
        (item) => item.id === q.id,
      )!;
      if (
        entries.length !== 1 ||
        entry.reviewed !== true ||
        !nonblank(entry.rationale) ||
        typeof entry.candidatesClearlyLabeled !== "boolean" ||
        !Array.isArray(entry.correctOptionIds) ||
        new Set(entry.correctOptionIds).size !==
          entry.correctOptionIds.length ||
        entry.correctOptionIds.some(
          (id: unknown) => !item.options!.some((o) => o.id === id),
        )
      )
        throw new Error(
          "Incomplete quiz ambiguity judgment: " + original.id + "/" + q.id,
        );
      quizItems++;
      if (
        entry.candidatesClearlyLabeled &&
        entry.correctOptionIds.length === 1 &&
        entry.correctOptionIds[0] === item.correctOptionId
      )
        unambiguousQuizItems++;
    }
    const sufficiency = row.sufficiency;
    if (
      !sufficiency ||
      !nonblank(sufficiency.rationale) ||
      ["statusAppropriate", "distinctItemsOnly", "countLimitationClear"].some(
        (key) => typeof sufficiency[key] !== "boolean",
      )
    )
      throw new Error(
        "Incomplete evidence sufficiency judgment: " + original.id,
      );
    if (
      sufficiency.statusAppropriate &&
      sufficiency.distinctItemsOnly &&
      sufficiency.countLimitationClear
    )
      sufficiencyPasses++;
    if (
      original.context.case.expectedStatus === "insufficient_evidence" &&
      sufficiency.statusAppropriate &&
      allSupported
    )
      abstentions++;
  }
  const supportFraction = totalClaims ? supportedClaims / totalClaims : 0;
  return {
    reviewer: review.reviewer,
    totalClaims,
    supportedClaims,
    supportFraction,
    quizItems,
    unambiguousQuizItems,
    sufficiencyPasses,
    abstentions,
    cases: expected.responses.length,
    passed:
      supportFraction >= 0.95 &&
      quizItems > 0 &&
      unambiguousQuizItems === quizItems &&
      sufficiencyPasses === expected.responses.length &&
      abstentions === 2,
  };
}
