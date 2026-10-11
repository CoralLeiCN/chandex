import React, { useState, type ReactNode } from "react";
import { api } from "./api.ts";
import {
  authoredReferenceNotice,
  noteLink,
  type RichNote,
  type NoteNode,
} from "../domain/notes.ts";
import type { Citation } from "../domain/evidence.ts";

export function RichNoteView({
  content,
  openPassage,
  availability = {},
}: {
  content: RichNote;
  openPassage: (citation: Citation) => void;
  availability?: Record<string, boolean>;
}) {
  let reference = 0;
  function render(node: NoteNode, key: number): ReactNode {
    if (node.type === "citation") {
      const citation = node.attrs!.citation as Citation,
        label = ++reference,
        unavailable = availability[citation.passageId] === false;
      return (
        <button
          type="button"
          key={key}
          className="citation note-reference"
          disabled={unavailable}
          aria-label={`Open attached reference ${label}${unavailable ? ": evidence unavailable" : ""}`}
          title={
            unavailable
              ? "Evidence unavailable"
              : "Attached reference; edited text has not been revalidated"
          }
          onClick={() => openPassage(citation)}
        >
          {label}
          {unavailable ? " · unavailable" : ""}
        </button>
      );
    }
    if (node.type === "text") {
      let result: ReactNode = node.text;
      for (const [i, mark] of (node.marks ?? []).entries()) {
        if (mark.type === "link")
          result = (
            <a
              key={i}
              href={noteLink(mark.attrs!.href)}
              target="_blank"
              rel="noopener noreferrer nofollow"
            >
              {result}
            </a>
          );
        else {
          const tag =
            {
              bold: "strong",
              italic: "em",
              underline: "u",
              strike: "s",
              code: "code",
            }[mark.type] ?? "span";
          result = React.createElement(tag, { key: i }, result);
        }
      }
      return <React.Fragment key={key}>{result}</React.Fragment>;
    }
    const children = (node.content ?? []).map(render);
    if (node.type === "doc")
      return <React.Fragment key={key}>{children}</React.Fragment>;
    if (node.type === "codeBlock")
      return (
        <pre key={key}>
          <code>{children}</code>
        </pre>
      );
    if (node.type === "orderedList")
      return (
        <ol key={key} start={node.attrs?.start ?? 1}>
          {children}
        </ol>
      );
    const tag =
      node.type === "heading"
        ? `h${node.attrs!.level}`
        : ({
            paragraph: "p",
            bulletList: "ul",
            listItem: "li",
            blockquote: "blockquote",
            horizontalRule: "hr",
            hardBreak: "br",
          }[node.type] ?? "div");
    return React.createElement(
      tag,
      { key },
      ["hr", "br"].includes(tag) ? undefined : children,
    );
  }
  return (
    <div className="rich-note-view">
      <p className="fine authored-reference-notice">
        {authoredReferenceNotice}
      </p>
      {render(content.doc, 0)}
    </div>
  );
}

export function NoteHistory({
  notebookId,
  note,
  onOpen,
}: {
  notebookId: string;
  note: any;
  onOpen: (revision: any) => void;
}) {
  const [history, setHistory] = useState<any[]>([]),
    [next, setNext] = useState<number | null>(0),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = async (offset: number) => {
    setBusy(true);
    setError("");
    try {
      const data = await api(
        `/notebooks/${notebookId}/artifacts/${note.id}/revisions?offset=${offset}`,
      );
      setHistory((old) =>
        offset === 0 ? data.results : [...old, ...data.results],
      );
      setNext(data.nextOffset);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details
      className="note-history"
      onToggle={(e) => {
        if (e.currentTarget.open && !history.length && !busy) void load(0);
      }}
    >
      <summary>Revision history</summary>
      {error && <p role="alert">{error}</p>}
      {history.map((revision) => (
        <button
          className="note-history-row small"
          type="button"
          key={revision.id}
          disabled={busy || !revision.available}
          onClick={async () => {
            setBusy(true);
            try {
              const data = await api(
                `/notebooks/${notebookId}/artifacts/${note.id}/revisions/${revision.id}`,
              );
              onOpen({
                ...data,
                historical:
                  revision.id !== (note.currentRevisionId ?? note.revision_id),
                currentRevisionId: note.currentRevisionId ?? note.revision_id,
              });
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <strong>{revision.title ?? note.title}</strong>
          {revision.title == null
            ? " · Historical title not recorded"
            : ""} · {revision.authored ? "Authored" : "Generated original"} ·{" "}
          {new Date(revision.created).toLocaleString()}
          {revision.id === (note.currentRevisionId ?? note.revision_id)
            ? " · Current"
            : ""}
          {!revision.available ? " · Evidence unavailable" : ""}
        </button>
      ))}
      {busy && <p role="status">Loading revisions…</p>}
      {next !== null && (
        <button
          type="button"
          disabled={busy}
          className="small"
          onClick={() => void load(next)}
        >
          {history.length ? "More revisions" : "Load revisions"}
        </button>
      )}
    </details>
  );
}
