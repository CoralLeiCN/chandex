import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { Dialog } from "./dialog.tsx";

export function NoteTrash({
  notebookId,
  onClose,
  onChange,
}: {
  notebookId: string;
  onClose: () => void;
  onChange: () => Promise<void>;
}) {
  const [notes, setNotes] = useState<any[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [deleting, setDeleting] = useState<any>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (deleting) keep.current?.focus();
    else heading.current?.focus();
  }, [deleting]);
  const load = async () => {
    setLoading(true);
    try {
      setNotes(await api(`/notebooks/${notebookId}/trash`));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    let live = true;
    void api(`/notebooks/${notebookId}/trash`).then(
      (items) => {
        if (live) {
          setNotes(items);
          setLoading(false);
        }
      },
      (e) => {
        if (live) {
          setError(e.message);
          setLoading(false);
        }
      },
    );
    return () => {
      live = false;
    };
  }, [notebookId]);
  const change = async (note: any, permanent: boolean) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api(
        `/notebooks/${notebookId}/artifacts/${note.id}${permanent ? "" : "/trash/restore"}`,
        permanent ? "DELETE" : "POST",
        {
          trashVersion: note.trash_version,
          ...(permanent ? { confirm: true } : {}),
        },
      );
      setDeleting(null);
      await load();
      await onChange();
      heading.current?.focus();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Note Trash"
      error={error}
      onClose={onClose}
      closeDisabled={busy}
    >
      {deleting ? (
        <>
          <h3>Delete “{deleting.title}” permanently?</h3>
          <p>
            This removes the note, its {deleting.revision_count} saved
            {deleting.revision_count === 1 ? " revision" : " revisions"},
            recoverable drafts and pinned note conversations (
            {deleting.conversation_count}), including their questions and
            answers.
          </p>
          <p>
            Its promoted or conversation snapshots ({deleting.snapshot_count})
            will be purged. Generated material that depends on those snapshots
            becomes unavailable; references in authored notes are marked
            unavailable. Active notebook answers stop.
          </p>
          <p>
            Original imported sources and original chats or generation outputs
            remain. Existing backups and downloaded exports retain their copies.
            This cannot be undone.
          </p>
          <div className="dialog-actions">
            <button
              ref={keep}
              type="button"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              Keep in Trash
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void change(deleting, true)}
            >
              {busy ? "Deleting…" : "Delete permanently"}
            </button>
          </div>
        </>
      ) : (
        <>
          <h3 ref={heading} tabIndex={-1}>
            Trashed notes
          </h3>
          <p className="fine">
            Trash keeps history, references and drafts until you restore or
            permanently delete a note. Existing source snapshots and pinned
            conversations remain usable.
          </p>
          {loading ? (
            <p role="status">Loading Trash…</p>
          ) : !notes.length ? (
            <p>Trash is empty.</p>
          ) : (
            <ul className="trash-list">
              {notes.map((note) => (
                <li key={note.id}>
                  <h4>{note.title}</h4>
                  <p className="fine">
                    Moved to Trash {new Date(note.trashed_at).toLocaleString()}{" "}
                    · {note.revision_count} saved revisions · {note.draft_count}{" "}
                    drafts
                  </p>
                  <div className="dialog-actions">
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Restore ${note.title}`}
                      onClick={() => void change(note, false)}
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      aria-label={`Permanently delete ${note.title}`}
                      onClick={() => setDeleting(note)}
                    >
                      Delete permanently…
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {error && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setError("");
                void load().catch((e) => setError(e.message));
              }}
            >
              Reload Trash
            </button>
          )}
        </>
      )}
    </Dialog>
  );
}
