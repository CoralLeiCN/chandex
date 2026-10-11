import { readFileSync } from "node:fs";
import { chunkText, digest, type Answer } from "../../src/domain/evidence.ts";
import { loadStudyCorpus, studyPassages } from "../../scripts/study-corpus.ts";
import {
  loadStructuredCorpus,
  structuredPassages,
} from "../../scripts/structured-checks.ts";
import { studyAnswer } from "./study.ts";
import { structuredAnswer } from "./structured.ts";

// Deterministic checker inputs, never model results or release qualification.
function abstention(): Answer {
  return {
    status: "insufficient_evidence",
    title: "Synthetic abstention",
    blocks: [
      {
        kind: "notice",
        text: "The requested evidence is unavailable.",
        citations: [],
      },
    ],
    coverageWarnings: [],
  };
}

export function groundingReviewResult() {
  const corpus = JSON.parse(
    readFileSync("tests/fixtures/evaluation/corpus.json", "utf8"),
  );
  const passage = corpus.sources.flatMap((source: any) =>
    chunkText(source.text, source.id, "eval-v1-" + source.id, source.title),
  )[0];
  return {
    corpusVersion: corpus.version,
    corpusHash: digest(JSON.stringify(corpus)),
    model: "synthetic-test-fixture",
    runtime: "synthetic-test-fixture",
    results: corpus.questions.map((question: any) => ({
      ...question,
      status: question.expectedStatus,
      answer:
        question.expectedStatus === "insufficient_evidence"
          ? abstention()
          : {
              status: "answered",
              title: "Synthetic checker answer",
              blocks: [
                {
                  kind: "fact",
                  text: passage.text,
                  citations: [
                    {
                      passageId: passage.id,
                      quote: passage.text,
                      start: 0,
                      end: Array.from(passage.text).length,
                    },
                  ],
                },
              ],
              coverageWarnings: [],
            },
    })),
  };
}

export function studyReviewResult(): Buffer {
  const corpus = loadStudyCorpus();
  return Buffer.from(
    JSON.stringify({
      corpusVersion: corpus.version,
      corpusHash: corpus.hash,
      requestedCount: corpus.requestedCount,
      outputContractVersion: 4,
      toolContractVersion: 4,
      model: "synthetic-test-fixture",
      runtime: "synthetic-test-fixture",
      results: corpus.cases.map((item) => {
        let answer: Answer;
        if (item.expectedStatus === "insufficient_evidence") {
          answer = { ...abstention(), kind: item.kind, items: [] };
        } else {
          const passage = studyPassages(item, corpus.version)[0];
          answer = studyAnswer(passage, item.kind);
          if (item.id.endsWith("-supported")) {
            const template = answer.items![0];
            const blocks = answer.blocks;
            answer.blocks = [];
            answer.items = Array.from({ length: 5 }, (_, index) => {
              const offset = answer.blocks.length;
              answer.blocks.push(...structuredClone(blocks));
              return {
                ...structuredClone(template),
                id: `item-${index + 1}`,
                question: `Synthetic verifier question ${index + 1}`,
                answerBlockIndexes: template.answerBlockIndexes.map(
                  (i) => i + offset,
                ),
                ...(template.explanationBlockIndexes
                  ? {
                      explanationBlockIndexes:
                        template.explanationBlockIndexes.map((i) => i + offset),
                    }
                  : {}),
              };
            });
            answer.coverageWarnings = [];
          }
        }
        return { ...item, answer };
      }),
    }),
  );
}

export function structuredReviewResult(): Buffer {
  const corpus = loadStructuredCorpus();
  return Buffer.from(
    JSON.stringify({
      corpusVersion: corpus.version,
      corpusHash: corpus.hash,
      outputContractVersion: 5,
      toolContractVersion: 4,
      model: "synthetic-test-fixture",
      runtime: "synthetic-test-fixture",
      results: corpus.cases.map((item) => {
        let answer: Answer;
        if (item.expectedStatus === "insufficient_evidence") {
          answer = {
            ...abstention(),
            kind: item.kind,
            ...(item.kind === "mind-map"
              ? { nodes: [] }
              : { columns: [], rows: [] }),
          };
        } else {
          answer = structuredAnswer(
            structuredPassages(item, corpus.version)[0],
            item.kind,
          );
          if (item.id === "mind-map-sparse") {
            answer.nodes = [
              {
                ...answer.nodes![1],
                parentId: null,
                relation: "",
                relationCitations: [],
              },
            ];
            answer.coverageWarnings = [];
          }
        }
        return { ...item, answer, sparseMet: false };
      }),
    }),
  );
}
