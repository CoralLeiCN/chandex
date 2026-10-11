import { useEffect, useRef, useState } from "react";
import { Dialog } from "./dialog.tsx";
import { api } from "./api.ts";
import type { WebDiscovery } from "../codex/web-research.ts";
import type { WebCandidate } from "../domain/web-research.ts";
export function WebResearchDialog({
  notebookId,
  model,
  onClose,
  onImported,
}: {
  notebookId: string;
  model?: string;
  onClose: () => void;
  onImported: () => Promise<unknown>;
}) {
  const [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [result, setResult] = useState<WebDiscovery | null>(null),
    [imports, setImports] = useState<Record<string, string>>({});
  const current = useRef<{ key: string; controller: AbortController } | null>(
      null,
    ),
    alive = useRef(true),
    generation = useRef(0);
  const path = "/notebooks/" + notebookId;
  const cancel = () => {
    generation.current++;
    const request = current.current;
    current.current = null;
    if (request) {
      request.controller.abort();
      void api(
        path + "/web-research",
        "DELETE",
        { key: request.key },
        { keepalive: true },
      ).catch(() => {});
    }
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      cancel();
    };
  }, [notebookId]);
  const search = async () => {
    const own = ++generation.current,
      request = { key: crypto.randomUUID(), controller: new AbortController() };
    current.current = request;
    setBusy(true);
    setError("");
    setResult(null);
    setImports({});
    try {
      const found = await api(
        path + "/web-research",
        "POST",
        { key: request.key, query, ...(model ? { model } : {}) },
        { signal: request.controller.signal },
      );
      if (alive.current && generation.current === own) setResult(found);
    } catch (e) {
      if (alive.current && generation.current === own)
        setError(e instanceof Error ? e.message : "Search failed.");
    } finally {
      if (alive.current && generation.current === own) {
        current.current = null;
        setBusy(false);
      }
    }
  };
  const importPage = async (candidate: WebCandidate) => {
    const own = generation.current;
    setError("");
    setImports((old) => ({ ...old, [candidate.url]: "Importing…" }));
    try {
      await api(path + "/import", "POST", {
        kind: "url",
        title: candidate.title,
        url: candidate.url,
        idempotency: crypto.randomUUID(),
      });
      if (alive.current && own === generation.current) {
        setImports((old) => ({
          ...old,
          [candidate.url]: "Import started. Check Sources for progress.",
        }));
        await onImported();
      }
    } catch (e) {
      if (alive.current && own === generation.current) {
        setImports((old) => ({
          ...old,
          [candidate.url]: "Import could not start.",
        }));
        setError(e instanceof Error ? e.message : "Import failed.");
      }
    }
  };
  return (
    <Dialog
      title="Find web sources"
      error={error}
      onClose={() => {
        cancel();
        onClose();
      }}
    >
      <p>
        Search the web, review the addresses, then import pages you want to
        keep.
      </p>
      <p className="fine">
        Only the query you enter is sent to live web search. Your notebook
        contents are excluded. Results are candidate pages, not evidence.
        Questions use saved, selected source snapshots.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label>
          Search query
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={1000}
            required
            disabled={busy}
          />
        </label>
        <button className="primary" disabled={busy || !query.trim()}>
          Search web
        </button>
        {busy && (
          <button
            type="button"
            onClick={() => {
              cancel();
              setBusy(false);
            }}
          >
            Cancel search
          </button>
        )}
      </form>
      <p role="status">
        {busy
          ? "Finding candidate pages…"
          : result
            ? result.candidates.length
              ? "Review a page address before importing its snapshot."
              : "No candidate pages found. Try a different query."
            : "No pages are imported automatically."}
      </p>
      {result && (
        <>
          <p className="fine">
            Searched {new Date(result.searchedAt).toLocaleString()}. Saved pages
            may change after import.
          </p>
          <ul className="web-candidates">
            {result.candidates.map((candidate) => (
              <li key={candidate.url}>
                <h3>{candidate.title}</h3>
                <p className="candidate-url">{candidate.url}</p>
                <button
                  type="button"
                  disabled={!!imports[candidate.url]}
                  onClick={() => void importPage(candidate)}
                >
                  Import snapshot
                </button>
                {imports[candidate.url] && (
                  <p role="status">{imports[candidate.url]}</p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
