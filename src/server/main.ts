import http from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { Store } from "../storage/store.ts";
import { CodexClient } from "../codex/client.ts";
import { WebResearchClient } from "../codex/web-research.ts";
import { WebResearchService } from "./web-research-service.ts";
import { NotebookService, canonicalDriveLink } from "./service.ts";
import { exportMarkdown } from "../domain/export.ts";
import { exportHtml } from "../domain/export-html.ts";
import { SlideExportService } from "./slide-export-service.ts";
import { InfographicExportService } from "./infographic-export-service.ts";
import { documentText } from "../domain/artifacts.ts";
import {
  NOTEBOOK_TITLE_LIMIT,
  notebookInstructions,
} from "../domain/notebooks.ts";
import { isRichNote, noteCitations } from "../domain/notes.ts";
import { importKinds, fileType } from "../domain/source-types.ts";
import { audioFormat } from "../ingestion/audio-containers.ts";
import { SpeechService } from "./speech-service.ts";
import { speechCatalog } from "../media/macos-speech.ts";
import {
  DriveConnection,
  loadDriveDesktopClient,
  type DriveDesktopClient,
} from "../connectors/drive-connection.ts";
import { KeychainDriveVault } from "../connectors/drive-vault.ts";
import { DriveClient } from "../ingestion/drive.ts";
import { fetchPublic } from "../ingestion/url.ts";
import { extractIsolated } from "../ingestion/service.ts";
export const root = path.resolve(
  process.env.CODEBOOM_DATA_DIR ?? ".codeboom/data",
);
mkdirSync(root, { recursive: true, mode: 0o700 });
const port = Number(process.env.CODEBOOM_PORT ?? 40732);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw Error("CODEBOOM_PORT must be an integer from 1 to 65535.");
const origin = "http://127.0.0.1:" + port;
const session = randomBytes(32).toString("hex");
const lock = path.join(root, "server.lock");
if (existsSync(lock)) {
  let running = false;
  try {
    process.kill(Number(readFileSync(lock, "utf8")), 0);
    running = true;
  } catch {}
  if (running)
    throw new Error("Codeboom is already running for this data directory.");
  unlinkSync(lock);
}
writeFileSync(lock, String(process.pid), { mode: 0o600, flag: "wx" });
const store = new Store(root);
let desktopClient: DriveDesktopClient | undefined,
  driveConfigurationError: string | undefined;
if (process.env.CODEBOOM_GOOGLE_DESKTOP_CLIENT) {
  try {
    desktopClient = await loadDriveDesktopClient(
      process.env.CODEBOOM_GOOGLE_DESKTOP_CLIENT,
      root,
    );
  } catch {
    driveConfigurationError =
      "Google Drive client configuration is invalid. Check the Desktop OAuth client file outside notebook data.";
  }
}
const drive = new DriveConnection(desktopClient, new KeychainDriveVault(root), {
  unavailableReason: driveConfigurationError,
});
const service = new NotebookService(store, new CodexClient(root), {
  fetch: fetchPublic,
  extract: extractIsolated,
  drive: new DriveClient((signal) => drive.accessToken(signal)),
});
const speech = new SpeechService(store);
const slides = new SlideExportService(store);
const infographics = new InfographicExportService(store);
const webResearch = new WebResearchService(
  store,
  new WebResearchClient(new CodexClient(root)),
);
// Generated audio is deferred for the personal-notes workflow.
const audioOverviewsEnabled =
  process.env.CODEBOOM_ENABLE_AUDIO_OVERVIEWS === "true";
