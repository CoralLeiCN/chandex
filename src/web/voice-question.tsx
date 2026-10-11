import { useEffect, useRef, type RefObject, type ComponentProps } from "react";
import { VoiceInput } from "./voice-input.tsx";

export function VoiceQuestion({
  notebookId,
  disabled,
  value,
  onChange,
  textarea,
  onBusy,
  services,
}: {
  notebookId: string;
  disabled: boolean;
  value: string;
  onChange: (text: string) => void;
  textarea: RefObject<HTMLTextAreaElement | null>;
  onBusy: (busy: boolean) => void;
  services?: ComponentProps<typeof VoiceInput>["services"];
}) {
  const selection = useRef({ start: 0, end: 0, text: "" });
  useEffect(() => () => onBusy(false), [onBusy]);
  return (
    <VoiceInput
      notebookId={notebookId}
      disabled={disabled}
      destination="question"
      services={services}
      onBusy={onBusy}
      onStart={() => {
        selection.current = {
          start: textarea.current?.selectionStart ?? value.length,
          end: textarea.current?.selectionEnd ?? value.length,
          text: value,
        };
      }}
      onInsert={(text) => {
        const captured = selection.current;
        if (value !== captured.text)
          throw Error(
            "The question changed. Discard this dictation and record again.",
          );
        const next =
          value.slice(0, captured.start) + text + value.slice(captured.end);
        if (next.length > 10000)
          throw Error(
            "The question exceeds 10,000 characters. Shorten the reviewed words before inserting.",
          );
        onChange(next);
        requestAnimationFrame(() => {
          textarea.current?.focus();
          textarea.current?.setSelectionRange(
            captured.start + text.length,
            captured.start + text.length,
          );
        });
      }}
    />
  );
}
