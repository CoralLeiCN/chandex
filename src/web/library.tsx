import React, { useEffect, useState, useRef } from "react";
import { api } from "./api.ts";
import {
  NOTEBOOK_TITLE_LIMIT,
  NOTEBOOK_INSTRUCTIONS_LIMIT,
  type DiscoveryResult,
  type NotebookTemplate,
  type NotebookRecipe,
} from "../domain/notebooks.ts";
export const lines = (value: string) =>
  value
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
export function LibraryBrowser({
  books,
  onOpen,
  onUse,
  onEdit,
  templatesOpen = false,
}: {
  books: any[];
  onOpen: (r: DiscoveryResult) => void;
  onUse: (t: NotebookTemplate) => void;
  onEdit: (t: NotebookTemplate | null) => void;
  templatesOpen?: boolean;
}) {
  const [query, setQuery] = useState(""),
    [tag, setTag] = useState(""),
    [archived, setArchived] = useState(false),
    [rows, setRows] = useState<DiscoveryResult[]>([]),
    [next, setNext] = useState<number | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [templates, setTemplates] = useState<NotebookTemplate[]>([]);
  const sequence = useRef(0),
    [applied, setApplied] = useState({ query: "", tag: "", archived: false });
  const search = async (offset = 0) => {
    const request = ++sequence.current,
      criteria = offset ? applied : { query, tag, archived };
    setError("");
    setLoading(true);
    try {
      const p = new URLSearchParams({
        q: criteria.query,
        tag: criteria.tag,
        archived: String(criteria.archived),
        offset: String(offset),
      });
      const response = await api("/library?" + p);
      if (request !== sequence.current) return;
      setApplied(criteria);
      setRows((old) =>
        offset ? [...old, ...response.results] : response.results,
      );
      setNext(response.nextOffset);
    } catch (e) {
      if (request === sequence.current) setError((e as Error).message);
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  };
  useEffect(() => {
    void search();
    void api("/templates")
      .then(setTemplates)
      .catch((e) => setError(e.message));
  }, []);
  const tags = [...new Set(books.flatMap((b) => b.tags ?? []))].sort();
  return (
    <div className="library-browser">
      <p className="fine">
        Find your notebooks, current source text and saved notes on this
        computer. Opening a result switches notebooks; source selections stay as
        they are.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <label>
          Search library
          <input
            value={query}
            maxLength={200}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Topic, source, note or notebook…"
          />
        </label>
        <div className="library-filters">
          <label>
            Tag
            <select value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">All tags</option>
              {tags.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={archived}
              onChange={(e) => setArchived(e.target.checked)}
            />
            Include archived notebooks
          </label>
        </div>
        <button className="primary" disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
      </form>
      {error && (
        <p role="alert" className="error-bar">
          {error}
        </p>
      )}
      <p role="status" className="fine">
        {loading
          ? "Searching local content…"
          : `${rows.length} results${next !== null ? " · More available" : ""}`}
      </p>
      <div className="library-results">
        {rows.map((r) => (
          <button
            key={r.kind + ":" + r.id}
            className="library-result"
            onClick={() => onOpen(r)}
          >
            <strong>{r.title}</strong>
            <small>
              {r.notebookTitle} · {r.kind}
              {r.archived ? " · Archived" : ""}
              {r.locator ? " · " + r.locator : ""}
            </small>
            {r.snippet && <span>{r.snippet}</span>}
            <span className="fine">Open in notebook ↗</span>
          </button>
        ))}
      </div>
      {!loading && !rows.length && (
        <p>
          No matches in the selected notebooks. Try another query or include
          archived notebooks.
        </p>
      )}
      {next !== null && (
        <button
          className="small"
          disabled={
            loading ||
            query !== applied.query ||
            tag !== applied.tag ||
            archived !== applied.archived
          }
          onClick={() => void search(next)}
        >
          Load more results
        </button>
      )}
      <details open={templatesOpen || undefined} className="template-catalog">
        <summary>Notebook templates</summary>
        <p className="fine">
          Reusable settings and questions. Sources and notes are added
          separately.
        </p>
        <button className="small" onClick={() => onEdit(null)}>
          New personal template
        </button>
        {templates.map((t) => (
          <section className="template-card" key={t.id}>
            <h3>{t.title}</h3>
            <p>{t.description}</p>
            <small>
              {t.builtin ? "Built-in" : "Personal"} · Version {t.version}
            </small>
            <div className="dialog-actions">
              <button className="primary" onClick={() => onUse(t)}>
                Use {t.title}
              </button>
              <button className="small" onClick={() => onEdit(t)}>
                {t.builtin ? "Copy" : "Edit"} {t.title}
              </button>
            </div>
          </section>
        ))}
      </details>
    </div>
  );
}
export function TemplateEditor({
  initial,
  onDone,
}: {
  initial: Partial<NotebookTemplate> | null;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? ""),
    [description, setDescription] = useState(initial?.description ?? ""),
    [instructions, setInstructions] = useState(initial?.instructions ?? ""),
    [tags, setTags] = useState((initial?.tags ?? []).join("\n")),
    [questions, setQuestions] = useState((initial?.questions ?? []).join("\n")),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false);
  const custom = initial?.id && !initial.builtin;
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const recipe: NotebookRecipe = {
        title,
        description,
        instructions,
        tags: lines(tags),
        questions: lines(questions),
      };
      await api(
        custom ? "/templates/" + initial!.id : "/templates",
        custom ? "PATCH" : "POST",
        { recipe, ...(custom ? { version: initial!.version } : {}) },
      );
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {initial?.builtin && (
        <p className="fine">
          This creates a personal copy of the built-in recipe.
        </p>
      )}
      <label>
        Template name
        <input
          autoFocus
          required
          maxLength={NOTEBOOK_TITLE_LIMIT * 2}
          value={title}
          onChange={(e) =>
            setTitle(
              Array.from(e.target.value)
                .slice(0, NOTEBOOK_TITLE_LIMIT)
                .join(""),
            )
          }
        />
      </label>
      <label>
        Description
        <textarea
          maxLength={500}
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label>
        Template instructions
        <textarea
          rows={5}
          maxLength={NOTEBOOK_INSTRUCTIONS_LIMIT * 2}
          value={instructions}
          onChange={(e) =>
            setInstructions(
              Array.from(e.target.value)
                .slice(0, NOTEBOOK_INSTRUCTIONS_LIMIT)
                .join(""),
            )
          }
        />
      </label>
      <label>
        Tags (one per line)
        <textarea
          rows={3}
          value={tags}
          onChange={(e) => setTags(e.target.value)}
        />
      </label>
      <label>
        Starter questions (one per line)
        <textarea
          rows={4}
          value={questions}
          onChange={(e) => setQuestions(e.target.value)}
        />
      </label>
      <p className="fine">
        Up to 10 tags of 48 characters and eight questions of 1,000 characters.
        Changes affect future notebooks. Existing notebooks keep their copied
        settings.
      </p>
      {error && (
        <p role="alert" className="error-bar">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button className="primary" disabled={busy}>
          {busy ? "Saving…" : "Save template"}
        </button>
        {custom && (
          <button
            type="button"
            className="danger small"
            disabled={busy}
            onClick={() => setConfirm(true)}
          >
            Delete template
          </button>
        )}
      </div>
      {confirm && (
        <div className="template-delete">
          <p>
            Delete this personal template? Existing notebooks keep their
            snapshots. This removes the recipe from the catalog.
          </p>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void api("/templates/" + initial!.id, "DELETE", {
                version: initial!.version,
              })
                .then(onDone)
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            Confirm delete template
          </button>
          <button
            type="button"
            className="small"
            onClick={() => setConfirm(false)}
          >
            Keep template
          </button>
        </div>
      )}
    </form>
  );
}
