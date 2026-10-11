import { readFileSync } from "node:fs";
import {
  chunkText,
  digest,
  validateAnswer,
  type Answer,
} from "../src/domain/evidence.ts";
import {
  isStructuredKind,
  structuredCitations,
  type StructuredKind,
} from "../src/domain/structured.ts";
import { exportMarkdown } from "../src/domain/export.ts";
import { documentText } from "../src/domain/artifacts.ts";
export interface StructuredCase {
  id: string;
  kind: StructuredKind;
  expectedStatus: "answered" | "insufficient_evidence";
  sources: { id: string; title: string; text: string }[];
  question: string;
}
export function loadStructuredCorpus() {
  const raw = readFileSync("tests/fixtures/evaluation/structured-corpus.json");
  const corpus: { version: number; cases: StructuredCase[] } = JSON.parse(
    raw.toString(),
  );
  if (
    corpus.version !== 1 ||
    !Array.isArray(corpus.cases) ||
    corpus.cases.length !== 8 ||
    new Set(corpus.cases.map((c) => c.id)).size !== 8
  )
    throw new Error("A complete versioned structured corpus is required.");
  for (const kind of ["mind-map", "data-table"])
    for (const scenario of [
      "supported",
      "sparse",
      "conflicting",
      "unanswerable",
    ]) {
      const item = corpus.cases.find((c) => c.id === kind + "-" + scenario);
      if (
        !item ||
        item.kind !== kind ||
        !isStructuredKind(item.kind) ||
        !item.question?.trim() ||
        item.expectedStatus !==
          (scenario === "unanswerable"
            ? "insufficient_evidence"
            : "answered") ||
        !Array.isArray(item.sources) ||
        !item.sources.length ||
        new Set(item.sources.map((s) => s.id)).size !== item.sources.length ||
        item.sources.some((s) => !s.id || !s.title?.trim() || !s.text?.trim())
      )
        throw new Error("Invalid structured acceptance case.");
    }
  return { ...corpus, hash: digest(raw) };
}
export function structuredPassages(item: StructuredCase, version: number) {
  return item.sources.flatMap((source) =>
    chunkText(
      source.text,
      source.id,
      `structured-eval-v${version}-${source.id}`,
      source.title,
    ),
  );
}
export function structuredChecks(
  item: StructuredCase,
  answer: Answer,
  version: number,
) {
  const passages = structuredPassages(item, version);
  validateAnswer(answer, passages, item.kind);
  const markdown = exportMarkdown(
      answer.title,
      answer,
      (id) => passages.find((p) => p.id === id) ?? null,
    ),
    promotion = documentText(answer);
  const statusMet = answer.status === item.expectedStatus;
  const structureMet =
    answer.status === "insufficient_evidence" ||
    (item.kind === "mind-map"
      ? answer.nodes!.length > 0 && markdown.includes("- ")
      : answer.rows!.length > 0 && markdown.includes("| Item |"));
  // A fully represented single fact needs no extra warning; missing cells remain explicit.
  const sparseMet =
    !item.id.endsWith("-sparse") ||
    (item.kind === "mind-map"
      ? answer.nodes!.length === 1
      : answer.rows!.length === 1);
  const missingBudgetMet =
    item.kind !== "data-table" ||
    !["data-table-supported", "data-table-sparse"].includes(item.id) ||
    (() => {
      const column = answer.columns!.findIndex((c) => c.id === "budget");
      return (
        column >= 0 &&
        answer.rows!.every((row) => !row.cells[column].blockIndexes.length) &&
        markdown.includes("Not stated") &&
        promotion.includes("Not stated")
      );
    })();
  const citationCount =
    answer.blocks.reduce((total, block) => total + block.citations.length, 0) +
    structuredCitations(answer).length;
  const evidenceExportMet =
    (markdown.match(/^\[\^\d+\]:/gm) ?? []).length === citationCount;
  const promotionMet =
    answer.blocks.every((block) => promotion.includes(block.text)) &&
    (answer.nodes ?? []).every(
      (node) =>
        promotion.includes(node.label) &&
        (!node.parentId || promotion.includes(node.relation)),
    ) &&
    (answer.rows ?? []).every((row) => promotion.includes(row.label)) &&
    (!(answer.rows ?? []).length ||
      (answer.columns ?? []).every((column) =>
        promotion.includes(column.label),
      ));
  return {
    statusMet,
    structureMet,
    sparseMet,
    missingBudgetMet,
    evidenceExportMet,
    promotionMet,
    passed:
      statusMet &&
      structureMet &&
      sparseMet &&
      missingBudgetMet &&
      evidenceExportMet &&
      promotionMet,
  };
}
export function checkStructuredResult(raw: Buffer) {
  const corpus = loadStructuredCorpus(),
    result = JSON.parse(raw.toString());
  if (
    result.corpusVersion !== corpus.version ||
    result.corpusHash !== corpus.hash ||
    ![5, 6].includes(result.outputContractVersion) ||
    result.toolContractVersion !== 4 ||
    typeof result.model !== "string" ||
    !result.model.trim() ||
    typeof result.runtime !== "string" ||
    !result.runtime.trim() ||
    !Array.isArray(result.results) ||
    result.results.length !== corpus.cases.length
  )
    throw new Error("Complete matching structured results are required.");
  const results = corpus.cases.map((item) => {
    const matches = result.results.filter((row: any) => row.id === item.id),
      row = matches[0];
    if (
      matches.length !== 1 ||
      row.error ||
      !row.answer ||
      JSON.stringify({
        id: row.id,
        kind: row.kind,
        expectedStatus: row.expectedStatus,
        sources: row.sources,
        question: row.question,
      }) !== JSON.stringify(item)
    )
      throw new Error("Missing, changed or failed structured case: " + item.id);
    return {
      id: item.id,
      ...structuredChecks(item, row.answer, corpus.version),
    };
  });
  return {
    checkerVersion: 1,
    corpusVersion: corpus.version,
    corpusHash: corpus.hash,
    resultHash: digest(raw),
    model: result.model,
    runtime: result.runtime,
    outputContractVersion: result.outputContractVersion,
    toolContractVersion: result.toolContractVersion,
    semanticHumanReview: "pending",
    cases: results.length,
    passed: results.every((row) => row.passed),
    results,
  };
}