let runtime: any = null;
let runtimeChecked = 0;
const json = (res: http.ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
};
const string = (v: unknown, max = 10000) => {
  if (typeof v !== "string" || v.length > max)
    throw new Error("Invalid text input.");
  return v;
};
const title = (v: unknown) => {
  const t = string(v, NOTEBOOK_TITLE_LIMIT * 2).trim();
  if (Array.from(t).length > NOTEBOOK_TITLE_LIMIT)
    throw new Error(
      `A title must contain at most ${NOTEBOOK_TITLE_LIMIT} characters.`,
    );
  if (!t) throw new Error("A title is required.");
  return t;
};
const body = async (req: http.IncomingMessage, max = 36 * 1024 * 1024) => {
  if (!String(req.headers["content-type"]).startsWith("application/json"))
    throw new Error("JSON required.");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new Error("Request too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
};
const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  try {
    if (req.headers.host !== "127.0.0.1:" + port) {
      json(res, 403, { error: "Invalid host." });
      return;
    }
    if (req.headers.origin && req.headers.origin !== origin) {
      json(res, 403, { error: "Invalid origin." });
      return;
    }
    if (req.headers["sec-fetch-site"] === "cross-site") {
      json(res, 403, { error: "Cross-site requests are blocked." });
      return;
    }
    const url = new URL(req.url ?? "/", origin),
      p = url.pathname.split("/").filter(Boolean),
      method = req.method;
    if (p[0] !== "api") {
      if (method !== "GET") {
        json(res, 405, { error: "Method not allowed." });
        return;
      }
      const file = p.length
        ? path.resolve("dist", decodeURIComponent(url.pathname.slice(1)))
        : path.resolve("dist/index.html");
      if (
        !file.startsWith(path.resolve("dist") + path.sep) ||
        !existsSync(file)
      ) {
        json(res, 404, { error: "Build the interface with npm run build." });
        return;
      }
      const contentType = file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : file.endsWith(".svg")
            ? "image/svg+xml"
            : "text/html";
      res.writeHead(200, { "content-type": contentType });
      res.end(readFileSync(file));
      return;
    }
    if (p[1] === "session" && method === "GET") {
      res.setHeader(
        "Set-Cookie",
        "codeboom=" + session + "; HttpOnly; SameSite=Strict; Path=/",
      );
      json(res, 200, { ready: true });
      return;
    }
    const cookie =
      String(req.headers.cookie ?? "")
        .split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith("codeboom="))
        ?.slice(9) ?? "";
    if (
      cookie.length !== session.length ||
      !timingSafeEqual(Buffer.from(cookie), Buffer.from(session))
    ) {
      json(res, 401, { error: "Reload Codeboom to start a local session." });
      return;
    }
    if (
      !["GET", "HEAD"].includes(method ?? "") &&
      req.headers.origin !== origin
    ) {
      json(res, 403, { error: "Same-origin requests are required." });
      return;
    }
    if (p[1] === "drive") {
      if (p.length === 2 && method === "GET") {
        json(res, 200, await drive.status());
        return;
      }
      if (p.length === 3 && p[2] === "connect" && method === "POST") {
        json(res, 200, await drive.connect());
        return;
      }
      if (p.length === 3 && p[2] === "disconnect" && method === "POST") {
        json(res, 200, await service.disconnectDrive(() => drive.disconnect()));
        return;
      }
    }
    if (p[1] === "status" && method === "GET") {
      if (
        !runtime ||
        url.searchParams.has("refresh") ||
        Date.now() - runtimeChecked > 60000
      ) {
        try {
          runtime = await service.codex.status();
          runtimeChecked = Date.now();
        } catch (e) {
          json(res, 200, {
            available: false,
            error: e instanceof Error ? e.message : "Codex is unavailable.",
            models: [],
          });
          return;
        }
      }
      json(res, 200, {
        ...runtime,
        audioOverviewsEnabled,
      });
      return;
    }
    if (p[1] === "templates") {
      if (p.length === 2 && method === "GET") {
        json(res, 200, store.templates());
        return;
      }
      if (p.length === 2 && method === "POST") {
        const b = await body(req);
        json(res, 201, store.saveTemplate(b.recipe));
        return;
      }
      if (p.length === 3 && method === "PATCH") {
        const b = await body(req);
        json(res, 200, store.saveTemplate(b.recipe, p[2], b.version));
        return;
      }
      if (p.length === 3 && method === "DELETE") {
        const b = await body(req);
        store.deleteTemplate(p[2], b.version);
        json(res, 200, { deleted: true });
        return;
      }
      json(res, 404, { error: "Not found." });
      return;
    }
    if (p[1] === "library" && p.length === 2 && method === "GET") {
      const archived = url.searchParams.get("archived") ?? "false";
      if (!["true", "false"].includes(archived))
        throw new Error("Archive filter must be true or false.");
      json(
        res,
        200,
        store.discover(url.searchParams.get("q") ?? "", {
          tag: url.searchParams.get("tag") ?? undefined,
          archived: archived === "true",
          offset: Number(url.searchParams.get("offset") ?? 0),
          limit: Number(url.searchParams.get("limit") ?? 30),
        }),
      );
      return;
    }
    if (p[1] !== "notebooks") {
      json(res, 404, { error: "Not found." });
      return;
    }
    if (p.length === 2) {
      if (method === "GET") {
        json(res, 200, store.notebooks());
        return;
      }
      if (method === "POST") {
        const b = await body(req);
        json(
          res,
          201,
          store.createNotebook(title(b.title), {
            ...(b.templateId !== undefined
              ? {
                  templateId: string(b.templateId, 100),
                  templateVersion: b.templateVersion,
                }
              : {}),
            ...(b.instructions !== undefined
              ? { instructions: notebookInstructions(b.instructions) }
              : {}),
            ...(b.tags !== undefined ? { tags: b.tags } : {}),
            ...(b.questions !== undefined ? { questions: b.questions } : {}),
          }),
        );
        return;
      }
    }
    const n = p[2];
    store.notebook(n);
    if (p.length === 3) {
      if (method === "GET") {
        json(res, 200, store.view(n));
        return;
      }
      if (method === "PATCH") {
        const b = await body(req);
        const notebook = service.updateNotebook(n, {
          ...(b.title !== undefined ? { title: title(b.title) } : {}),
          ...(b.instructions !== undefined
            ? { instructions: notebookInstructions(b.instructions) }
            : {}),
          ...(b.archived !== undefined ? { archived: !!b.archived } : {}),
          ...(b.tags !== undefined ? { tags: b.tags } : {}),
          ...(b.questions !== undefined ? { questions: b.questions } : {}),
        });
        json(res, 200, notebook);
        return;
      }
      if (method === "DELETE") {
        service.cancelNotebook(n);
        webResearch.cancelNotebook(n);
        service.dictation.cancelNotebook(n);
        speech.cancelNotebook(n);
        store.deleteNotebook(n);
        json(res, 200, { deleted: true });
        return;
      }
    }
    if (
      p[3] === "web-research" &&
      p.length === 4 &&
      (method === "POST" || method === "DELETE")
    ) {
      const b = await body(req, 8192);
      const key = string(b.key, 200);
      if (method === "DELETE") {
        webResearch.cancel(n, key);
        json(res, 200, { cancelled: true });
        return;
      }
      if (method === "POST") {
        const controller = new AbortController();
        const disconnected = () => controller.abort();
        res.once("close", disconnected);
        try {
          const result = await webResearch.search(n, {
            query: string(b.query, 1000),
            key,
            model: b.model === undefined ? undefined : string(b.model, 200),
            signal: controller.signal,
          });
          if (!controller.signal.aborted) json(res, 200, result);
        } finally {
          res.off("close", disconnected);
        }
        return;
      }
    }
    if (p[3] === "dictation") {
      res.setHeader("Cache-Control", "no-store");
      if (p.length === 4 && method === "DELETE") {
        const b = await body(req, 1024);
        service.dictation.cancelRequest(n, string(b.idempotency, 200));
        json(res, 200, { discarded: true });
        return;
      }
      if (p.length === 4 && method === "POST") {
        const b = await body(req);
        json(
          res,
          202,
          service.dictation.begin(
            n,
            Buffer.from(string(b.base64, 32 * 1024 * 1024), "base64"),
            string(b.idempotency, 200),
          ),
        );
        return;
      }
      if (p.length === 5 && method === "GET") {
        json(res, 200, service.dictation.get(n, p[4]));
        return;
      }
      if (p.length === 5 && method === "DELETE") {
        service.dictation.discard(n, p[4]);
        json(res, 200, { discarded: true });
        return;
      }
    }
    if (p[3] === "import" && method === "POST") {
      const b = await body(req),
        name = title(b.title),
        key = string(b.idempotency, 200);
      if (!key) throw new Error("An idempotency key is required.");
      const kind = string(b.kind, 30);
      if (!importKinds.includes(kind))
        throw new Error("Unsupported import type.");
      const bytes =
        kind === "url" || kind === "drive"
          ? undefined
          : b.base64
            ? Buffer.from(string(b.base64, 35 * 1024 * 1024), "base64")
            : Buffer.from(string(b.text ?? "", 1000000));
      const sourceUrl = kind === "url" ? string(b.url, 4000) : undefined;
      const driveUrl = kind === "drive" ? string(b.driveUrl, 4000) : undefined;
      const savedDriveUrl = driveUrl ? canonicalDriveLink(driveUrl) : undefined;
      if (bytes && bytes.length > 25 * 1024 * 1024)
        throw new Error("Source exceeds 25 MiB.");
      const retryOf =
        b.retryOf === undefined ? undefined : string(b.retryOf, 100);
      if (retryOf) {
        const previous = store.importJob(n, retryOf);
        if (!["unknown", "import"].includes(previous.type))
          throw new Error(
            "Use the stored retry for this source refresh or note promotion.",
          );
      }
      const job = store.beginImport(
        n,
        name,
        key,
        {
          kind,
          ...(sourceUrl ? { url: sourceUrl } : {}),
          ...(savedDriveUrl ? { driveUrl: savedDriveUrl } : {}),
        },
        retryOf,
      );
      if (job.status === "processing" && !job.source_id)
        void service.import(n, job.id, {
          title: name,
          kind,
          bytes,
          url: sourceUrl,
          driveUrl,
        });
      json(res, 202, job);
      return;
    }
    if (p[3] === "jobs" && p[5] === "retry" && method === "POST") {
      const b = await body(req),
        key = string(b.idempotency, 200);
      if (!key) throw new Error("An idempotency key is required.");
      const previous = store.importJob(n, p[4]);
      json(res, 202, service.retryImport(n, p[4], key));
      return;
    }
    if (p[3] === "jobs" && p[5] === "duplicate" && method === "POST") {
      const b = await body(req);
      if (b.action !== "reuse" && b.action !== "dismiss")
        throw new Error("Choose reuse or dismiss for the duplicate import.");
      json(res, 200, store.resolveDuplicate(n, p[4], b.action));
      return;
    }
    if (p[3] === "sources") {
      const s = store.one(
        "SELECT * FROM sources WHERE id=? AND notebook_id=?",
        p[4],
        n,
      );
      if (!s) throw new Error("Source not found.");
      if (method === "GET" && p.length === 5) {
        json(res, 200, {
          ...s,
          revisions: store.all(
            "SELECT id,created,warnings,hash,normalized_hash,extractor,origin,requested_origin,retrieved_at,provider_metadata FROM revisions WHERE source_id=? ORDER BY created DESC",
            s.id,
          ),
          passages: store
            .all(
              "SELECT id FROM passages WHERE source_id=? ORDER BY revision_id,rowid",
              s.id,
            )
            .map((p) => store.passage(n, p.id)),
        });
        return;
      }
      if (p[5] === "original" && method === "GET" && p.length === 6) {
        const revision = string(
          url.searchParams.get("revision") ?? s.current_revision,
          100,
        );
        const bytes = store.sourceOriginal(n, s.id, revision);
        const snapshot = store.one(
          "SELECT kind,provider_metadata FROM revisions WHERE id=? AND source_id=?",
          revision,
          s.id,
        );
        const providerInfo = snapshot.provider_metadata
          ? JSON.parse(snapshot.provider_metadata)
          : null;
        const exported =
          providerInfo?.representation === "workspace-export"
            ? (
                {
                  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
                    "docx",
                  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
                    "xlsx",
                  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
                    "pptx",
                } as Record<string, string>
              )[providerInfo.exportMimeType]
            : undefined;
        const recordedKind =
          snapshot.kind ??
          (revision === s.current_revision ? s.kind : undefined);
        const fileKind =
          providerInfo?.representation === "binary"
            ? (fileType(providerInfo.name)?.kind ?? recordedKind)
            : recordedKind;
        const fileExtension = (
          {
            pdf: "pdf",
            docx: "docx",
            pptx: "pptx",
            xlsx: "xlsx",
            csv: "csv",
            tsv: "tsv",
            text: "txt",
            paste: "txt",
            note: "txt",
            markdown: "md",
            html: "html",
            srt: "srt",
            vtt: "vtt",
          } as Record<string, string>
        )[fileKind];
        let extension: string | undefined = exported ?? fileExtension;
        if (!extension && fileKind === "audio") {
          const audio = audioFormat(bytes);
          extension = audio === "vorbis" ? "ogg" : audio;
        } else if (!extension && fileKind === "image") {
          extension = bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            ? "png"
            : bytes[0] === 255 && bytes[1] === 216
              ? "jpg"
              : bytes.toString("ascii", 0, 4) === "RIFF" &&
                  bytes.toString("ascii", 8, 12) === "WEBP"
                ? "webp"
                : undefined;
        }
        // Legacy historical rows have no reliable kind; short byte prefixes
        // such as ID3 can also be ordinary text, so keep an unknown extension.
        extension ??= "bin";
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": bytes.length,
          "Content-Disposition": `attachment; filename="snapshot-${revision}.${extension}"`,
          "Cache-Control": "no-store",
        });
        res.end(bytes);
        return;
      }
      if (p[5] === "derivation" && method === "GET") {
        const revision = url.searchParams.get("revision") ?? s.current_revision;
        if (
          !store.one(
            "SELECT id FROM revisions WHERE id=? AND source_id=?",
            revision,
            s.id,
          )
        )
          throw new Error("Source revision not found.");
        const derivation = store.sourceDerivation(n, revision);
        json(
          res,
          200,
          derivation && {
            ...derivation,
            evidence: noteCitations(derivation.content ?? {}).map(
              (citation: any) => {
                try {
                  const passage = store.passage(n, citation.passageId);
                  return {
                    ...citation,
                    title: passage.title,
                    revisionId: passage.revisionId,
                    locator: passage.locator,
                    unavailable: false,
                  };
                } catch {
                  return { unavailable: true };
                }
              },
            ),
          },
        );
        return;
      }
      if (method === "DELETE") {
        service.cancelNotebook(n);
        if (url.searchParams.get("purge") === "true") {
          speech.cancelNotebook(n);
          store.purgeSource(n, s.id);
        } else store.removeSource(n, s.id);
        json(res, 200, { removed: true });
        return;
      }
      if (p[5] === "refresh" && method === "POST") {
        if (!s.origin) throw new Error("Refresh is available for URL sources.");
        const metadata = store.one(
          "SELECT provider_metadata FROM revisions WHERE id=? AND source_id=?",
          s.current_revision,
          s.id,
        )?.provider_metadata;
        const descriptor = metadata
          ? {
              kind: "drive",
              driveUrl: canonicalDriveLink(s.origin),
              sourceId: s.id,
            }
          : {
              kind: "url",
              url: s.requested_origin ?? s.origin,
              sourceId: s.id,
            };
        const job = store.beginImport(n, s.title, randomUUID(), descriptor);
        void service.import(n, job.id, {
          title: s.title,
          ...descriptor,
        });
        json(res, 202, job);
        return;
      }
    }
    if (p[3] === "passages" && method === "GET") {
      const passage = store.passage(n, p[4]);
      json(res, 200, {
        ...passage,
        derivation: store.sourceDerivation(n, passage.revisionId),
        historical:
          store.one(
            "SELECT current_revision FROM sources WHERE id=?",
            passage.sourceId,
          ).current_revision !== passage.revisionId,
      });
      return;
    }
    if (p[3] === "conversations") {
      if (p.length === 4 && method === "POST") {
        json(res, 201, store.createConversation(n));
        return;
      }
      const c = p[4];
      store.conversation(n, c);
      if (method === "PATCH") {
        const b = await body(req);
        if (
          !Array.isArray(b.selected) ||
          b.selected.length > 50 ||
          b.selected.some((s: unknown) => typeof s !== "string")
        )
          throw new Error("Invalid selection.");
        if (store.noteContext(n, c))
          throw new Error(
            "This conversation is pinned to its saved note. Start a new conversation to choose other sources.",
          );
        store.setSelection(n, c, b.selected);
        service.cancelNotebook(n);
        json(res, 200, { updated: true });
        return;
      }
      if (p[5] === "runs" && method === "POST") {
        const b = await body(req);
        const kind = string(b.kind ?? "answer", 30);
        if (
          ![
            "answer",
            "summary",
            "briefing",
            "study-guide",
            "faq",
            "flashcards",
            "quiz",
            "mind-map",
            "data-table",
            "slides",
            "infographic",
            ...(audioOverviewsEnabled ? ["audio-overview"] : []),
          ].includes(kind)
        )
          throw new Error("Unknown output kind.");
        const run = store.createRun(
          n,
          c,
          string(b.question, 10000),
          kind,
          string(b.model ?? "", 100),
          string(b.idempotency, 200),
          b.retryOf === undefined ? undefined : string(b.retryOf, 100),
          b.itemCount,
        );
        void service.execute(run.id);
        json(res, 202, run);
        return;
      }
    }
    if (p[3] === "runs") {
      const run = store.one(
        "SELECT * FROM runs WHERE id=? AND notebook_id=?",
        p[4],
        n,
      );
      if (!run) throw new Error("Run not found.");
      if (p[5] === "cancel" && method === "POST") {
        service.cancel(n, run.id);
        json(res, 200, { cancelled: true });
        return;
      }
      if (p[5] === "events" && method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        let cursor = Number(req.headers["last-event-id"] ?? 0);
        if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
        const pump = () => {
          for (const e of store.all(
            "SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq",
            run.id,
            cursor,
          )) {
            res.write("id: " + e.seq + "\ndata: " + e.data + "\n\n");
            cursor = e.seq;
          }
          const state = store.one(
            "SELECT status FROM runs WHERE id=?",
            run.id,
          )?.status;
          if (!["queued", "running", "validating"].includes(state)) {
            res.write(
              "data: " +
                JSON.stringify({ type: "settled", status: state }) +
                "\n\n",
            );
            clearInterval(timer);
            res.end();
          }
        };
        const timer = setInterval(pump, 500);
        req.on("close", () => clearInterval(timer));
        pump();
        return;
      }
    }
    if (p[3] === "drafts") {
      if (p.length === 4 && method === "GET") {
        json(
          res,
          200,
          store.drafts.list(n, url.searchParams.get("artifactId")),
        );
        return;
      }
      if (p.length === 5 && method === "GET") {
        json(res, 200, store.drafts.read(n, p[4]));
        return;
      }
      if (p.length === 5 && method === "PUT") {
        json(
          res,
          200,
          store.drafts.save(n, p[4], await body(req, 2 * 1024 * 1024)),
        );
        return;
      }
      if (p.length === 5 && method === "DELETE") {
        const b = await body(req, 1024);
        store.drafts.discard(n, { id: p[4], version: b.version });
        json(res, 200, { discarded: true });
        return;
      }
    }
    if (p[3] === "trash" && p.length === 4 && method === "GET") {
      json(res, 200, store.trash(n));
      return;
    }
    if (p[3] === "artifacts") {
      if (p.length === 4 && method === "POST") {
        const b = await body(req);
        if (b.runId) {
          const r = store.one(
            "SELECT * FROM runs WHERE id=? AND notebook_id=? AND status='completed'",
            string(b.runId, 100),
            n,
          );
          if (!r?.output) throw new Error("Completed answer not found.");
          const answer = JSON.parse(r.output);
          json(res, 201, {
            id: store.saveArtifact(
              n,
              answer.title,
              "note",
              r.output,
              false,
              r.id,
            ),
          });
          return;
        }
        json(res, 201, {
          id:
            b.document !== undefined
              ? store.drafts.saveOnce(
                  n,
                  b.saveId,
                  { ...b, artifactId: null },
                  () =>
                    store.drafts.publish(n, b.draft, null, null, (draft) =>
                      store.createRichArtifact(
                        n,
                        title(b.title),
                        b.document,
                        noteCitations(draft?.document ?? {}),
                      ),
                    ),
                )
              : store.saveArtifact(
                  n,
                  title(b.title),
                  "note",
                  JSON.stringify({ text: string(b.text, 100000) }),
                  true,
                ),
        });
        return;
      }
      if (p.length === 5 && method === "DELETE") {
        const b = await body(req, 1024);
        if (b.confirm !== true)
          throw Error("Confirm permanent deletion and its effects.");
        service.deleteArtifact(n, p[4], b.trashVersion);
        json(res, 200, { deleted: true });
        return;
      }
      const a = store.one(
        "SELECT * FROM artifacts WHERE id=? AND notebook_id=?",
        p[4],
        n,
      );
      if (!a) throw new Error("Note not found.");
      if (p[5] === "trash" && method === "POST") {
        const b = await body(req, 1024);
        if (p.length === 6) {
          json(
            res,
            200,
            service.trashArtifact(
              n,
              a.id,
              string(b.baseRevisionId, 100),
              b.trashVersion,
            ),
          );
          return;
        }
        if (p.length === 7 && p[6] === "restore") {
          json(res, 200, store.restoreTrashedArtifact(n, a.id, b.trashVersion));
          return;
        }
      }
      // Trash history is readable, while publication and exports require restoration.
      if (!(p[5] === "revisions" && method === "GET"))
        store.activeArtifact(n, a.id);
      if (p[5] === "audio") {
        if (!audioOverviewsEnabled)
          throw new Error(
            "Audio generation is deferred for the personal-notes workflow.",
          );
        if (p.length === 6 && method === "GET") {
          json(res, 200, {
            ...store.speech.list(n, a.id),
            ...(url.searchParams.get("catalog") === "false"
              ? {}
              : { provider: await speechCatalog() }),
          });
          return;
        }
        if (p.length === 6 && method === "POST") {
          const b = await body(req);
          const job = store.speech.begin(
            n,
            a.id,
            string(b.revisionId, 100),
            string(b.provider, 100),
            string(b.voiceId, 100),
            string(b.idempotency, 200),
          );
          if (job.status === "processing") void speech.execute(job.id);
          json(res, 202, job);
          return;
        }
        if (p[6] === "jobs" && p.length === 9 && method === "POST") {
          if (p[8] === "cancel") {
            json(res, 200, speech.cancel(n, a.id, p[7]));
            return;
          }
          if (p[8] === "retry") {
            const b = await body(req),
              job = store.speech.retry(
                n,
                a.id,
                p[7],
                string(b.idempotency, 200),
              );
            if (job.status === "processing") void speech.execute(job.id);
            json(res, 202, job);
            return;
          }
        }
        if (p[6] === "assets" && p.length === 8 && method === "GET") {
          const { asset, bytes } = store.speech.asset(n, a.id, p[7]);
          res.setHeader("Content-Type", "audio/wav");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Accept-Ranges", "bytes");
          res.setHeader(
            "Content-Disposition",
            `${url.searchParams.get("download") === "true" ? "attachment" : "inline"}; filename="codeboom-audio-overview.wav"`,
          );
          const range = req.headers.range;
          if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            let start = 0,
              end = bytes.length - 1;
            if (!match || (!match[1] && !match[2])) {
              res.writeHead(416, {
                "Content-Range": `bytes */${bytes.length}`,
              });
              res.end();
              return;
            }
            if (!match[1]) {
              const length = Number(match[2]);
              if (!Number.isSafeInteger(length) || length < 1) {
                res.writeHead(416, {
                  "Content-Range": `bytes */${bytes.length}`,
                });
                res.end();
                return;
              }
              start = Math.max(0, bytes.length - length);
            } else {
              start = Number(match[1]);
              if (match[2]) end = Math.min(end, Number(match[2]));
            }
            if (
              !Number.isSafeInteger(start) ||
              !Number.isSafeInteger(end) ||
              start < 0 ||
              start >= bytes.length ||
              end < start
            ) {
              res.writeHead(416, {
                "Content-Range": `bytes */${bytes.length}`,
              });
              res.end();
              return;
            }
            res.writeHead(206, {
              "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
              "Content-Length": end - start + 1,
            });
            res.end(bytes.subarray(start, end + 1));
            return;
          }
          res.writeHead(200, { "Content-Length": asset.size });
          res.end(bytes);
          return;
        }
      }
      if (p[5] === "revisions" && method === "GET") {
        json(
          res,
          200,
          p.length === 6
            ? store.artifactHistory(
                n,
                a.id,
                Number(url.searchParams.get("offset") ?? 0),
                Number(url.searchParams.get("limit") ?? 20),
              )
            : store.artifactRevision(n, a.id, p[6]),
        );
        return;
      }
      if (p[5] === "restore" && p.length === 6 && method === "POST") {
        const b = await body(req);
        json(res, 200, {
          revisionId: store.restoreArtifact(
            n,
            a.id,
            string(b.revisionId, 100),
            string(b.baseRevisionId, 100),
          ),
        });
        return;
      }
      if (p[5] === "attempts" && p.length === 6 && method === "POST") {
        const b = await body(req);
        json(
          res,
          201,
          store.startQuizAttempt(
            n,
            a.id,
            string(b.revisionId, 100),
            string(b.idempotency, 200),
          ),
        );
        return;
      }
      if (p[5] === "attempts" && p.length === 7 && method === "PATCH") {
        const b = await body(req);
        if (b.submit !== undefined && typeof b.submit !== "boolean")
          throw new Error("Invalid quiz submission.");
        json(
          res,
          200,
          store.saveQuizAnswers(n, a.id, p[6], b.answers, b.submit ?? false),
        );
        return;
      }
      if (p.length === 5 && method === "PATCH") {
        const b = await body(req);
        if (b.document !== undefined)
          store.drafts.saveOnce(n, b.saveId, { ...b, artifactId: a.id }, () => {
            store.drafts.publish(
              n,
              b.draft,
              a.id,
              string(b.baseRevisionId, 100),
              (draft) =>
                store.editRichArtifact(
                  n,
                  a.id,
                  title(b.title),
                  b.document,
                  string(b.baseRevisionId, 100),
                  noteCitations(draft?.document ?? {}),
                ),
            );
            return a.id;
          });
        else
          store.editArtifact(
            n,
            a.id,
            title(b.title),
            string(b.text, 100000),
            string(b.baseRevisionId, 100),
          );
        json(res, 200, { saved: true });
        return;
      }
      if (p[5] === "export" && method === "GET") {
        const revision = url.searchParams.get("revision"),
          format = url.searchParams.get("format") ?? "markdown";
        if (!["markdown", "html", "pptx", "png", "svg"].includes(format))
          throw new Error("Unsupported export format.");
        const current = store.artifactHistory(n, a.id, 0, 1).results[0];
        if (!current) throw new Error("Saved note revision not found.");
        const exported = store.artifactRevision(
          n,
          a.id,
          revision ?? current.id,
        );
        const resolve = (id: string) => {
          try {
            const passage = store.passage(n, id);
            return {
              ...passage,
              derivation: store.sourceDerivation(n, passage.revisionId),
            };
          } catch {
            return null;
          }
        };
        if (format === "png" || format === "svg") {
          const cancelled = new AbortController();
          const disconnected = () => cancelled.abort();
          res.once("close", disconnected);
          try {
            const bytes = await infographics.export(
              n,
              a.id,
              exported.revision_id,
              format,
              cancelled.signal,
            );
            if (res.destroyed) throw Error("Infographic export was cancelled.");
            res.writeHead(200, {
              "content-type":
                format === "png" ? "image/png" : "image/svg+xml; charset=utf-8",
              "content-disposition": `attachment; filename="codeboom-infographic.${format}"`,
              "cache-control": "no-store",
              "content-length": bytes.length,
              "content-security-policy":
                "default-src 'none'; style-src 'none'; sandbox",
            });
            res.end(bytes);
            return;
          } finally {
            res.removeListener("close", disconnected);
          }
        }
        if (format === "pptx") {
          const cancelled = new AbortController();
          const disconnected = () => cancelled.abort();
          res.once("close", disconnected);
          try {
            const bytes = await slides.export(
              n,
              a.id,
              exported.revision_id,
              cancelled.signal,
            );
            if (res.destroyed) throw Error("Slide export was cancelled.");
            res.writeHead(200, {
              "content-type":
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
              "content-disposition":
                'attachment; filename="codeboom-slides.pptx"',
              "cache-control": "no-store",
              "content-length": bytes.length,
            });
            res.end(bytes);
            return;
          } finally {
            res.removeListener("close", disconnected);
          }
        }
        const text =
          format === "html"
            ? exportHtml(exported.title, exported.content, resolve, {
                revisionId: exported.revision_id,
                created: exported.created,
                authored: Boolean(exported.authored),
                historical: exported.revision_id !== current.id,
                titleRecorded: exported.titleRecorded,
                available: exported.available,
              })
            : exportMarkdown(exported.title, exported.content, resolve);
        res.writeHead(200, {
          "content-type":
            format === "html"
              ? "text/html; charset=utf-8"
              : "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="codeboom-note.${format === "html" ? "html" : "md"}"`,
          "cache-control": "no-store",
        });
        res.end(text);
        return;
      }
      if (p[5] === "conversation" && p.length === 6 && method === "POST") {
        const b = await body(req);
        json(
          res,
          200,
          store.openNoteConversation(n, a.id, string(b.revisionId, 100)),
        );
        return;
      }
      if (p[5] === "promote" && method === "POST") {
        const b = await body(req),
          note = store.activeArtifact(n, a.id),
          revision = store.artifactHistory(n, a.id, 0, 1).results[0];
        if (string(b.revisionId, 100) !== revision?.id)
          throw new Error(
            "Note changed. Reopen it before using it as a source.",
          );
        if (note.unavailable)
          throw new Error(
            "This note has unavailable evidence and cannot be promoted.",
          );
        const content = JSON.parse(note.content);
        if (
          isRichNote(content) &&
          noteCitations(content).some((c) => {
            try {
              store.passage(n, c.passageId);
              return false;
            } catch {
              return true;
            }
          })
        )
          throw new Error(
            "This note has unavailable references and cannot be promoted.",
          );
        const text = documentText(content);
        const descriptor = {
          kind: "note",
          derivedFrom: a.id,
          derivedRevision: revision.id,
        };
        const job = store.beginImport(n, note.title, randomUUID(), descriptor);
        void service.import(n, job.id, {
          title: note.title,
          ...descriptor,
          bytes: Buffer.from(text),
        });
        json(res, 202, job);
        return;
      }
    }
    json(res, 404, { error: "Not found." });
  } catch (error) {
    if (!res.headersSent)
      json(res, 400, {
        error: error instanceof Error ? error.message : "Request failed.",
      });
    else res.end();
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log("Codeboom is ready at " + origin),
);
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  service.shutdown();
  speech.shutdown();
  server.close();
  if (existsSync(lock)) unlinkSync(lock);
  await Promise.allSettled([
    drive.shutdown(),
    slides.shutdown(),
    infographics.shutdown(),
    webResearch.shutdown(),
    new Promise((r) => setTimeout(r, 1000)),
  ]);
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
