import React, { useState, useEffect, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

async function api(path: string, method = "GET", body?: unknown) {
  const r = await fetch("/api" + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? "Request failed.");
  return data;
}
const uid = () => crypto.randomUUID();
const kinds = [
  ["summary", "◈", "Summary", "The essential ideas"],
  ["briefing", "▤", "Briefing document", "Findings & open questions"],
  ["study-guide", "⌘", "Study guide", "Learn the key concepts"],
  ["faq", "?", "FAQ", "Questions & answers"],
];
function Dialog({
  title,
  children,
  onClose,
  error,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  error?: string;
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
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-label={title}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <button aria-label="Close dialog" onClick={onClose} className="icon">
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
function Answer({
  content,
  openPassage,
}: {
  content: any;
  openPassage: (citation: any) => void;
}) {
  if (content.text) return <p className="prose">{content.text}</p>;
  let count = 0;
  return (
    <>
      <h3>{content.title}</h3>
      {content.blocks?.map((block: any, index: number) => (
        <div className={"answer-block " + block.kind} key={index}>
          <p>{block.text}</p>
          {block.citations.map((c: any, i: number) => (
            <button
              className="citation"
              key={i}
              onClick={() => openPassage(c)}
              title="Open supporting passage"
              aria-label={"Open citation " + ++count}
            >
              {count}
            </button>
          ))}
          {block.kind === "inference" && (
            <span className="inference-label">Inference</span>
          )}
        </div>
      ))}
      {content.coverageWarnings?.length > 0 && (
        <details className="coverage">
          <summary>Coverage notes</summary>
          {content.coverageWarnings.map((w: string, i: number) => (
            <p key={i}>{w}</p>
          ))}
        </details>
      )}
    </>
  );
}

function App() {
  const [books, setBooks] = useState<any[]>([]),
    [nbId, setNbId] = useState(""),
    [page, setPage] = useState<any>(null),
    [convId, setConvId] = useState("");
  const [runtime, setRuntime] = useState<any>(null),
    [model, setModel] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState(""),
    [progress, setProgress] = useState(""),
    [mobile, setMobile] = useState("chat");
  const [modal, setModal] = useState(""),
    [importMode, setImportMode] = useState("paste"),
    [name, setName] = useState(""),
    [text, setText] = useState(""),
    [file, setFile] = useState<File | null>(null);
  const [viewer, setViewer] = useState<any>(null),
    [note, setNote] = useState<any>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const nbRef = useRef(nbId);
  nbRef.current = nbId;
  const refresh = async (id = nbRef.current) => {
    if (id) {
      const p = await api("/notebooks/" + id);
      if (id === nbRef.current) setPage(p);
      return p;
    }
  };
  const list = async () => {
    const b = await api("/notebooks");
    setBooks(b);
    return b;
  };
  const act = async (fn: () => Promise<void>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    }
  };
  useEffect(() => {
    void act(async () => {
      await api("/session");
      const b = await list();
      const remembered = localStorage.getItem("codeboom-notebook");
      if (b.length)
        setNbId(
          b.find((x: any) => x.id === remembered)?.id ??
            b.find((x: any) => !x.archived)?.id ??
            b[0].id,
        );
      void api("/status")
        .then((r) => {
          setRuntime(r);
          setModel(r.models?.find((m: any) => m.isDefault)?.model ?? "");
        })
        .catch((e) => setRuntime({ available: false, error: e.message }));
    });
  }, []);
  useEffect(() => {
    setError("");
  }, [modal]);
  useEffect(() => {
    setPage(null);
    if (!nbId) return;
    localStorage.setItem("codeboom-notebook", nbId);
    void act(async () => {
      const p = await refresh(nbId);
      setConvId(p.conversations[0]?.id ?? "");
    });
  }, [nbId]);
  const conv = page?.conversations.find((c: any) => c.id === convId);
  const selected = conv?.selected ?? [];
  const active = page?.runs.find(
    (r: any) =>
      r.conversation_id === convId &&
      ["queued", "running", "validating"].includes(r.status),
  );
  const importing = page?.jobs.some((j: any) => j.status === "processing");
  useEffect(() => {
    if (!importing) return;
    const timer = setInterval(() => void refresh().catch(() => {}), 1000);
    return () => clearInterval(timer);
  }, [importing, nbId]);
  useEffect(() => {
    if (!active) return;
    const events = new EventSource(
      "/api/notebooks/" + nbId + "/runs/" + active.id + "/events",
    );
    events.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.text) setProgress(data.text);
      if (data.tool) setProgress("Reading your selected sources…");
      if (["completed", "cancelled", "failed", "settled"].includes(data.type)) {
        events.close();
        setProgress("");
        void refresh();
      }
    };
    events.onerror = () => setProgress("Reconnecting to your research…");
    return () => events.close();
  }, [active?.id, nbId]);
  const messages =
    page?.messages.filter((m: any) => m.conversation_id === convId) ?? [];
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, active?.id]);
  const newBook = () => {
    setName("");
    setModal("notebook");
  };
  const addSource = () => {
    setName("");
    setText("");
    setFile(null);
    setImportMode("paste");
    setModal("import");
  };
  const openPassage = (citation: any) =>
    void act(async () => {
      const p = await api(
        "/notebooks/" + nbId + "/passages/" + citation.passageId,
      );
      setViewer({
        title: p.title,
        passages: [p],
        citation,
        historical: p.historical,
      });
      setModal("source");
    });
  const openSource = (source: any) =>
    void act(async () => {
      const s = await api("/notebooks/" + nbId + "/sources/" + source.id);
      setViewer({
        title: s.title,
        warnings: s.revisions.find((r: any) => r.id === s.current_revision)
          ?.warnings
          ? JSON.parse(
              s.revisions.find((r: any) => r.id === s.current_revision)
                .warnings,
            )
          : [],
        passages: s.passages.filter(
          (p: any) => p.revisionId === s.current_revision,
        ),
        source: s,
      });
      setModal("source");
    });
  const send = async (q = question, kind = "answer", retryOf?: string) => {
    if (!q.trim() || !conv) return;
    await act(async () => {
      setBusy(true);
      try {
        await api(
          "/notebooks/" + nbId + "/conversations/" + convId + "/runs",
          "POST",
          { question: q, kind, model, idempotency: uid(), retryOf },
        );
        if (kind === "answer") setQuestion("");
        setProgress("Starting your research…");
        await refresh();
      } finally {
        setBusy(false);
      }
    });
  };
  const saveAnswer = (m: any) =>
    void act(async () => {
      await api("/notebooks/" + nbId + "/artifacts", "POST", {
        runId: m.run_id,
      });
      await refresh();
    });
  const toggleSource = (id: string) =>
    void act(async () => {
      const next = selected.includes(id)
        ? selected.filter((s: string) => s !== id)
        : [...selected, id];
      await api("/notebooks/" + nbId + "/conversations/" + convId, "PATCH", {
        selected: next,
      });
      await refresh();
    });
  const noteText = (n: any) =>
    n.content.text ??
    [n.content.title, ...(n.content.blocks ?? []).map((b: any) => b.text)].join(
      "\n\n",
    );
  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark">
            c<span>·</span>
          </span>
          codeboom
        </a>
        <span className="divider" />
        <span className="top-label">YOUR RESEARCH WORKSPACE</span>
        <div className="top-right">
          <span
            className={"runtime-dot " + (runtime?.available ? "online" : "")}
          />
          <span>
            {runtime === null
              ? "Connecting to Codex"
              : runtime.available
                ? "Codex connected"
                : "Codex needs attention"}
          </span>
          <button
            className="small"
            onClick={() => {
              setModal("runtime");
            }}
          >
            Connection
          </button>
        </div>
      </header>
      <div className="notebook-bar">
        <div>
          <span className="eyebrow">NOTEBOOK</span>
          <div className="notebook-title">
            {books.length > 0 ? (
              <select
                aria-label="Current notebook"
                value={nbId}
                onChange={(e) => setNbId(e.target.value)}
              >
                {books.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title}
                    {b.archived ? " · archived" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <h1>Your research starts here</h1>
            )}
            <button
              className="icon muted"
              aria-label="Create notebook"
              onClick={newBook}
            >
              ＋
            </button>
          </div>
        </div>
        {page && (
          <div className="notebook-actions">
            <span className="scope-pill">◉ Sources only</span>
            <button
              className="small"
              onClick={() => {
                setName(page.title);
                setText(page.instructions);
                setModal("settings");
              }}
            >
              Notebook settings
            </button>
          </div>
        )}
      </div>
      {error && !modal && (
        <div role="alert" className="error-bar">
          {error}
          <button onClick={() => setError("")} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}
      {!page ? (
        <main className="landing">
          <div className="landing-symbol">▤</div>
          <span className="eyebrow">A PLACE TO THINK</span>
          <h1>
            Bring your sources.
            <br />
            Find the connections.
          </h1>
          <p>
            Collect documents, ask questions, and follow every answer back to
            its evidence.
          </p>
          <button className="primary" onClick={newBook}>
            ＋ Create a notebook
          </button>
          <p className="fine">
            Stored on your computer. Selected context is sent to your Codex
            model.
          </p>
        </main>
      ) : (
        <>
          <nav className="mobile-tabs">
            {[
              ["sources", "Sources"],
              ["chat", "Conversation"],
              ["studio", "Notes & Studio"],
            ].map(([id, label]) => (
              <button
                className={mobile === id ? "selected" : ""}
                onClick={() => setMobile(id)}
                key={id}
              >
                {label}
              </button>
            ))}
          </nav>
          <main className={"workspace show-" + mobile}>
            <aside className="sources-panel panel">
              <div className="panel-heading">
                <h2>
                  Sources{" "}
                  <span className="count">
                    {page.sources.filter((s: any) => !s.removed).length}
                  </span>
                </h2>
                <span className="panel-symbol">▤</span>
              </div>
              <button className="add-source" onClick={addSource}>
                ＋ Add sources
              </button>
              <div className="source-selection">
                <span>
                  {
                    selected.filter((id: string) =>
                      page.sources.some((s: any) => s.id === id && !s.removed),
                    ).length
                  }{" "}
                  selected
                </span>
                <span>Use in conversation</span>
              </div>
              <div className="source-list">
                {page.sources
                  .filter((s: any) => !s.removed)
                  .map((s: any) => (
                    <div className="source-row" key={s.id}>
                      <input
                        aria-label={"Select " + s.title}
                        type="checkbox"
                        checked={selected.includes(s.id)}
                        onChange={() => toggleSource(s.id)}
                      />
                      <span className={"file-icon " + s.kind}>
                        {s.kind === "pdf"
                          ? "PDF"
                          : s.kind === "html"
                            ? "↗"
                            : "TXT"}
                      </span>
                      <button
                        className="source-name"
                        onClick={() => openSource(s)}
                      >
                        <strong>{s.title}</strong>
                        <small>
                          {s.derived_from
                            ? "Derived note"
                            : s.origin
                              ? "Web snapshot"
                              : s.kind === "pdf"
                                ? "PDF document"
                                : "Text source"}
                          {s.warnings?.length ? " · See notes" : ""}
                        </small>
                      </button>
                    </div>
                  ))}
              </div>
              {!page.sources.some((s: any) => !s.removed) && (
                <div className="empty-sources">
                  <span>↥</span>
                  <p>
                    A good answer starts
                    <br />
                    with good sources.
                  </p>
                  <small>
                    Add PDFs, text, Markdown,
                    <br />
                    or a public web page.
                  </small>
                </div>
              )}
              {page.jobs
                .filter((j: any) => j.status !== "completed")
                .slice(0, 4)
                .map((j: any) => (
                  <div key={j.id} className={"job " + j.status}>
                    <strong>
                      {j.status === "processing"
                        ? "Reading source…"
                        : "Import needs attention"}
                    </strong>
                    <span>{j.title}</span>
                    {j.error && <small>{j.error}</small>}
                  </div>
                ))}
              <div className="sources-footer">
                <span className="shield">◇</span>
                <p>
                  Answers use your selected sources.
                  <br />
                  <strong>Open a citation to check the evidence.</strong>
                </p>
              </div>
              {page.sources.some((s: any) => s.removed) && (
                <details className="removed">
                  <summary>Removed sources</summary>
                  {page.sources
                    .filter((s: any) => s.removed)
                    .map((s: any) => (
                      <div key={s.id}>
                        <span>{s.title}</span>
                        <button
                          className="small"
                          onClick={() => {
                            setViewer({ source: s, title: s.title });
                            setModal("purge");
                          }}
                        >
                          Purge
                        </button>
                      </div>
                    ))}
                </details>
              )}
            </aside>
            <section className="conversation-panel panel">
              <div className="panel-heading">
                <h2>Conversation</h2>
                <div className="conversation-controls">
                  <select
                    aria-label="Conversation"
                    value={convId}
                    onChange={(e) => setConvId(e.target.value)}
                  >
                    {page.conversations.map((c: any, i: number) => (
                      <option key={c.id} value={c.id}>
                        Conversation {i + 1}
                      </option>
                    ))}
                  </select>
                  <button
                    className="icon"
                    aria-label="New conversation"
                    onClick={() =>
                      void act(async () => {
                        const c = await api(
                          "/notebooks/" + nbId + "/conversations",
                          "POST",
                          {},
                        );
                        await refresh();
                        setConvId(c.id);
                      })
                    }
                  >
                    ＋
                  </button>
                </div>
              </div>
              <div className="messages">
                {!messages.length && !active ? (
                  <div className="conversation-welcome">
                    <span className="welcome-mark">✳</span>
                    <span className="eyebrow">CONNECT THE IDEAS</span>
                    <h2>
                      What would you
                      <br />
                      like to understand?
                    </h2>
                    <p>
                      Explore your sources together. Compare perspectives,
                      <br className="desktop" /> untangle a question, or find
                      the bigger picture.
                    </p>
                    <div className="suggestions">
                      {[
                        "Summarize the key ideas",
                        "Where do the sources disagree?",
                        "What questions remain unanswered?",
                      ].map((s) => (
                        <button key={s} onClick={() => setQuestion(s)}>
                          {s}
                          <span>↗</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((m: any) => (
                    <article className={"message " + m.role} key={m.id}>
                      <div className="message-label">
                        {m.role === "user" ? "YOU" : "✳ CODEBOOM"}
                      </div>
                      {m.role === "user" ? (
                        <p>{m.content.text}</p>
                      ) : (
                        <>
                          <Answer
                            openPassage={openPassage}
                            content={m.content}
                          />
                          {!m.content.text && (
                            <button
                              className="save-answer"
                              onClick={() => saveAnswer(m)}
                            >
                              ＋ Save as note
                            </button>
                          )}
                        </>
                      )}
                    </article>
                  ))
                )}
                {active && (
                  <div className="run-progress" aria-live="polite">
                    <span className="spinner" />
                    <span>{progress || "Working with your sources…"}</span>
                  </div>
                )}
                {page.runs
                  .filter((r: any) => r.conversation_id === convId)
                  .slice(-1)
                  .filter((r: any) =>
                    ["failed", "interrupted", "cancelled"].includes(r.status),
                  )
                  .map((r: any) => (
                    <div key={r.id} className="run-notice">
                      {r.status === "cancelled" ? "Run stopped." : r.error}
                      <button
                        className="small"
                        disabled={!!active}
                        onClick={() => send(r.question, r.kind, r.id)}
                      >
                        Retry
                      </button>
                    </div>
                  ))}
                <div ref={bottom} />
              </div>
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <textarea
                  aria-label="Ask about your sources"
                  placeholder={
                    selected.length
                      ? "Ask a question about your sources…"
                      : "Add and select sources to begin…"
                  }
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="composer-bottom">
                  <span>
                    {selected.length} sources selected{" "}
                    <span className="dot-separator">·</span>{" "}
                    <select
                      aria-label="Codex model"
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                    >
                      {runtime?.models?.map((m: any) => (
                        <option key={m.id} value={m.model}>
                          {m.model}
                        </option>
                      ))}
                    </select>
                  </span>
                  {active ? (
                    <button
                      type="button"
                      className="stop"
                      onClick={() =>
                        void act(async () => {
                          await api(
                            "/notebooks/" +
                              nbId +
                              "/runs/" +
                              active.id +
                              "/cancel",
                            "POST",
                            {},
                          );
                          await refresh();
                        })
                      }
                    >
                      ■ Stop
                    </button>
                  ) : (
                    <button
                      className="send"
                      aria-label="Send question"
                      disabled={
                        !question.trim() ||
                        !selected.length ||
                        busy ||
                        !runtime?.available
                      }
                    >
                      ↑
                    </button>
                  )}
                </div>
              </form>
              <p className="composer-note">
                Check important claims against their cited sources.
              </p>
            </section>
            <aside className="studio-panel panel">
              <div className="panel-heading">
                <h2>Notes & Studio</h2>
                <span className="panel-symbol">✧</span>
              </div>
              <div className="studio-intro">
                <h3>Turn insight into something useful.</h3>
                <p>Create a document from your selected sources.</p>
              </div>
              <div className="studio-grid">
                {kinds.map(([kind, icon, label, desc]) => (
                  <button
                    key={kind}
                    disabled={
                      !selected.length ||
                      !!active ||
                      busy ||
                      !runtime?.available
                    }
                    onClick={() =>
                      send(
                        "Create a comprehensive " +
                          label.toLowerCase() +
                          " using every selected source. Identify disagreements and gaps. Cite each factual statement.",
                        kind,
                      )
                    }
                  >
                    <span className={"studio-icon " + kind}>{icon}</span>
                    <strong>{label}</strong>
                    <small>{desc}</small>
                  </button>
                ))}
              </div>
              <div className="notes-heading">
                <h3>
                  Saved notes{" "}
                  <span className="count">{page.artifacts.length}</span>
                </h3>
                <button
                  className="small"
                  onClick={() => {
                    setNote(null);
                    setName("");
                    setText("");
                    setModal("edit-note");
                  }}
                >
                  ＋ New
                </button>
              </div>
              {!page.artifacts.length ? (
                <div className="empty-notes">
                  <span>▱</span>
                  <p>Keep the useful bits.</p>
                  <small>
                    Save an answer or create
                    <br />
                    your first note.
                  </small>
                </div>
              ) : (
                <div className="notes-list">
                  {page.artifacts.map((a: any) => (
                    <button
                      key={a.id}
                      className="note-card"
                      onClick={() => {
                        setNote(a);
                        setModal("note");
                      }}
                    >
                      <span>▤</span>
                      <div>
                        <strong>{a.title}</strong>
                        <small>
                          {a.authored ? "Your note" : a.kind.replace("-", " ")}{" "}
                          ·{" "}
                          {new Date(a.updated).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                          {a.unavailable ? " · Evidence unavailable" : ""}
                        </small>
                      </div>
                      <span>↗</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="local-note">
                <span>◉</span> Saved on this computer
              </div>
            </aside>
          </main>
        </>
      )}
      {modal === "notebook" && (
        <Dialog
          error={error}
          title="Create a notebook"
          onClose={() => setModal("")}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const n = await api("/notebooks", "POST", { title: name });
                await list();
                setNbId(n.id);
                setModal("");
              });
            }}
          >
            <label>
              Notebook name
              <input
                autoFocus
                value={name}
                maxLength={200}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Product architecture research"
                required
              />
            </label>
            <button className="primary">Create notebook</button>
          </form>
        </Dialog>
      )}
      {modal === "import" && (
        <Dialog error={error} title="Add a source" onClose={() => setModal("")}>
          <div className="import-tabs">
            {[
              ["paste", "Paste text"],
              ["file", "Upload file"],
              ["url", "Web link"],
            ].map(([id, label]) => (
              <button
                className={importMode === id ? "selected" : ""}
                onClick={() => setImportMode(id)}
                key={id}
              >
                {label}
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                setBusy(true);
                try {
                  let payload: any = {
                    title: name,
                    idempotency: uid(),
                    kind: importMode,
                  };
                  if (importMode === "file") {
                    if (!file) throw new Error("Choose a file.");
                    if (file.size > 25 * 1024 * 1024)
                      throw new Error("File exceeds 25 MiB.");
                    const ext = file.name.split(".").pop()?.toLowerCase();
                    const kind =
                      ext === "pdf"
                        ? "pdf"
                        : ext === "md"
                          ? "markdown"
                          : ext === "txt"
                            ? "text"
                            : "";
                    if (!kind)
                      throw new Error("Choose a PDF, Markdown, or TXT file.");
                    const data = new Uint8Array(await file.arrayBuffer());
                    let binary = "";
                    for (let i = 0; i < data.length; i += 8192)
                      binary += String.fromCharCode(
                        ...data.subarray(i, i + 8192),
                      );
                    payload = {
                      ...payload,
                      kind,
                      base64: btoa(binary),
                      title: name || file.name,
                    };
                  } else if (importMode === "url") payload.url = text;
                  else payload.text = text;
                  await api("/notebooks/" + nbId + "/import", "POST", payload);
                  await refresh();
                  setModal("");
                } finally {
                  setBusy(false);
                }
              });
            }}
          >
            <label>
              Source title
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required={importMode !== "file"}
                maxLength={200}
                placeholder="Give this source a useful name"
              />
            </label>
            {importMode === "file" ? (
              <label className="file-drop">
                PDF, Markdown, or TXT · up to 25 MiB
                <input
                  type="file"
                  accept=".pdf,.md,.txt"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    setFile(f);
                    if (f) setName(f.name);
                  }}
                  required
                />
              </label>
            ) : (
              <label>
                {importMode === "url" ? "Public URL" : "Source text"}
                {importMode === "url" ? (
                  <input
                    type="url"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="https://example.com/article"
                    required
                  />
                ) : (
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={10}
                    required
                    placeholder="Paste the material you want to explore…"
                  />
                )}
              </label>
            )}
            <p className="fine">
              Sources are saved as snapshots. Scanned PDFs require a text copy.
            </p>
            <button className="primary" disabled={busy}>
              {busy ? "Adding…" : "Add source"}
            </button>
          </form>
        </Dialog>
      )}
      {modal === "source" && viewer && (
        <Dialog error={error} title={viewer.title} onClose={() => setModal("")}>
          <p className="fine">
            {viewer.citation
              ? viewer.historical
                ? "Historical revision: the stored evidence used for this answer."
                : "The stored passage behind this citation."
              : "Extracted source text."}
          </p>
          {viewer.warnings?.map((warning: string) => (
            <p className="fine" key={warning}>
              {warning}
            </p>
          ))}
          {viewer.passages.map((p: any) => (
            <section className="passage" key={p.id}>
              <span className="eyebrow">
                {p.locator} · {p.revisionId.slice(0, 8)}
              </span>
              <p>
                {viewer.citation?.passageId === p.id ? (
                  <>
                    {Array.from(p.text)
                      .slice(0, viewer.citation.start)
                      .join("")}
                    <mark>{viewer.citation.quote}</mark>
                    {Array.from(p.text).slice(viewer.citation.end).join("")}
                  </>
                ) : (
                  p.text
                )}
              </p>
            </section>
          ))}
          {viewer.source && (
            <div className="dialog-actions">
              {viewer.source.origin && (
                <button
                  className="small"
                  onClick={() =>
                    void act(async () => {
                      await api(
                        "/notebooks/" +
                          nbId +
                          "/sources/" +
                          viewer.source.id +
                          "/refresh",
                        "POST",
                        {},
                      );
                      await refresh();
                      setModal("");
                    })
                  }
                >
                  Refresh snapshot
                </button>
              )}
              <button
                className="danger small"
                onClick={() =>
                  void act(async () => {
                    await api(
                      "/notebooks/" + nbId + "/sources/" + viewer.source.id,
                      "DELETE",
                    );
                    await refresh();
                    setModal("");
                  })
                }
              >
                Remove source
              </button>
            </div>
          )}
        </Dialog>
      )}
      {modal === "settings" && page && (
        <Dialog
          error={error}
          title="Notebook settings"
          onClose={() => setModal("")}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await api("/notebooks/" + nbId, "PATCH", {
                  title: name,
                  instructions: text,
                });
                await refresh();
                await list();
                setModal("");
              });
            }}
          >
            <label>
              Name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={200}
              />
            </label>
            <label>
              Notebook instructions
              <textarea
                rows={5}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Audience, language, or preferred depth…"
              />
            </label>
            <p className="fine">
              Changing instructions starts a fresh research context and stops
              active runs.
            </p>
            <div className="dialog-actions">
              <button className="primary">Save changes</button>
              <button
                type="button"
                className="small"
                onClick={() =>
                  void act(async () => {
                    await api("/notebooks/" + nbId, "PATCH", {
                      archived: !page.archived,
                    });
                    await list();
                    await refresh();
                    setModal("");
                  })
                }
              >
                {page.archived ? "Unarchive" : "Archive"}
              </button>
              <button
                type="button"
                className="danger small"
                onClick={() => setModal("delete-notebook")}
              >
                Delete notebook
              </button>
            </div>
          </form>
        </Dialog>
      )}
      {modal === "note" && note && (
        <Dialog error={error} title={note.title} onClose={() => setModal("")}>
          <Answer openPassage={openPassage} content={note.content} />
          <div className="dialog-actions">
            <button
              className="small"
              onClick={() => {
                setName(note.title);
                setText(noteText(note));
                setModal("edit-note");
              }}
            >
              Edit
            </button>
            <a
              className="button small"
              href={
                "/api/notebooks/" + nbId + "/artifacts/" + note.id + "/export"
              }
            >
              Export Markdown
            </a>
            <button
              className="small"
              disabled={!!note.unavailable}
              onClick={() =>
                void act(async () => {
                  await api(
                    "/notebooks/" + nbId + "/artifacts/" + note.id + "/promote",
                    "POST",
                    {},
                  );
                  await refresh();
                  setModal("");
                })
              }
            >
              Use as a source
            </button>
          </div>
          <p className="fine">Promoted notes are labeled as derived content.</p>
        </Dialog>
      )}
      {modal === "edit-note" && (
        <Dialog
          error={error}
          title={note ? "Edit note" : "New note"}
          onClose={() => setModal("")}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await api(
                  "/notebooks/" +
                    nbId +
                    "/artifacts" +
                    (note ? "/" + note.id : ""),
                  note ? "PATCH" : "POST",
                  { title: name, text },
                );
                await refresh();
                setModal("");
              });
            }}
          >
            <label>
              Title
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={200}
              />
            </label>
            <label>
              Note
              <textarea
                rows={12}
                value={text}
                onChange={(e) => setText(e.target.value)}
                required
              />
            </label>
            {note && (
              <p className="fine">
                Edits become user-authored. Previous generated content and
                citations remain in the saved revision history.
              </p>
            )}
            <button className="primary">Save note</button>
          </form>
        </Dialog>
      )}
      {modal === "purge" && (
        <Dialog
          error={error}
          title="Purge retained evidence"
          onClose={() => setModal("")}
        >
          <p>
            This removes the retained content of “{viewer.title}” from this
            notebook and makes affected generated outputs unavailable.
            User-authored notes, exported files, and existing backups remain.
          </p>
          <button
            className="danger"
            onClick={() =>
              void act(async () => {
                await api(
                  "/notebooks/" +
                    nbId +
                    "/sources/" +
                    viewer.source.id +
                    "?purge=true",
                  "DELETE",
                );
                await refresh();
                setModal("");
              })
            }
          >
            Purge source content
          </button>
        </Dialog>
      )}
      {modal === "delete-notebook" && (
        <Dialog
          error={error}
          title="Delete this notebook?"
          onClose={() => setModal("")}
        >
          <p>
            Delete this notebook's local sources, conversations, notes, and
            generated documents. Existing exports and backups remain.
          </p>
          <button
            className="danger"
            onClick={() =>
              void act(async () => {
                await api("/notebooks/" + nbId, "DELETE");
                const b = await list();
                setNbId(b[0]?.id ?? "");
                setPage(null);
                setModal("");
              })
            }
          >
            Delete notebook
          </button>
        </Dialog>
      )}
      {modal === "runtime" && (
        <Dialog
          error={error}
          title="Codex connection"
          onClose={() => setModal("")}
        >
          <p>
            {runtime?.available
              ? "Codex is connected and ready to work with your selected sources."
              : (runtime?.error ?? "Checking the local Codex connection…")}
          </p>
          <p>
            Notebook data is stored on this computer. Questions and selected
            evidence are sent to the model provider configured in Codex.
          </p>
          <p className="fine">
            Usage and cost are unavailable for this integration.
          </p>
          <p className="fine">
            If sign-in is needed, run <code>npx codex login</code> in this
            project, then check the connection again.
          </p>
          <button
            className="primary"
            onClick={() =>
              void act(async () => {
                setRuntime(await api("/status?refresh=1"));
              })
            }
          >
            Check connection
          </button>
        </Dialog>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
