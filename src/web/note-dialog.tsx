import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "./dialog.tsx";

export interface NoteDraftState {
  changed: boolean;
  saving: boolean;
}
export const cleanNoteDraft: NoteDraftState = {
  changed: false,
  saving: false,
};

export function NoteEditorDialog({
  title,
  error,
  onClose,
  children,
}: {
  title: string;
  error?: string;
  onClose: () => void;
  children: (onDraftState: (state: NoteDraftState) => void) => ReactNode;
}) {
  const [draft, setDraft] = useState(cleanNoteDraft),
    [confirm, setConfirm] = useState(false);
  const keepEditing = useRef<HTMLButtonElement>(null),
    previous = useRef<HTMLElement | null>(null);
  const keep = () => {
    setConfirm(false);
    requestAnimationFrame(() => previous.current?.focus());
  };
  useEffect(() => {
    if (confirm) keepEditing.current?.focus();
  }, [confirm]);
  const requestClose = () => {
    if (draft.saving) return;
    if (confirm) {
      keep();
      return;
    }
    if (draft.changed) {
      previous.current = document.activeElement as HTMLElement | null;
      setConfirm(true);
    } else onClose();
  };
  return (
    <Dialog
      title={title}
      error={error}
      onClose={requestClose}
      closeDisabled={draft.saving}
    >
      {confirm && (
        <section className="note-discard" aria-label="Unsaved note">
          <p role="alert">
            This note has unsaved changes. Keep editing or discard this draft?
          </p>
          <div className="note-discard-actions">
            <button
              type="button"
              className="small"
              ref={keepEditing}
              onClick={keep}
            >
              Keep editing
            </button>
            <button
              type="button"
              className="danger small"
              disabled={draft.saving}
              onClick={() => {
                if (!draft.saving) onClose();
              }}
            >
              Discard draft
            </button>
          </div>
        </section>
      )}
      {children(setDraft)}
    </Dialog>
  );
}
