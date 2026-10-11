import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import { startVoiceCapture, voiceBase64 } from "./voice-capture.ts";
const voiceServices = { capture: startVoiceCapture, request: api };
export function VoiceInput({
  notebookId,
  disabled,
  onInsert,
  onStart,
  onBusy,
  destination = "note",
  services = voiceServices,
}: {
  notebookId: string;
  disabled: boolean;
  onInsert: (text: string) => void;
  onStart: () => void;
  onBusy: (busy: boolean) => void;
  destination?: "note" | "question";
  services?: typeof voiceServices;
}) {
  const [state, setState] = useState("idle"),
    [text, setText] = useState(""),
    [seconds, setSeconds] = useState(0),
    [error, setError] = useState("");
  const control = useRef<AbortController | null>(null),
    capture = useRef<Awaited<ReturnType<typeof startVoiceCapture>> | null>(
      null,
    ),
    job = useRef<string | null>(null),
    requestKey = useRef<string | null>(null);
  const live = useRef(true),
    recording = useRef<HTMLButtonElement>(null),
    review = useRef<HTMLTextAreaElement>(null);
  const root = `/notebooks/${notebookId}/dictation`;
  useEffect(() => {
    onBusy(state !== "idle");
  }, [state, onBusy]);
  const discard = () => {
    control.current?.abort();
    control.current = null;
    capture.current?.cancel();
    capture.current = null;
    if (requestKey.current)
      void services
        .request(
          root,
          "DELETE",
          { idempotency: requestKey.current },
          {
            keepalive: true,
          },
        )
        .catch(() => {});
    else if (job.current)
      void services
        .request(root + "/" + job.current, "DELETE", undefined, {
          keepalive: true,
        })
        .catch(() => {});
    job.current = null;
    requestKey.current = null;
  };
  useEffect(() => {
    live.current = true;
    const leave = () => {
      discard();
      setText("");
      setState("idle");
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      live.current = false;
      discard();
    };
  }, [root]);
  const finish = async () => {
    const current = control.current,
      active = capture.current;
    if (!current || current.signal.aborted || !active) return;
    setState("transcribing");
    capture.current = null;
    try {
      const bytes = await active.finish();
      if (current.signal.aborted) return;
      const key = crypto.randomUUID();
      requestKey.current = key;
      const started = await services.request(
        root,
        "POST",
        {
          base64: voiceBase64(bytes),
          idempotency: key,
        },
        { signal: current.signal },
      );
      if (current.signal.aborted || !live.current) {
        void services
          .request(root + "/" + started.id, "DELETE")
          .catch(() => {});
        return;
      }
      job.current = started.id;
      let result = started;
      while (result.status === "processing") {
        await new Promise<void>((resolve) => {
          const abort = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            current.signal.removeEventListener("abort", abort);
            resolve();
          }, 250);
          current.signal.addEventListener("abort", abort, { once: true });
        });
        if (current.signal.aborted || !live.current) return;
        result = await services.request(root + "/" + started.id);
      }
      if (current.signal.aborted || !live.current) return;
      if (result.status !== "completed")
        throw Error(result.error ?? "Voice input failed.");
      setText(result.text);
      setState("review");
      requestAnimationFrame(() => review.current?.focus());
    } catch (e) {
      if (!current.signal.aborted && live.current) {
        discard();
        setError(e instanceof Error ? e.message : "Voice input failed.");
        setState("idle");
        requestAnimationFrame(() => recording.current?.focus());
      }
    }
  };
  return (
    <section className="voice-input" aria-label="Voice input">
      <p className="fine">
        {destination === "question"
          ? "Speak your question instead of typing. English transcription runs on this device; review the text before sending."
          : "Speak in English. Review the words before inserting them into your note. The recording is temporary and stays on this device."}
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {state === "idle" && (
        <button
          type="button"
          className="small"
          ref={recording}
          disabled={disabled}
          onClick={() => {
            discard();
            setError("");
            setSeconds(0);
            setState("permission");
            onStart();
            const current = new AbortController();
            control.current = current;
            void services
              .capture({
                signal: current.signal,
                onSeconds: (value) => {
                  if (live.current) setSeconds(value);
                },
                onLimit: () => {
                  void finish();
                },
                onError: (message) => {
                  if (current.signal.aborted || !live.current) return;
                  current.abort();
                  capture.current = null;
                  setError(message);
                  setState("idle");
                  requestAnimationFrame(() => recording.current?.focus());
                },
              })
              .then((value) => {
                if (current.signal.aborted || !live.current) {
                  value.cancel();
                  return;
                }
                capture.current = value;
                setState("recording");
              })
              .catch((e) => {
                if (!current.signal.aborted && live.current) {
                  setError(e.message);
                  setState("idle");
                  requestAnimationFrame(() => recording.current?.focus());
                }
              });
          }}
        >
          {destination === "question"
            ? "Dictate question"
            : "Record voice input"}
        </button>
      )}
      {(state === "permission" ||
        state === "recording" ||
        state === "transcribing") && (
        <>
          <p role="status">
            {state === "permission"
              ? "Waiting for microphone permission…"
              : state === "recording"
                ? `Recording · ${Math.floor(seconds)} / 120 seconds`
                : "Transcribing on this device…"}
          </p>
          {state === "recording" && (
            <button
              type="button"
              className="small"
              onClick={() => void finish()}
            >
              Stop and transcribe
            </button>
          )}
          <button
            type="button"
            className="small"
            onClick={() => {
              discard();
              setState("idle");
              requestAnimationFrame(() => recording.current?.focus());
            }}
          >
            Cancel voice input
          </button>
        </>
      )}
      {state === "review" && (
        <>
          <label>
            {destination === "question"
              ? "Review your question"
              : "Review recognized words"}
            <textarea
              ref={review}
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={destination === "question" ? 10000 : 32000}
              rows={5}
            />
          </label>
          <p className="fine">
            Recognition can get names, numbers and meaning wrong. Correct the
            words here.{" "}
            {destination === "question"
              ? "Inserting does not send your question."
              : "Inserting does not save your note."}
          </p>
          <button
            type="button"
            className="small"
            disabled={disabled || !text.trim()}
            onClick={() => {
              try {
                onInsert(text);
                discard();
                setText("");
                setState("idle");
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : "Could not insert the dictated words.",
                );
              }
            }}
          >
            {destination === "question"
              ? "Insert into question"
              : "Insert into note"}
          </button>
          <button
            type="button"
            className="small"
            onClick={() => {
              discard();
              setText("");
              setState("idle");
              requestAnimationFrame(() => recording.current?.focus());
            }}
          >
            Discard dictation
          </button>
        </>
      )}
    </section>
  );
}
