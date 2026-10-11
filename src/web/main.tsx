import React, {
  useState,
  useEffect,
  useRef,
  lazy,
  Suspense,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { documentGroups, documentText } from "../domain/artifacts.ts";

import { api } from "./api.ts";
import { VoiceQuestion } from "./voice-question.tsx";
import { DriveControls } from "./drive-connection.tsx";
import { WebResearchDialog } from "./web-research.tsx";
import { SlideMaterial } from "./slides.tsx";
import { InfographicMaterial } from "./infographic.tsx";
import type { DriveConnectionStatus } from "../connectors/drive-connection.ts";
import { StudyMaterial } from "./study.tsx";
import { isStudyKind } from "../domain/study.ts";
import { StructuredMaterial } from "./structured.tsx";
import { isStructuredKind } from "../domain/structured.ts";
import { LibraryBrowser, TemplateEditor, lines } from "./library.tsx";
import { sourceViewer, audioTechnicalWarning } from "./source-viewer.ts";
import { RichNoteView, NoteHistory } from "./notes.tsx";
import { AudioOverview } from "./audio-overview.tsx";
import { Dialog } from "./dialog.tsx";
import { NoteEditorDialog } from "./note-dialog.tsx";
const RichNoteEditor = lazy(() =>
  import("./note-editor.tsx").then((module) => ({
    default: module.RichNoteEditor,
  })),
);
import { isRichNote } from "../domain/notes.ts";
import {
  NOTEBOOK_TITLE_LIMIT,
  NOTEBOOK_INSTRUCTIONS_LIMIT,
  type NotebookTemplate,
  type DiscoveryResult,
} from "../domain/notebooks.ts";
import {
  fileType,
  fileAccept,
  fileKinds,
  sourceType,
} from "../domain/source-types.ts";
const uid = () => crypto.randomUUID();
const kinds = [
  ["summary", "◈", "Summary", "The essential ideas"],
  ["briefing", "▤", "Briefing document", "Findings & open questions"],
  ["study-guide", "⌘", "Study guide", "Learn the key concepts"],
  ["faq", "?", "FAQ", "Questions & answers"],
  ["flashcards", "▧", "Flashcards", "Review cited answers"],
  ["quiz", "✓", "Quiz", "Practice with evidence"],
  ["mind-map", "⌥", "Mind map", "Explore cited relationships"],
  ["data-table", "▦", "Data table", "Compare cited values"],
  ["slides", "▰", "Slides", "Present cited ideas"],
  ["infographic", "▦", "Infographic", "Visualize cited ideas"],
  ["audio-overview", "♫", "Audio overview", "A cited script, then speech"],
];
function Answer({
  content,
  openPassage,
}: {
  content: any;
  openPassage: (citation: any) => void;
}) {
  if (isRichNote(content))
    return <RichNoteView content={content} openPassage={openPassage} />;
  if (content.text) return <p className="prose">{content.text}</p>;
  let count = 0;
  return (
    <>
      {content.title && <h3>{content.title}</h3>}
      {documentGroups<any>(content).map((group, groupIndex) => (
        <section key={groupIndex}>
          {group.title && <h4>{group.title}</h4>}
          {!isStudyKind(content.kind) &&
            group.title &&
            !group.blocks.length && (
              <p className="fine">
                No supported content was produced for this section.
              </p>
            )}
          {group.blocks.map((block: any, index: number) => (
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
        </section>
      ))}
      {content.coverageWarnings?.length > 0 && (
        <details className="coverage">
          <summary>Coverage notes</summary>
          {content.coverageWarnings.map((w: string, i: number) => (
            <p key={i}>{w}</p>
          ))}
        </details>
      )}
      {content.coverage?.length > 0 && (
        <details className="coverage">
          <summary>
            {content.coverage.some((s: any) => s.readPassages < s.totalPassages)
              ? "Partial evidence coverage"
              : "Evidence coverage"}
          </summary>
          <p>
            Counts show passages returned by evidence tools in this run. They do
            not establish that every claim is supported.
          </p>
          {content.coverage.map((s: any) => (
            <div key={s.revisionId}>
              <p>
                <strong>{s.title}</strong>: {s.readPassages} of{" "}
                {s.totalPassages} passages read.
              </p>
              {s.omittedSections.length > 0 && (
                <ul>
                  {s.omittedSections.map((section: any, i: number) => (
                    <li key={i}>
                      {section.locator}: {section.unreadPassages} of{" "}
                      {section.totalPassages} passages not read.
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </details>
      )}
    </>
  );
}
function GenerationDetails({ run }: { run: any }) {
  if (!run) return null;
  const stats = run.stats;
  const budgetLabels: Record<string, string> = {
    evidence_calls: "evidence calls",
    evidence_characters: "evidence characters",
    model_context: "selected-model context capacity",
    model_context_unknown: "unavailable model context capacity",
    deadline: "generation deadline",
  };
  const count = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value.toLocaleString()
      : "Unknown";
  const duration = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? (value / 1000).toFixed(2) + " s"
      : "Unknown";
  return (
    <details className="coverage generation-details">
      <summary>Generation details</summary>
      <dl>
        <dt>Status</dt>
        <dd>{run.status}</dd>
        <dt>Model</dt>
        <dd>{run.model || "Not recorded"}</dd>
        <dt>Pinned Codex runtime</dt>
        <dd>{run.runtime_version ?? "Unknown"}</dd>
        {run.study_count !== null && run.study_count !== undefined && (
          <>
            <dt>Requested study items</dt>
            <dd>{count(run.study_count)}</dd>
          </>
        )}
        <dt>Selected sources</dt>
        <dd>{count(stats?.sourceCount)}</dd>
        <dt>First progress</dt>
        <dd>{duration(stats?.firstProgressMs)}</dd>
        <dt>Run duration</dt>
        <dd>{duration(stats?.elapsedMs)}</dd>
        <dt>Evidence tool calls</dt>
        <dd>{count(stats?.toolCalls)}</dd>
        <dt>Evidence response characters</dt>
        <dd>{count(stats?.evidenceCharacters)}</dd>
        <dt>Model context window (tokens)</dt>
        <dd>{count(stats?.context?.modelContextWindow)}</dd>
        {stats?.context && (
          <>
            <dt>Largest reported context tokens</dt>
            <dd>{count(stats.context.reportedContextTokens)}</dd>
            <dt>Context budget bytes charged</dt>
            <dd>{count(stats.context.chargedBytes)}</dd>
            <dt>Context reserve tokens</dt>
            <dd>{count(stats.context.reservedTokens)}</dd>
          </>
        )}
        <dt>Provider token usage</dt>
        <dd>
          {stats?.usage
            ? count(stats.usage.totalTokens) + " tokens reported"
            : "Unknown — not reported by the runtime"}
        </dd>
        {stats?.usage && (
          <>
            <dt>Input tokens</dt>
            <dd>{count(stats.usage.inputTokens)}</dd>
            <dt>Cached input tokens</dt>
            <dd>{count(stats.usage.cachedInputTokens)}</dd>
            <dt>Cache-write input tokens</dt>
            <dd>{count(stats.usage.cacheWriteInputTokens)}</dd>
            <dt>Output tokens</dt>
            <dd>{count(stats.usage.outputTokens)}</dd>
            <dt>Reasoning output tokens</dt>
            <dd>{count(stats.usage.reasoningOutputTokens)}</dd>
          </>
        )}
        <dt>Monetary cost</dt>
        <dd>Unknown — not reported</dd>
      </dl>
      {stats?.context && (
        <p className="fine">
          Context admission uses a conservative byte allowance and a generation
          reserve. These budget values are separate from reported provider
          usage.
          {stats.context.capacityRefusals > 0 &&
            (stats.context.modelContextWindow === null
              ? " Evidence was withheld because the runtime did not report capacity."
              : " Evidence was initially withheld until the runtime reported capacity.")}
        </p>
      )}
      {stats?.usage && (
        <p className="fine">
          Reported cumulative usage for this run, including any citation repair.
          It is not a monetary estimate.
        </p>
      )}
      {stats?.budgetReached?.length > 0 && (
        <p className="fine">
          Budget reached:{" "}
          {stats.budgetReached
            .map(
              (budget: string) => budgetLabels[budget] ?? "unrecognized budget",
            )
            .join(", ")}
          .
        </p>
      )}
      <h4>Notebook instructions</h4>
      <p className="fine">
        {run.instruction_version === null
          ? "Instruction version not recorded for this legacy run."
          : "Recorded instruction version " +
            run.instruction_version +
            "."}{" "}
        Sources-only grounding.
      </p>
      <p className="prose">
        {run.instruction_snapshot === null
          ? "Original instructions were not retained for this legacy run."
          : run.instruction_snapshot || "No custom notebook instructions."}
      </p>
    </details>
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
  const [driveStatus, setDriveStatus] = useState<DriveConnectionStatus | null>(
    null,
  );
  const [question, setQuestion] = useState(""),
    [voiceBusy, setVoiceBusy] = useState(false),
    [progress, setProgress] = useState(""),
    [mobile, setMobile] = useState("chat");
  const [modal, setModal] = useState(""),
    [importMode, setImportMode] = useState("paste"),
    [name, setName] = useState(""),
    [text, setText] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [retryJob, setRetryJob] = useState<any>(null);
  const [viewer, setViewer] = useState<any>(null),
    [note, setNote] = useState<any>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const addSourcesControl = useRef<HTMLButtonElement>(null);
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
    setRetryJob(null);
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
      if (
        ["completed", "cancelled", "failed", "interrupted", "settled"].includes(
          data.type,
        )
      ) {
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
  const freshContext =
    messages.length > 0 &&
    page?.runs.some(
      (r: any) =>
        r.conversation_id === convId && r.generation !== page.generation,
    ) &&
    !page?.runs.some(
      (r: any) =>
        r.conversation_id === convId &&
        r.generation === page.generation &&
        r.status === "completed",
    );
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, active?.id]);
  const newBook = () =>
    void act(async () => {
      setTemplates(await api("/templates"));
      setTemplateId("");
      setName("");
      setText("");
      setTagText("");
      setQuestionText("");
      setModal("notebook");
    });
  const addSource = () => {
    setRetryJob(null);
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
        provenance: p,
        derivedFrom: p.derivedFrom,
        warnings: p.warnings,
        returnToNote: modal === "note",
      });
      setModal("source");
    });
  const openSource = (source: any) =>
    void act(async () => {
      const s = await api("/notebooks/" + nbId + "/sources/" + source.id);
      setViewer(sourceViewer(s));
      setModal("source");
    });
  const [itemCount, setItemCount] = useState(10);
  const [templates, setTemplates] = useState<NotebookTemplate[]>([]),
    [templateId, setTemplateId] = useState(""),
    [tagText, setTagText] = useState(""),
    [questionText, setQuestionText] = useState(""),
    [templateDraft, setTemplateDraft] =
      useState<Partial<NotebookTemplate> | null>(null),
    [libraryTemplatesOpen, setLibraryTemplatesOpen] = useState(false),
    [pendingDiscovery, setPendingDiscovery] = useState<DiscoveryResult | null>(
      null,
    );
  useEffect(() => {
    if (
      !pendingDiscovery ||
      page?.id !== pendingDiscovery.notebookId ||
      nbId !== pendingDiscovery.notebookId
    )
      return;
    let stopped = false;
    const result = pendingDiscovery;
    void (async () => {
      try {
        if (result.kind === "passage") {
          const p = await api(
            `/notebooks/${result.notebookId}/passages/${result.id}`,
          );
          if (stopped) return;
          setViewer({
            title: p.title,
            passages: [p],
            historical: p.historical,
            provenance: p,
            derivedFrom: p.derivedFrom,
            warnings: p.warnings,
          });
          setModal("source");
        } else if (result.kind === "source") {
          const s = await api(
            `/notebooks/${result.notebookId}/sources/${result.id}`,
          );
          if (stopped) return;
          setViewer(sourceViewer(s));
          setModal("source");
        } else if (result.kind === "note") {
          const current = await api(`/notebooks/${result.notebookId}`);
          if (stopped) return;
          const n = current.artifacts.find((a: any) => a.id === result.id);
          if (!n || (n.unavailable && !n.authored))
            throw new Error("This note is no longer available. Search again.");
          setNote(n);
          setModal("note");
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        if (!stopped) setPendingDiscovery(null);
      }
    })();
    return () => {
      stopped = true;
    };
  }, [pendingDiscovery, page?.id, nbId]);
  const send = async (q = question, kind = "answer", retryOf?: string) => {
    if (!q.trim() || !conv || active || busy || voiceBusy || !selected.length)
      return;
    await act(async () => {
      setBusy(true);
      try {
        await api(
          "/notebooks/" + nbId + "/conversations/" + convId + "/runs",
          "POST",
          {
            question: q,
            kind,
            model,
            idempotency: uid(),
            retryOf,
            ...(isStudyKind(kind) && !retryOf ? { itemCount } : {}),
          },
        );
        if (kind === "answer") setQuestion("");
        setProgress("Starting your research…");
        await refresh();
      } finally {
        setBusy(false);
        if (kind === "answer") composer.current?.focus();
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
  const resolveImportDuplicate = (job: string, action: "reuse" | "dismiss") =>
    void act(async () => {
      const result = await api(
        "/notebooks/" + nbId + "/jobs/" + job + "/duplicate",
        "POST",
        { action },
      );
      await refresh();
      if (result.status === "failed") setError(result.error);
      addSourcesControl.current?.focus();
    });
  const retryImport = (job: any, reenter = false) => {
    if (
      !reenter &&
      (["refresh", "promotion"].includes(job.type) ||
        ["url", "drive"].includes(job.input_kind))
    ) {
      void act(async () => {
        setBusy(true);
        try {
          await api(
            "/notebooks/" + nbId + "/jobs/" + job.id + "/retry",
            "POST",
            { idempotency: uid() },
          );
          await refresh();
          addSourcesControl.current?.focus();
        } finally {
          setBusy(false);
        }
      });
      return;
    }
    setRetryJob(job);
    setName(job.title);
    setText(
      job.input_kind === "url" && job.input_metadata
        ? (JSON.parse(job.input_metadata).url ?? "")
        : job.input_kind === "drive" && job.input_metadata
          ? (JSON.parse(job.input_metadata).driveUrl ?? "")
          : "",
    );
    setFile(null);
    setImportMode(
      job.input_kind === "url"
        ? "url"
        : job.input_kind === "drive"
          ? "drive"
          : fileKinds.includes(job.input_kind)
            ? "file"
            : "paste",
    );
    setModal("import");
  };
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
            <button
              className="small"
              onClick={() => {
                setLibraryTemplatesOpen(false);
                setModal("library");
              }}
            >
              Library
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
                setTagText(page.tags.join("\n"));
                setQuestionText(page.starterQuestions.join("\n"));
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
          <nav className="mobile-tabs" aria-label="Notebook views">
            {[
              ["sources", "Sources"],
              ["chat", "Conversation"],
              ["studio", "Notes & Studio"],
            ].map(([id, label]) => (
              <button
                className={mobile === id ? "selected" : ""}
                aria-pressed={mobile === id}
                aria-controls={id + "-panel"}
                onClick={() => setMobile(id)}
                key={id}
              >
                {label}
              </button>
            ))}
          </nav>
          <p className="mobile-context" role="status">
            {selected.length} sources selected
            {active
              ? " · " + (progress || "Generation in progress")
              : " · Sources only"}
          </p>
          <main className={"workspace show-" + mobile}>
            <aside
              id="sources-panel"
              className="sources-panel panel"
              aria-label="Sources"
            >
              <div className="panel-heading">
                <h2>
                  Sources{" "}
                  <span className="count">
                    {page.sources.filter((s: any) => !s.removed).length}
                  </span>
                </h2>
                <span className="panel-symbol">▤</span>
              </div>
              <button
                ref={addSourcesControl}
                className="add-source"
                onClick={addSource}
              >
                ＋ Add sources
              </button>
              <button
                className="add-source"
                onClick={() => setModal("web-research")}
              >
                Find web sources
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
                        disabled={!!conv?.note_revision || voiceBusy}
                        onChange={() => toggleSource(s.id)}
                      />
                      <span className={"file-icon " + s.kind}>
                        {s.kind === "html"
                          ? "↗"
                          : (sourceType(s.kind)?.badge ?? "TXT")}
                      </span>
                      <button
                        className="source-name"
                        onClick={() => openSource(s)}
                      >
                        <strong>{s.title}</strong>
                        <small>
                          Ready ·{" "}
                          {s.derived_from
                            ? s.derived_origin === "generated"
                              ? "Generated origin · derived note"
                              : s.derived_origin === "user"
                                ? "User note · derived content"
                                : "Derived note · origin unknown"
                            : s.drive?.provider === "google-drive"
                              ? "Drive snapshot"
                              : s.origin
                                ? "Web snapshot"
                                : (sourceType(s.kind)?.label ?? "Text source")}
                          {s.warnings?.length ? " · See extraction notes" : ""}
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
                    Add documents, slides, spreadsheets,
                    <br />
                    text or a public web page.
                  </small>
                </div>
              )}
              {[
                ...page.jobs.filter((j: any) => j.status === "duplicate"),
                ...page.jobs
                  .filter(
                    (j: any) =>
                      ["processing", "failed"].includes(j.status) &&
                      !page.jobs.some((next: any) => next.retry_of === j.id),
                  )
                  .slice(0, 4),
              ].map((j: any) => (
                <div key={j.id} className={"job " + j.status}>
                  <strong>
                    {j.status === "processing"
                      ? j.input_kind === "audio"
                        ? "Transcribing audio…"
                        : "Reading source…"
                      : j.status === "duplicate"
                        ? "Identical content found"
                        : "Import needs attention"}
                  </strong>
                  <span>{j.title}</span>
                  {j.error && <small>{j.error}</small>}
                  <small>
                    Attempt {j.attempt_count}
                    {j.retry_of ? " · retry" : ""}
                  </small>
                  {j.status === "failed" && (
                    <button
                      className="small"
                      disabled={busy}
                      onClick={() => retryImport(j)}
                    >
                      {["refresh", "promotion"].includes(j.type) ||
                      j.input_kind === "url"
                        ? "Retry import"
                        : "Retry with input"}
                    </button>
                  )}
                  {j.status === "failed" &&
                    j.type === "import" &&
                    j.input_kind === "url" && (
                      <button
                        className="small"
                        disabled={busy}
                        onClick={() => retryImport(j, true)}
                      >
                        Edit input and retry
                      </button>
                    )}
                  <details>
                    <summary>Import details</summary>
                    <dl>
                      <dt>Operation</dt>
                      <dd>
                        {j.type === "refresh"
                          ? "URL refresh"
                          : j.type === "promotion"
                            ? "Note promotion"
                            : j.type === "import"
                              ? "Source import"
                              : "Not recorded"}
                      </dd>
                      <dt>Created</dt>
                      <dd>{new Date(j.created).toLocaleString()}</dd>
                      <dt>Started</dt>
                      <dd>
                        {j.started
                          ? new Date(j.started).toLocaleString()
                          : "Not recorded"}
                      </dd>
                      <dt>Finished</dt>
                      <dd>
                        {j.ended
                          ? new Date(j.ended).toLocaleString()
                          : "Not yet finished or not recorded"}
                      </dd>
                    </dl>
                  </details>
                  {j.status === "duplicate" && (
                    <>
                      <small>
                        This content is already saved as{" "}
                        {page.sources.find((s: any) => s.id === j.source_id)
                          ?.title ?? "an existing source"}
                        . Reuse it or dismiss this import. Your source selection
                        stays as it is.
                      </small>
                      <div className="job-actions">
                        <button
                          className="small"
                          onClick={() => resolveImportDuplicate(j.id, "reuse")}
                        >
                          Reuse existing source
                        </button>
                        <button
                          className="small"
                          onClick={() =>
                            resolveImportDuplicate(j.id, "dismiss")
                          }
                        >
                          Dismiss import
                        </button>
                      </div>
                    </>
                  )}
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
            <section
              id="chat-panel"
              className="conversation-panel panel"
              aria-label="Conversation"
            >
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
                        {c.note_revision ? c.title : `Conversation ${i + 1}`}
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
                      {(page.starterQuestions?.length
                        ? page.starterQuestions
                        : [
                            "Summarize the key ideas",
                            "Where do the sources disagree?",
                            "What questions remain unanswered?",
                          ]
                      ).map((s: string) => (
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
                          <GenerationDetails
                            run={page.runs.find((r: any) => r.id === m.run_id)}
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
                    <div key={r.id} className="run-notice" role="status">
                      <p>
                        {r.status === "cancelled" ? "Run stopped." : r.error}
                      </p>
                      <GenerationDetails run={r} />
                      {r.failureDraft && (
                        <details className="unverified-draft">
                          <summary>Inspect unverified draft</summary>
                          <p className="fine">
                            This draft failed validation. Its claims and
                            references have not been verified.
                          </p>
                          <p className="prose">{r.failureDraft.text}</p>
                          {r.failureDraft.truncated && (
                            <p className="fine">
                              The draft preview was limited to 200,000
                              characters.
                            </p>
                          )}
                        </details>
                      )}
                      <button
                        className="small"
                        disabled={!!active || voiceBusy}
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
                {freshContext && (
                  <p className="fine" role="status">
                    Sources or instructions changed. Ask a self-contained
                    question. Earlier messages remain visible but are not sent
                    to this research context.
                  </p>
                )}
                <textarea
                  ref={composer}
                  disabled={voiceBusy}
                  maxLength={10000}
                  aria-label={
                    conv?.note_revision
                      ? "Ask about this note"
                      : "Ask about your sources"
                  }
                  placeholder={
                    selected.length
                      ? conv?.note_revision
                        ? "Ask a question about this saved note…"
                        : "Ask a question about your sources…"
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
                {conv?.note_revision && (
                  <p className="fine">
                    Using this saved version of the note. Open the updated note
                    to include later edits.
                  </p>
                )}
                {conv?.note_revision && (
                  <VoiceQuestion
                    key={`${nbId}:${convId}`}
                    notebookId={nbId}
                    disabled={!!active || busy || !selected.length}
                    value={question}
                    onChange={setQuestion}
                    textarea={composer}
                    onBusy={setVoiceBusy}
                  />
                )}
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
                      aria-label="Stop generation"
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
                          composer.current?.focus();
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
                        voiceBusy ||
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
            <aside
              id="studio-panel"
              className="studio-panel panel"
              aria-label="Notes and Studio"
            >
              <div className="panel-heading">
                <h2>Notes & Studio</h2>
                <span className="panel-symbol">✧</span>
              </div>
              <div className="studio-intro">
                <h3>Turn insight into something useful.</h3>
                <p>Create a document from your selected sources.</p>
              </div>
              <label className="study-count">
                Flashcard / quiz items
                <select
                  value={itemCount}
                  onChange={(e) => setItemCount(Number(e.target.value))}
                >
                  {Array.from({ length: 16 }, (_, index) => index + 5).map(
                    (count) => (
                      <option key={count} value={count}>
                        {count}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <div className="studio-grid">
                {kinds
                  .filter(
                    ([kind]) =>
                      kind !== "audio-overview" ||
                      runtime?.audioOverviewsEnabled,
                  )
                  .map(([kind, icon, label, desc]) => (
                    <button
                      key={kind}
                      disabled={
                        !selected.length ||
                        !!active ||
                        busy ||
                        voiceBusy ||
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
                const selectedTemplate = templates.find(
                  (t) => t.id === templateId,
                );
                const n = await api("/notebooks", "POST", {
                  title: name,
                  instructions: text,
                  tags: lines(tagText),
                  questions: lines(questionText),
                  ...(selectedTemplate
                    ? {
                        templateId: selectedTemplate.id,
                        templateVersion: selectedTemplate.version,
                      }
                    : {}),
                });
                await list();
                setNbId(n.id);
                setModal("");
              });
            }}
          >
            <label>
              Notebook template
              <select
                value={templateId}
                onChange={(e) => {
                  const t = templates.find((t) => t.id === e.target.value);
                  setTemplateId(e.target.value);
                  setText(t?.instructions ?? "");
                  setTagText((t?.tags ?? []).join("\n"));
                  setQuestionText((t?.questions ?? []).join("\n"));
                  if (!name && t) setName(t.title);
                }}
              >
                <option value="">Blank notebook</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                    {t.builtin ? " · built-in" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Notebook name
              <input
                autoFocus
                value={name}
                maxLength={NOTEBOOK_TITLE_LIMIT * 2}
                onChange={(e) =>
                  setName(
                    Array.from(e.target.value)
                      .slice(0, NOTEBOOK_TITLE_LIMIT)
                      .join(""),
                  )
                }
                placeholder="e.g. Product architecture research"
                required
              />
            </label>
            <label>
              Notebook instructions
              <textarea
                rows={4}
                value={text}
                maxLength={NOTEBOOK_INSTRUCTIONS_LIMIT * 2}
                onChange={(e) =>
                  setText(
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
                rows={2}
                value={tagText}
                onChange={(e) => setTagText(e.target.value)}
              />
            </label>
            <label>
              Starter questions (one per line)
              <textarea
                rows={3}
                value={questionText}
                onChange={(e) => setQuestionText(e.target.value)}
              />
            </label>
            <p className="fine">
              Templates copy settings into an empty notebook. Add sources before
              using a starter question.
            </p>
            <button className="primary">Create notebook</button>
          </form>
        </Dialog>
      )}
      {modal === "web-research" && nbId && (
        <WebResearchDialog
          key={nbId}
          notebookId={nbId}
          model={model || undefined}
          onClose={() => setModal("")}
          onImported={() => refresh(nbId)}
        />
      )}
      {modal === "import" && (
        <Dialog
          error={error}
          title={retryJob ? "Retry source import" : "Add a source"}
          onClose={() => setModal("")}
        >
          <div className="import-tabs">
            {[
              ["paste", "Paste text"],
              ["file", "Upload file"],
              ["url", "Web link"],
              ["drive", "Google Drive"],
            ].map(([id, label]) => (
              <button
                className={importMode === id ? "selected" : ""}
                aria-pressed={importMode === id}
                onClick={() => setImportMode(id)}
                key={id}
              >
                {label}
              </button>
            ))}
          </div>
          {importMode === "drive" && (
            <DriveControls onStatus={setDriveStatus} />
          )}
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
                    ...(retryJob ? { retryOf: retryJob.id } : {}),
                  };
                  if (importMode === "file") {
                    if (!file) throw new Error("Choose a file.");
                    if (file.size > 25 * 1024 * 1024)
                      throw new Error("File exceeds 25 MiB.");
                    const kind = fileType(file.name)?.kind;
                    if (!kind)
                      throw new Error(
                        "Choose PDF, PNG, JPEG, WebP, Markdown, TXT, DOCX, PPTX, XLSX, CSV, TSV, SRT, WebVTT, WAV, MP3, M4A, AAC, FLAC, Ogg or Opus. Legacy, encrypted and macro-enabled Office files are unsupported.",
                      );
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
                  else if (importMode === "drive") payload.driveUrl = text;
                  else payload.text = text;
                  await api("/notebooks/" + nbId + "/import", "POST", payload);
                  await refresh();
                  setModal("");
                  if (retryJob)
                    requestAnimationFrame(() =>
                      addSourcesControl.current?.focus(),
                    );
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
            {retryJob && (
              <p className="fine">
                Retrying {retryJob.title}. Provide the input again or correct
                it; failed import bytes are not retained.
              </p>
            )}
            {importMode === "file" ? (
              <label className="file-drop">
                PDF, PNG, JPEG, WebP, Markdown, TXT, DOCX, PPTX, XLSX, CSV or
                TSV; SRT or WebVTT captions; WAV, MP3, M4A, AAC, FLAC, Ogg or
                Opus · up to 25 MiB
                <input
                  type="file"
                  accept={fileAccept}
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
                {importMode === "url"
                  ? "Public URL"
                  : importMode === "drive"
                    ? "Google file link or ID"
                    : "Source text"}
                {importMode === "url" || importMode === "drive" ? (
                  <input
                    type={importMode === "url" ? "url" : "text"}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={
                      importMode === "drive"
                        ? "Drive, Docs, Sheets or Slides file link"
                        : "https://example.com/article"
                    }
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
              Sources are saved as snapshots. Images and scanned PDF pages use
              local English OCR; check recognized text against the original.
              {importMode === "file" &&
                " Audio is transcribed locally in English, with estimated times. Listen to the original to check names, numbers and commitments. Recordings are limited to ten minutes and 24 million decoded channel samples; AAC-LC and simple M4A timelines are supported."}
              {importMode === "file" &&
                " Office text, tables and notes are extracted with limitations; embedded images and macros are unsupported. Spreadsheet formulas are kept without calculation."}
              {importMode === "file" &&
                " Caption files retain declared cue timing and speaker labels; check wording and timing against the recording. Styling is flattened and overlapping cues are retained."}
              {importMode === "drive" &&
                " Google Docs, Sheets and Slides are retained as Office exports, with extraction limitations. Native exports are limited to 10 MB, uploaded files to 25 MiB. Refresh is manual; folders and shortcuts are unsupported."}
            </p>
            <button
              className="primary"
              disabled={
                busy ||
                (importMode === "drive" && driveStatus?.state !== "connected")
              }
            >
              {busy ? "Adding…" : "Add source"}
            </button>
          </form>
        </Dialog>
      )}
      {modal === "source" && viewer && (
        <Dialog
          error={error}
          title={viewer.title}
          onClose={() => setModal(viewer.returnToNote ? "note" : "")}
        >
          <p className="fine">
            {viewer.citation
              ? viewer.historical
                ? "Historical revision: the stored evidence used for this answer."
                : "The stored passage behind this citation."
              : "Extracted source text."}
          </p>
          {viewer.provenance && (
            <details className="source-provenance">
              <summary>Snapshot provenance</summary>
              <dl>
                <dt>Revision</dt>
                <dd>{viewer.provenance.revisionId}</dd>
                <dt>Retained bytes SHA-256</dt>
                <dd>{viewer.provenance.originalHash}</dd>
                <dt>Extraction version</dt>
                <dd>{viewer.provenance.extractionVersion}</dd>
                {viewer.provenance.drive && (
                  <>
                    <dt>Google Drive file</dt>
                    <dd>
                      {viewer.provenance.drive.name} ·{" "}
                      {viewer.provenance.drive.id}
                    </dd>
                    <dt>Provider version</dt>
                    <dd>{viewer.provenance.drive.version}</dd>
                    <dt>Modified (provider)</dt>
                    <dd>{viewer.provenance.drive.modifiedTime}</dd>
                    <dt>Retained representation</dt>
                    <dd>
                      {viewer.provenance.drive.representation ===
                      "workspace-export"
                        ? "Google Workspace Office export"
                        : "Downloaded file"}
                    </dd>
                    <dt>Provider MIME type</dt>
                    <dd>{viewer.provenance.drive.mimeType}</dd>
                    {viewer.provenance.drive.exportMimeType && (
                      <>
                        <dt>Export MIME type</dt>
                        <dd>{viewer.provenance.drive.exportMimeType}</dd>
                      </>
                    )}
                  </>
                )}
                {viewer.warnings
                  ?.filter(audioTechnicalWarning)
                  .map((warning: string) => (
                    <React.Fragment key={warning}>
                      <dt>Transcription processing</dt>
                      <dd>{warning}</dd>
                    </React.Fragment>
                  ))}
                {viewer.provenance.origin ? (
                  <>
                    <dt>Requested URL</dt>
                    <dd>
                      {viewer.provenance.requestedOrigin ??
                        "Not recorded for this snapshot"}
                    </dd>
                    <dt>Final URL</dt>
                    <dd>{viewer.provenance.origin}</dd>
                    <dt>Retrieved (UTC)</dt>
                    <dd>
                      {viewer.provenance.retrievedAt ??
                        "Not recorded for this snapshot"}
                    </dd>
                  </>
                ) : (
                  <>
                    <dt>Origin</dt>
                    <dd>Local notebook source</dd>
                  </>
                )}
              </dl>
            </details>
          )}
          {viewer.provenance && (
            <p className="fine">
              <a
                href={
                  "/api/notebooks/" +
                  nbId +
                  "/sources/" +
                  (viewer.source?.id ?? viewer.provenance.sourceId) +
                  "/original?revision=" +
                  viewer.provenance.revisionId
                }
                download
              >
                {viewer.provenance.drive?.representation === "workspace-export"
                  ? "Download retained Office export"
                  : "Download original snapshot"}
              </a>
            </p>
          )}
          {viewer.warnings
            ?.filter((warning: string) => !audioTechnicalWarning(warning))
            .map((warning: string) => (
              <p className="fine" key={warning}>
                {warning}
              </p>
            ))}
          {viewer.derivedFrom && (
            <section className="source-provenance">
              <h3>Note derivation</h3>
              <p className="fine">
                This source is derived work and does not independently
                corroborate its originating evidence.
              </p>
              <button
                className="small"
                onClick={() =>
                  void act(async () => {
                    const derivation = await api(
                      "/notebooks/" +
                        nbId +
                        "/sources/" +
                        (viewer.source?.id ?? viewer.provenance.sourceId) +
                        "/derivation?revision=" +
                        viewer.provenance.revisionId,
                    );
                    setViewer((current: any) => ({ ...current, derivation }));
                  })
                }
              >
                Inspect originating note revision
              </button>
              {viewer.derivation && (
                <div aria-live="polite">
                  <dl>
                    <dt>Note</dt>
                    <dd>
                      {viewer.derivation.title ??
                        "Historical title not recorded"}{" "}
                      · {viewer.derivation.artifactId}
                    </dd>
                    <dt>Note revision</dt>
                    <dd>
                      {viewer.derivation.revisionId ??
                        "Not recorded for this legacy promotion"}
                    </dd>
                    <dt>Origin</dt>
                    <dd>
                      {viewer.derivation.origin === "generated"
                        ? "Generated origin"
                        : viewer.derivation.origin === "user"
                          ? "User note"
                          : "Origin unknown"}
                      {viewer.derivation.authored
                        ? " · user-authored revision"
                        : ""}
                    </dd>
                    {viewer.derivation.runId && (
                      <>
                        <dt>Originating run</dt>
                        <dd>{viewer.derivation.runId}</dd>
                        <dt>Evidence manifest</dt>
                        <dd>{viewer.derivation.manifest.join(", ")}</dd>
                      </>
                    )}
                  </dl>
                  {viewer.derivation.unavailable ? (
                    <p>
                      Originating evidence was purged. The note revision is
                      unavailable.
                    </p>
                  ) : viewer.derivation.content ? (
                    <>
                      <h4>Promoted revision text</h4>
                      <p className="prose">
                        {documentText(viewer.derivation.content, true)}
                      </p>
                      {viewer.derivation.evidence.map(
                        (evidence: any, index: number) => (
                          <blockquote key={index}>
                            {evidence.unavailable ? (
                              "Evidence unavailable."
                            ) : (
                              <>
                                <p>{evidence.quote}</p>
                                <p className="fine">
                                  {evidence.title} · {evidence.locator} ·
                                  revision {evidence.revisionId}
                                </p>
                              </>
                            )}
                          </blockquote>
                        ),
                      )}
                    </>
                  ) : (
                    <p>
                      The exact note revision was not retained for this legacy
                      promotion.
                    </p>
                  )}
                </div>
              )}
            </section>
          )}
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
                  tags: lines(tagText),
                  questions: lines(questionText),
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
                onChange={(e) =>
                  setName(
                    Array.from(e.target.value)
                      .slice(0, NOTEBOOK_TITLE_LIMIT)
                      .join(""),
                  )
                }
                required
                maxLength={NOTEBOOK_TITLE_LIMIT * 2}
              />
            </label>
            <label>
              Notebook instructions
              <textarea
                rows={5}
                value={text}
                maxLength={NOTEBOOK_INSTRUCTIONS_LIMIT * 2}
                onChange={(e) =>
                  setText(
                    Array.from(e.target.value)
                      .slice(0, NOTEBOOK_INSTRUCTIONS_LIMIT)
                      .join(""),
                  )
                }
                placeholder="Audience, language, or preferred depth…"
              />
            </label>
            <p className="fine">
              Changing instructions starts a fresh research context and stops
              active runs.
            </p>
            <p className="fine">
              Recorded instructions version {page.instruction_version} ·{" "}
              {page.updated
                ? "Updated " + new Date(page.updated).toLocaleString()
                : "Previous update time not recorded"}
            </p>
            <label>
              Tags (one per line)
              <textarea
                rows={3}
                value={tagText}
                onChange={(e) => setTagText(e.target.value)}
              />
            </label>
            <label>
              Starter questions (one per line)
              <textarea
                rows={3}
                value={questionText}
                onChange={(e) => setQuestionText(e.target.value)}
              />
            </label>
            {page.templateSnapshot && (
              <p className="fine">
                Created from {page.templateSnapshot.title} · template version{" "}
                {page.templateSnapshot.version}. This notebook keeps its copied
                settings.
              </p>
            )}
            <div className="dialog-actions">
              <button className="primary">Save changes</button>
              <button
                type="button"
                className="small"
                onClick={() => {
                  setTemplateDraft({
                    title: name,
                    description: "",
                    instructions: text,
                    tags: lines(tagText),
                    questions: lines(questionText),
                  });
                  setModal("template-editor");
                }}
              >
                Save settings as template
              </button>
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
      {modal === "library" && (
        <Dialog
          error={error}
          title="Notebook library"
          onClose={() => setModal("")}
        >
          <LibraryBrowser
            books={books}
            templatesOpen={libraryTemplatesOpen}
            onOpen={(result) => {
              setError("");
              setModal("");
              setPendingDiscovery(result);
              setNbId(result.notebookId);
              void refresh(result.notebookId).catch((e) => setError(e.message));
            }}
            onUse={(t) => {
              setTemplates([t]);
              setTemplateId(t.id);
              setName(t.title);
              setText(t.instructions);
              setTagText(t.tags.join("\n"));
              setQuestionText(t.questions.join("\n"));
              setModal("notebook");
            }}
            onEdit={(t) => {
              setTemplateDraft(t);
              setModal("template-editor");
            }}
          />
        </Dialog>
      )}
      {modal === "template-editor" && (
        <Dialog
          title={
            templateDraft?.id && !templateDraft.builtin
              ? "Edit notebook template"
              : "Create notebook template"
          }
          onClose={() => {
            setLibraryTemplatesOpen(true);
            setModal("library");
          }}
        >
          <TemplateEditor
            initial={templateDraft}
            onDone={() => {
              setLibraryTemplatesOpen(true);
              setModal("library");
            }}
          />
        </Dialog>
      )}
      {(modal === "note" || (modal === "source" && viewer?.returnToNote)) &&
        note && (
          <Dialog error={error} title={note.title} onClose={() => setModal("")}>
            {note.historical && (
              <p className="fine">
                Historical revision · {new Date(note.created).toLocaleString()}{" "}
                · {note.authored ? "User-authored" : "Generated original"}
                {note.titleRecorded === false
                  ? " · Historical title not recorded; current title shown"
                  : ""}
              </p>
            )}
            {isRichNote(note.content) ? (
              <RichNoteView
                content={note.content}
                openPassage={openPassage}
                availability={note.referenceAvailability}
              />
            ) : note.content.kind === "infographic" &&
              note.content.infographic?.cards?.length ? (
              <>
                <InfographicMaterial
                  key={note.revision_id}
                  content={note.content}
                  openPassage={openPassage}
                />
                <Answer
                  openPassage={openPassage}
                  content={{
                    ...note.content,
                    kind: undefined,
                    infographic: undefined,
                    title: "",
                    blocks: note.content.blocks.filter(
                      (b: any) => b.kind === "notice",
                    ),
                  }}
                />
              </>
            ) : note.content.kind === "slides" &&
              note.content.slides?.length ? (
              <>
                <SlideMaterial
                  key={note.revision_id}
                  content={note.content}
                  openPassage={openPassage}
                />
                <Answer
                  openPassage={openPassage}
                  content={{
                    ...note.content,
                    kind: undefined,
                    slides: undefined,
                    title: "",
                    blocks: note.content.blocks.filter(
                      (block: any) => block.kind === "notice",
                    ),
                  }}
                />
              </>
            ) : isStructuredKind(note.content.kind) &&
              (note.content.nodes?.length || note.content.rows?.length) ? (
              <>
                <StructuredMaterial
                  key={note.revision_id}
                  content={note.content}
                  openPassage={openPassage}
                />
                <Answer
                  openPassage={openPassage}
                  content={{
                    ...note.content,
                    kind: undefined,
                    title: "",
                    blocks: note.content.blocks.filter(
                      (block: any) => block.kind === "notice",
                    ),
                  }}
                />
              </>
            ) : isStudyKind(note.content.kind) && note.content.items?.length ? (
              <>
                <StudyMaterial
                  key={note.revision_id}
                  content={note.content}
                  openPassage={openPassage}
                  notebookId={nbId}
                  artifactId={note.id}
                  revisionId={note.revision_id}
                  attempts={page.quizAttempts ?? []}
                  onRefresh={refresh}
                />
                <Answer
                  openPassage={openPassage}
                  content={{
                    ...note.content,
                    kind: undefined,
                    items: undefined,
                    title: "",
                    blocks: note.content.blocks.filter(
                      (block: any) => block.kind === "notice",
                    ),
                  }}
                />
              </>
            ) : (
              <Answer openPassage={openPassage} content={note.content} />
            )}
            <GenerationDetails
              run={page.runs.find((r: any) => r.id === note.run_id)}
            />
            {runtime?.audioOverviewsEnabled &&
              note.content.kind === "audio-overview" &&
              !note.authored && (
                <AudioOverview
                  key={note.revision_id}
                  notebookId={nbId}
                  artifactId={note.id}
                  revisionId={note.revision_id}
                  content={note.content}
                />
              )}
            <div className="dialog-actions">
              <button
                className="small"
                disabled={!!note.historical}
                onClick={() => {
                  setName(note.title);
                  setModal("edit-note");
                }}
              >
                Edit
              </button>
              <a
                className="button small"
                href={`/api/notebooks/${nbId}/artifacts/${note.id}/export?revision=${encodeURIComponent(note.revision_id)}`}
              >
                Export Markdown
              </a>
              <a
                className="button small"
                download
                href={`/api/notebooks/${nbId}/artifacts/${note.id}/export?format=html&revision=${encodeURIComponent(note.revision_id)}`}
              >
                Export HTML
              </a>
              {note.content.kind === "infographic" &&
                note.content.status === "answered" &&
                !note.authored &&
                (["png", "svg"] as const).map((format) => (
                  <a
                    className="button small"
                    key={format}
                    download
                    href={`/api/notebooks/${nbId}/artifacts/${note.id}/export?format=${format}&revision=${encodeURIComponent(note.revision_id)}`}
                  >
                    Export {format.toUpperCase()}
                  </a>
                ))}
              {note.content.kind === "slides" &&
                note.content.status === "answered" &&
                !note.authored && (
                  <a
                    className="button small"
                    download
                    href={`/api/notebooks/${nbId}/artifacts/${note.id}/export?format=pptx&revision=${encodeURIComponent(note.revision_id)}`}
                  >
                    Export PowerPoint
                  </a>
                )}
              <button
                className="small"
                disabled={
                  !!note.unavailable ||
                  !!note.referencesUnavailable ||
                  !!note.historical
                }
                onClick={() =>
                  void act(async () => {
                    await api(
                      "/notebooks/" +
                        nbId +
                        "/artifacts/" +
                        note.id +
                        "/promote",
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
              <button
                type="button"
                className="small"
                disabled={
                  busy || note.unavailable || note.referencesUnavailable
                }
                onClick={() =>
                  void act(async () => {
                    const notebook = nbId;
                    setBusy(true);
                    try {
                      const conversation = await api(
                        `/notebooks/${notebook}/artifacts/${note.id}/conversation`,
                        "POST",
                        { revisionId: note.revision_id },
                      );
                      await refresh(notebook);
                      if (nbRef.current !== notebook) return;
                      setConvId(conversation.id);
                      setModal("");
                      setMobile("chat");
                      requestAnimationFrame(() => composer.current?.focus());
                    } finally {
                      setBusy(false);
                    }
                  })
                }
              >
                Ask about this note
              </button>
              <p className="fine">
                Asking retains a derived snapshot of this saved revision for
                cited answers. Questions and answers use text; Send remains
                explicit.
              </p>
            </div>
            {note.historical && (
              <button
                type="button"
                className="small"
                onClick={() =>
                  void act(async () => {
                    const updated = await api(`/notebooks/${nbId}`);
                    setNote(
                      updated.artifacts.find((a: any) => a.id === note.id),
                    );
                  })
                }
              >
                Back to current note
              </button>
            )}
            {note.historical && (
              <button
                type="button"
                className="small"
                onClick={() =>
                  void act(async () => {
                    await api(
                      `/notebooks/${nbId}/artifacts/${note.id}/restore`,
                      "POST",
                      {
                        revisionId: note.revision_id,
                        baseRevisionId: note.currentRevisionId,
                      },
                    );
                    const updated = await api(`/notebooks/${nbId}`);
                    setNote(
                      updated.artifacts.find((a: any) => a.id === note.id),
                    );
                    await refresh();
                  })
                }
              >
                Restore as authored revision
              </button>
            )}
            <NoteHistory
              key={`${note.id}-${note.currentRevisionId ?? note.revision_id}`}
              notebookId={nbId}
              note={note}
              onOpen={(revision) => setNote(revision)}
            />
            <p className="fine">
              Promoted notes are labeled as derived content.
            </p>
          </Dialog>
        )}
      {modal === "edit-note" && (
        <NoteEditorDialog
          error={error}
          title={note ? "Edit note" : "New note"}
          onClose={() => setModal(note ? "note" : "")}
        >
          {(onDraftState) => (
            <Suspense fallback={<p role="status">Opening editor…</p>}>
              <RichNoteEditor
                key={`${nbId}:${note?.id ?? "new"}:${note?.revision_id ?? ""}`}
                initial={note?.content ?? { text: "" }}
                initialTitle={name}
                availability={note?.referenceAvailability}
                sources={page.sources}
                notebookId={nbId}
                onDraftState={onDraftState}
                onReload={
                  note
                    ? async () => {
                        const updated = await api(`/notebooks/${nbId}`);
                        const current = updated.artifacts.find(
                          (a: any) => a.id === note.id,
                        );
                        if (!current) throw new Error("Note not found.");
                        setName(current.title);
                        setNote(current);
                        await refresh();
                      }
                    : undefined
                }
                onSave={async (title, document) => {
                  const saved = await api(
                    `/notebooks/${nbId}/artifacts${note ? "/" + note.id : ""}`,
                    note ? "PATCH" : "POST",
                    {
                      title,
                      document,
                      ...(note ? { baseRevisionId: note.revision_id } : {}),
                    },
                  );
                  const updated = await api(`/notebooks/${nbId}`);
                  setNote(
                    updated.artifacts.find(
                      (a: any) => a.id === (note?.id ?? saved.id),
                    ),
                  );
                  await refresh();
                  setModal("note");
                }}
              />
            </Suspense>
          )}
        </NoteEditorDialog>
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
        <Dialog error={error} title="Connections" onClose={() => setModal("")}>
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
          <h3>Google Drive</h3>
          <DriveControls />
        </Dialog>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
