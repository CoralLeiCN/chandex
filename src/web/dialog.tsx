import { useEffect, useRef, type ReactNode } from "react";

export function Dialog({
  title,
  children,
  onClose,
  error,
  closeDisabled = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  error?: string;
  closeDisabled?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => previous?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!closeDisabled) onClose();
      }}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <button
          type="button"
          aria-label="Close dialog"
          onClick={onClose}
          disabled={closeDisabled}
          className="icon"
        >
          ×
        </button>
      </div>
      {error && (
        <p role="alert" className="error-bar">
          {error}
        </p>
      )}
      {children}
    </dialog>
  );
}
