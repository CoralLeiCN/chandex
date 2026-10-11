import { useState, useEffect, useRef } from "react";
import { api } from "./api.ts";
import { overviewSpeechText } from "../domain/audio-overview.ts";
import type { Answer } from "../domain/evidence.ts";
export function AudioOverview({
  notebookId,
  artifactId,
  revisionId,
  content,
}: {
  notebookId: string;
  artifactId: string;
  revisionId: string;
  content: Answer;
}) {
  const [media, setMedia] = useState<any>(null),
    [provider, setProvider] = useState(""),
    [voice, setVoice] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const root = `/notebooks/${notebookId}/artifacts/${artifactId}/audio`;
  const renderButton = useRef<HTMLButtonElement>(null);
  const renderingStatus = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    const refresh = async (catalog = false) => {
      try {
        const value = await api(root + (catalog ? "" : "?catalog=false"));
        if (live) {
          setMedia((previous: any) => ({ ...previous, ...value }));
          if (catalog) setVoice(value.provider?.voices[0]?.id ?? "");
        }
      } catch (e) {
        if (live)
          setError(
            e instanceof Error ? e.message : "Could not inspect speech.",
          );
      }
    };
    void refresh(true);
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [root, revisionId]);
  const action = async (path: string, body: any) => {
    setBusy(true);
    setError("");
    try {
      await api(root + path, "POST", body);
      const current = await api(root + "?catalog=false");
      setMedia((previous: any) => ({ ...previous, ...current }));
      requestAnimationFrame(() => {
        if (path.endsWith("/cancel")) renderButton.current?.focus();
        else renderingStatus.current?.focus();
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Speech request failed.");
    } finally {
      setBusy(false);
    }
  };
  const jobs = (media?.jobs ?? []).filter(
      (job: any) => job.revision_id === revisionId,
    ),
    assets = (media?.assets ?? []).filter(
      (asset: any) => asset.revision_id === revisionId && asset.available,
    ),
    active = jobs.find((job: any) => job.status === "processing"),
    last = jobs.at(-1),
    available = media?.provider?.available && content.status === "answered";
  return (
    <section className="audio-overview" aria-label="Audio overview speech">
      <h3>Listen to this script</h3>
      <p className="fine">
        Speech is generated from this written revision. Keep the script and its
        citations with the audio; listen before sharing. Playback starts when
        you choose it.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {content.status !== "answered" ? (
        <p className="fine">
          This script has insufficient evidence, so speech rendering is
          unavailable.
        </p>
      ) : (
        <>
          <div className="speech-controls">
            <label>
              Speech provider
              <select
                aria-label="Speech provider"
                value={provider}
                disabled={busy || !!active}
                onChange={(event) => setProvider(event.target.value)}
              >
                <option value="">Choose a provider</option>
                {media?.provider && (
                  <option
                    value={media.provider.id}
                    disabled={!media.provider.available}
                  >
                    {media.provider.label}
                  </option>
                )}
              </select>
            </label>
            <label>
              English voice
              <select
                aria-label="English speech voice"
                value={voice}
                disabled={busy || !!active}
                onChange={(event) => setVoice(event.target.value)}
              >
                {(media?.provider?.voices ?? []).map((item: any) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.language}
                  </option>
                ))}
              </select>
            </label>
            <button
              ref={renderButton}
              disabled={!available || !provider || !voice || busy || !!active}
              onClick={() =>
                void action("", {
                  revisionId,
                  provider,
                  voiceId: voice,
                  idempotency: crypto.randomUUID(),
                })
              }
            >
              {assets.length ? "Render again" : "Render audio"}
            </button>
          </div>
          {!media?.provider && (
            <p className="fine">Checking installed English voices…</p>
          )}
          {media?.provider && !media.provider.available && (
            <p className="fine">
              Local English speech is unavailable. Install an English voice in
              macOS settings, then reopen this script.
            </p>
          )}
          <div
            role="status"
            tabIndex={-1}
            ref={renderingStatus}
            className="speech-status"
          >
            {active ? (
              <>
                <p>Rendering audio…</p>
                <button
                  disabled={busy}
                  onClick={() => void action(`/jobs/${active.id}/cancel`, {})}
                >
                  Stop rendering
                </button>
              </>
            ) : (
              last &&
              ["failed", "cancelled", "interrupted", "unavailable"].includes(
                last.status,
              ) && (
                <>
                  <p>{last.error ?? "Speech needs attention."}</p>
                  {last.status !== "unavailable" && (
                    <>
                      <p className="fine">
                        Retry uses the previous provider and voice:{" "}
                        {media?.provider?.label ?? last.provider} ·{" "}
                        {media?.provider?.voices.find(
                          (item: any) => item.id === last.voice_id,
                        )?.name ?? last.voice_id}
                        .
                      </p>
                      <button
                        disabled={!available || busy}
                        onClick={() =>
                          void action(`/jobs/${last.id}/retry`, {
                            idempotency: crypto.randomUUID(),
                          })
                        }
                      >
                        Retry speech
                      </button>
                    </>
                  )}
                </>
              )
            )}
            {!active && last?.status === "completed" && (
              <p>Audio is ready for this script revision.</p>
            )}
          </div>
          <details>
            <summary>Complete spoken script</summary>
            <p className="prose">{overviewSpeechText(content)}</p>
          </details>
        </>
      )}
      {assets.map((asset: any) => (
        <article className="speech-asset" key={asset.id}>
          <p>
            {media?.provider?.voices.find(
              (item: any) => item.id === asset.voice_id,
            )?.name ?? asset.voice_id}{" "}
            · {Math.round(asset.duration)} seconds · This script revision
          </p>
          <audio
            controls
            preload="none"
            aria-label={`Generated speech in ${asset.voice_id}`}
            src={`/api${root}/assets/${asset.id}`}
          />
          <a
            className="button small"
            href={`/api${root}/assets/${asset.id}?download=true`}
          >
            Download generated audio
          </a>
          <details>
            <summary>Speech provenance</summary>
            <dl className="snapshot-provenance">
              <dt>Written revision</dt>
              <dd>{asset.revision_id}</dd>
              <dt>Spoken text SHA-256</dt>
              <dd>{asset.script_hash}</dd>
              <dt>Audio SHA-256</dt>
              <dd>{asset.hash}</dd>
              <dt>Provider</dt>
              <dd>
                {asset.provider}, renderer {asset.renderer_version},{" "}
                {asset.os_version}
              </dd>
            </dl>
          </details>
        </article>
      ))}
    </section>
  );
}
