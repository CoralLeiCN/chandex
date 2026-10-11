import { readFileSync } from "node:fs";
import { chunkText, digest } from "../src/domain/evidence.ts";
import {
  isStudyKind,
  studyCount,
  type StudyKind,
} from "../src/domain/study.ts";

export interface StudyCase {
  id: string;
  kind: StudyKind;
  expectedStatus: "answered" | "insufficient_evidence";
  sources: { id: string; title: string; text: string }[];
  question: string;
}
export function loadStudyCorpus(
  file = "tests/fixtures/evaluation/study-corpus.json",
) {
  const raw = readFileSync(file);
  const corpus: {
    version: number;
    requestedCount: number;
    cases: StudyCase[];
  } = JSON.parse(raw.toString());
  if (corpus.version !== 1 || corpus.requestedCount !== 5)
    throw new Error("Unsupported study corpus version or requested count.");
  studyCount(corpus.requestedCount);
  const ids = new Set<string>();
  if (!Array.isArray(corpus.cases) || corpus.cases.length !== 6)
    throw new Error("The study corpus requires all six acceptance cases.");
  for (const item of corpus.cases) {
    if (
      !isStudyKind(item.kind) ||
      !item.id ||
      ids.has(item.id) ||
      !item.question?.trim() ||
      !["answered", "insufficient_evidence"].includes(item.expectedStatus) ||
      !Array.isArray(item.sources) ||
      !item.sources.length ||
      new Set(item.sources.map((s) => s.id)).size !== item.sources.length ||
      item.sources.some((s) => !s.id || !s.title?.trim() || !s.text?.trim())
    )
      throw new Error("Invalid study corpus case.");
    ids.add(item.id);
  }
  for (const kind of ["flashcards", "quiz"]) {
    for (const scenario of ["supported", "unanswerable", "sparse"]) {
      const item = corpus.cases.find((c) => c.id === `${kind}-${scenario}`);
      if (
        !item ||
        item.kind !== kind ||
        item.expectedStatus !==
          (scenario === "unanswerable" ? "insufficient_evidence" : "answered")
      )
        throw new Error("Missing study acceptance scenario.");
    }
  }
  return {
    ...corpus,
    // Keep the original v1 result hash compatible; bind the whole corpus in reviews too.
    hash: digest(JSON.stringify(corpus.cases)),
    documentHash: digest(raw),
  };
}
export function studyPassages(item: StudyCase, version: number) {
  return item.sources.flatMap((source) =>
    chunkText(
      source.text,
      source.id,
      `study-eval-v${version}-${source.id}`,
      source.title,
    ),
  );
}
