import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { api, ApiError } from "./api.ts";
import { RichNoteEditor } from "./note-editor.tsx";
import { NoteDraftWriter, type DraftStatus } from "./note-draft-writer.ts";
import type {
  DraftReference,
  NoteDraft,
  NoteDraftSummary,
} from "../domain/note-drafts.ts";
import type { RichNote } from "../domain/notes.ts";
import type { NoteDraftState } from "./note-dialog.tsx";

type Props = Omit<
  React.ComponentProps<typeof RichNoteEditor>,
  "onSave" | "onReload" | "onChange" | "recovered" | "blocked" | "retrySave"
> & {
  artifactId: string | null;
  baseRevisionId: string | null;
  onSave: (
    title: string,
    document: RichNote,
    context: {
      baseRevisionId: string | null;
      draft?: DraftReference;
      saveId: string;
    },
  ) => Promise<void>;
  onReload?: (discard: () => Promise<void>) => Promise<void>;
};

export function RecoverableNoteEditor(props: Props) {
  const [drafts, setDrafts] = useState<NoteDraftSummary[] | null>(null),
    [chosen, setChosen] = useState<NoteDraft | null | undefined>(undefined),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [attempt, setAttempt] = useState(0);
  useLayoutEffect(() => {
    if (chosen === undefined)
      props.onDraftState?.({ changed: false, saving: busy });
  }, [chosen, busy, props.onDraftState]);
  useEffect(() => {
    let alive = true;
    setError("");
    void api(
      `/notebooks/${props.notebookId}/drafts${props.artifactId ? `?artifactId=${encodeURIComponent(props.artifactId)}` : ""}`,
    )
      .then((rows: NoteDraftSummary[]) => {
        if (!alive) return;
        setDrafts(rows);
        if (!rows.length) setChosen(null);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [props.notebookId, props.artifactId, attempt]);
  if (chosen !== undefined)
    return <DraftSession {...props} recoveredDraft={chosen} />;
  return (
    <section aria-label="Recover note draft">
      {error && (
        <p role="alert" className="error-bar">
          {error}
        </p>
      )}
      {!drafts && !error && (
        <p role="status">Checking for recoverable drafts…</p>
      )}
      {!drafts && error && (
        <button type="button" onClick={() => setAttempt(attempt + 1)}>
          Retry loading drafts
        </button>
      )}
      {drafts && (
        <>
          <p>
            Unsaved drafts are available. Recover one to continue editing, or
            start a separate draft.
          </p>
          {drafts.map((d) => (
            <section
              key={d.id}
              className="note-discard"
              aria-label={d.title || "Untitled draft"}
            >
              <strong>{d.title || "Untitled draft"}</strong>
              <p className="fine">
                Saved locally {new Date(d.updated).toLocaleString()}
              </p>
              {d.baseRevisionId !== props.baseRevisionId && (
                <p>The saved note has changed since this draft was started.</p>
              )}
              <div className="note-discard-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setError("");
                    void api(`/notebooks/${props.notebookId}/drafts/${d.id}`)
                      .then(setChosen)
                      .catch((e) => setError(e.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  Recover draft
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setError("");
                    void api(
                      `/notebooks/${props.notebookId}/drafts/${d.id}`,
                      "DELETE",
                      { version: d.version },
                    )
                      .then(() => {
                        const remaining = drafts.filter(
                          (row) => row.id !== d.id,
                        );
                        setDrafts(remaining);
                        if (!remaining.length) setChosen(null);
                      })
                      .catch((e) => setError(e.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  Discard draft
                </button>
              </div>
            </section>
          ))}
          <button type="button" disabled={busy} onClick={() => setChosen(null)}>
            Start a separate draft
          </button>
        </>
      )}
    </section>
  );
}

function DraftSession({
  recoveredDraft,
  ...props
}: Props & { recoveredDraft: NoteDraft | null }) {
  const [status, setStatus] = useState<DraftStatus>({
      state: recoveredDraft ? "saved" : "clean",
    }),
    [blocked, setBlocked] = useState(false),
    [retrySave, setRetrySave] = useState(false);
  const publication = useRef<{
    title: string;
    document: RichNote;
    context: {
      baseRevisionId: string | null;
      draft?: DraftReference;
      saveId: string;
    };
  } | null>(null);
  const [writer] = useState(
    () =>
      new NoteDraftWriter(
        props.notebookId,
        setStatus,
        recoveredDraft ?? undefined,
      ),
  );
  const baseRevisionId = recoveredDraft?.baseRevisionId ?? props.baseRevisionId;
  useEffect(() => {
    const leave = () => writer.leave();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      writer.dispose();
    };
  }, [writer]);
  const discard = useCallback(async () => {
    setBlocked(true);
    try {
      await writer.discard();
    } finally {
      setBlocked(false);
    }
  }, [writer]);
  const report = useCallback(
    (state: NoteDraftState) =>
      props.onDraftState?.({
        ...state,
        saving: state.saving || blocked,
        discard,
      }),
    [props.onDraftState, blocked, discard],
  );
  return (
    <>
      {status.state === "error" ? (
        <p role="alert" className="error-bar">
          Draft recovery could not be updated. Keep this editor open and try
          again. {status.error}{" "}
          <button
            type="button"
            disabled={blocked}
            onClick={() => {
              void writer.flush().catch(() => {});
            }}
          >
            Retry draft saving
          </button>
        </p>
      ) : (
        <p role="status" className="fine">
          {status.state === "saving"
            ? "Saving draft locally…"
            : status.state === "saved"
              ? "Draft saved locally. Save note to publish your changes."
              : "Drafts save locally while you edit."}
        </p>
      )}
      {recoveredDraft && baseRevisionId !== props.baseRevisionId && (
        <p role="status" className="note-discard">
          This draft is based on an older saved revision. Your text is
          preserved; saving cannot overwrite the newer note. Reload the saved
          revision to discard this draft and start again.
        </p>
      )}
      {retrySave && (
        <p role="alert" className="note-discard">
          The save could not be confirmed. Choose Retry save to check the same
          save before continuing to edit. Discarding this draft does not remove
          a note that was already saved.
        </p>
      )}
      <RichNoteEditor
        {...props}
        initial={recoveredDraft?.document ?? props.initial}
        initialTitle={recoveredDraft?.title ?? props.initialTitle}
        availability={
          recoveredDraft?.referenceAvailability ?? props.availability
        }
        recovered={!!recoveredDraft}
        blocked={blocked}
        retrySave={retrySave}
        onChange={(title, document, changed) =>
          writer.change(
            { artifactId: props.artifactId, baseRevisionId, title, document },
            changed,
          )
        }
        onDraftState={report}
        onReload={props.onReload ? () => props.onReload!(discard) : undefined}
        onSave={async (title, document) => {
          if (!publication.current) {
            writer.change(
              { artifactId: props.artifactId, baseRevisionId, title, document },
              true,
              true,
            );
            const draft = await writer.flush();
            publication.current = {
              title,
              document,
              context: { baseRevisionId, draft, saveId: crypto.randomUUID() },
            };
          }
          const pending = publication.current;
          try {
            await props.onSave(
              pending.title,
              pending.document,
              pending.context,
            );
            writer.published();
            publication.current = null;
            setRetrySave(false);
          } catch (e) {
            if (e instanceof ApiError && e.status === 400) {
              publication.current = null;
              setRetrySave(false);
            } else {
              setRetrySave(true);
            }
            throw e;
          }
        }}
      />
    </>
  );
}
