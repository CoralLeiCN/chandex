import React, { useState } from "react";
import type { Answer, Citation } from "../domain/evidence.ts";
import { api } from "./api.ts";
interface Attempt {
  id: string;
  artifact_id: string;
  revision_id: string;
  answers: Record<string, string>;
  submitted: string | null;
  score: number | null;
  total: number;
}
export function StudyMaterial({
  content,
  openPassage,
  notebookId,
  artifactId,
  revisionId,
  attempts,
  onRefresh,
}: {
  content: Answer;
  openPassage: (citation: Citation) => void;
  notebookId: string;
  artifactId: string;
  revisionId: string;
  attempts: Attempt[];
  onRefresh: () => Promise<unknown>;
}) {
  const items = content.items!;
  const [position, setPosition] = useState(0),
    [revealed, setRevealed] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(
    () =>
      attempts
        .filter(
          (a) => a.artifact_id === artifactId && a.revision_id === revisionId,
        )
        .at(-1) ?? null,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const path = `/notebooks/${notebookId}/artifacts/${artifactId}/attempts`;
  const action = async (fn: () => Promise<Attempt>) => {
    setBusy(true);
    setError("");
    try {
      setAttempt(await fn());
      await onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Quiz action failed.");
    } finally {
      setBusy(false);
    }
  };
  const references = (citations: Citation[], context: string) =>
    citations.map((citation, i) => (
      <button
        key={i}
        className="citation"
        aria-label={`Open evidence for ${context}, reference ${i + 1}`}
        onClick={() => openPassage(citation)}
      >
        {i + 1}
      </button>
    ));
  const blocks = (indexes: number[], context: string) =>
    indexes.map((index) => (
      <div className={`answer-block ${content.blocks[index].kind}`} key={index}>
        <p>{content.blocks[index].text}</p>
        {references(content.blocks[index].citations, context)}
        {content.blocks[index].kind === "inference" && (
          <span className="inference-label">Inference</span>
        )}
      </div>
    ));
  if (content.kind === "flashcards") {
    const item = items[position];
    return (
      <section className="study-material">
        <h3>{content.title}</h3>
        <p role="status">
          Card {position + 1} of {items.length}
        </p>
        <h4>{item.question}</h4>
        {references(item.questionCitations, `card ${position + 1} question`)}
        <button
          aria-expanded={revealed}
          aria-controls="flashcard-answer"
          onClick={() => setRevealed((value) => !value)}
        >
          {revealed ? "Hide answer" : "Reveal answer"}
        </button>
        <div id="flashcard-answer" hidden={!revealed}>
          {blocks(item.answerBlockIndexes, `card ${position + 1} answer`)}
        </div>
        <div className="dialog-actions">
          <button
            disabled={position === 0}
            onClick={() => {
              setPosition((value) => value - 1);
              setRevealed(false);
            }}
          >
            Previous card
          </button>
          <button
            disabled={position === items.length - 1}
            onClick={() => {
              setPosition((value) => value + 1);
              setRevealed(false);
            }}
          >
            Next card
          </button>
        </div>
      </section>
    );
  }
  return (
    <section className="study-material">
      <h3>{content.title}</h3>
      <p className="fine">
        Score measures agreement with this generated answer key. Check the cited
        evidence when reviewing answers.
      </p>
      {error && (
        <p role="alert" className="error-bar">
          {error}
        </p>
      )}
      {!attempt ? (
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            void action(() =>
              api(path, "POST", {
                revisionId,
                idempotency: crypto.randomUUID(),
              }),
            )
          }
        >
          Start quiz
        </button>
      ) : (
        <>
          {attempts.filter(
            (a) => a.artifact_id === artifactId && a.revision_id === revisionId,
          ).length > 1 && (
            <label>
              Quiz attempt
              <select
                disabled={busy}
                value={attempt.id}
                onChange={(event) =>
                  setAttempt(
                    attempts.find((a) => a.id === event.target.value) ??
                      attempt,
                  )
                }
              >
                {attempts
                  .filter(
                    (a) =>
                      a.artifact_id === artifactId &&
                      a.revision_id === revisionId,
                  )
                  .map((a, i) => (
                    <option key={a.id} value={a.id}>
                      Attempt {i + 1} ·{" "}
                      {a.submitted ? `${a.score} of ${a.total}` : "In progress"}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <p role="status">
            {attempt.submitted
              ? `Score: ${attempt.score} of ${attempt.total}`
              : `${Object.keys(attempt.answers).length} of ${attempt.total} questions answered`}
          </p>
          {items.map((item, index) => (
            <fieldset
              className="quiz-question"
              key={item.id}
              disabled={busy || !!attempt.submitted}
            >
              <legend>
                {index + 1}. {item.question}
              </legend>
              {references(
                item.questionCitations,
                `question ${index + 1} premise`,
              )}
              {(item.options ?? []).map((option) => (
                <label className="quiz-option" key={option.id}>
                  <input
                    type="radio"
                    name={`quiz-${attempt.id}-${item.id}`}
                    value={option.id}
                    checked={attempt.answers[item.id] === option.id}
                    onChange={() =>
                      void action(() =>
                        api(`${path}/${attempt.id}`, "PATCH", {
                          answers: { ...attempt.answers, [item.id]: option.id },
                        }),
                      )
                    }
                  />
                  <span>{option.text}</span>
                </label>
              ))}
            </fieldset>
          ))}
          {!attempt.submitted ? (
            <button
              className="primary"
              disabled={
                busy || Object.keys(attempt.answers).length !== items.length
              }
              onClick={() =>
                void action(() =>
                  api(`${path}/${attempt.id}`, "PATCH", {
                    answers: attempt.answers,
                    submit: true,
                  }),
                )
              }
            >
              Submit quiz
            </button>
          ) : (
            <>
              {items.map((item, index) => (
                <section className="quiz-feedback" key={item.id}>
                  <h4>
                    Question {index + 1}:{" "}
                    {attempt.answers[item.id] === item.correctOptionId
                      ? "Matches the answer key"
                      : "Review the answer"}
                  </h4>
                  <p>{item.question}</p>
                  {references(item.questionCitations, `question ${index + 1}`)}
                  <h5>Correct answer</h5>
                  {blocks(
                    item.answerBlockIndexes,
                    `question ${index + 1} answer`,
                  )}
                  <h5>Explanation</h5>
                  {blocks(
                    item.explanationBlockIndexes!,
                    `question ${index + 1} explanation`,
                  )}
                </section>
              ))}
              <button
                disabled={busy}
                onClick={() =>
                  void action(() =>
                    api(path, "POST", {
                      revisionId,
                      idempotency: crypto.randomUUID(),
                    }),
                  )
                }
              >
                Start new attempt
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
