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
import { NotebookService } from "./service.ts";
import { exportMarkdown } from "../domain/export.ts";
export const root = path.resolve(
  process.env.CODEBOOM_DATA_DIR ?? ".codeboom/data",
);
mkdirSync(root, { recursive: true, mode: 0o700 });
const port = Number(process.env.CODEBOOM_PORT ?? 4317);
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
const store = new Store(root),
  service = new NotebookService(store, new CodexClient(root));
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
  const t = string(v, 200).trim();
  if (!t) throw new Error("A title is required.");
  return t;
};
const body = async (req: http.IncomingMessage) => {
  if (!String(req.headers["content-type"]).startsWith("application/json"))
    throw new Error("JSON required.");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 36 * 1024 * 1024) throw new Error("Request too large.");
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
      json(res, 200, runtime);
      return;
    }
    if (p[1] !== "notebooks") {
      json(res, 404, { error: "Not found." });
      return;
    }
    if (p.length === 2) {
      if (method === "GET") {
        json(
          res,
          200,
          store.all("SELECT * FROM notebooks ORDER BY created DESC"),
        );
        return;
      }
      if (method === "POST") {
        const b = await body(req);
        json(res, 201, store.createNotebook(title(b.title)));
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
        service.cancelNotebook(n);
        json(
          res,
          200,
          store.updateNotebook(n, {
            ...(b.title !== undefined ? { title: title(b.title) } : {}),
            ...(b.instructions !== undefined
              ? { instructions: string(b.instructions) }
              : {}),
            ...(b.archived !== undefined ? { archived: !!b.archived } : {}),
          }),
        );
        return;
      }
      if (method === "DELETE") {
        service.cancelNotebook(n);
        store.deleteNotebook(n);
        json(res, 200, { deleted: true });
        return;
      }
    }
    if (p[3] === "import" && method === "POST") {
      const b = await body(req),
        name = title(b.title),
        key = string(b.idempotency, 200);
      if (!key) throw new Error("An idempotency key is required.");
      const kind = string(b.kind, 30);
      if (!["text", "markdown", "pdf", "paste", "url"].includes(kind))
        throw new Error("Unsupported import type.");
      const bytes =
        kind === "url"
          ? undefined
          : b.base64
            ? Buffer.from(string(b.base64, 35 * 1024 * 1024), "base64")
            : Buffer.from(string(b.text ?? "", 1000000));
      const sourceUrl = kind === "url" ? string(b.url, 4000) : undefined;
      if (bytes && bytes.length > 25 * 1024 * 1024)
        throw new Error("Source exceeds 25 MiB.");
      const job = store.beginImport(n, name, key);
      if (job.status === "processing" && !job.source_id)
        void service.import(n, job.id, {
          title: name,
          kind,
          bytes,
          url: sourceUrl,
        });
      json(res, 202, job);
      return;
    }
    if (p[3] === "sources") {
      const s = store.one(
        "SELECT * FROM sources WHERE id=? AND notebook_id=?",
        p[4],
        n,
      );
      if (!s) throw new Error("Source not found.");
      if (method === "GET") {
        json(res, 200, {
          ...s,
          revisions: store.all(
            "SELECT id,created,warnings FROM revisions WHERE source_id=? ORDER BY created DESC",
            s.id,
          ),
          passages: store
            .all(
              "SELECT * FROM passages WHERE source_id=? ORDER BY revision_id,rowid",
              s.id,
            )
            .map(store.toPassage),
        });
        return;
      }
      if (method === "DELETE") {
        service.cancelNotebook(n);
        if (url.searchParams.get("purge") === "true")
          store.purgeSource(n, s.id);
        else store.removeSource(n, s.id);
        json(res, 200, { removed: true });
        return;
      }
      if (p[5] === "refresh" && method === "POST") {
        if (!s.origin) throw new Error("Refresh is available for URL sources.");
        const job = store.beginImport(n, s.title, randomUUID());
        void service.import(n, job.id, {
          title: s.title,
          kind: s.kind,
          url: s.origin,
          sourceId: s.id,
        });
        json(res, 202, job);
        return;
      }
    }
    if (p[3] === "passages" && method === "GET") {
      const passage = store.passage(n, p[4]);
      json(res, 200, {
        ...passage,
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
        service.cancelNotebook(n);
        store.setSelection(n, c, b.selected);
        json(res, 200, { updated: true });
        return;
      }
      if (p[5] === "runs" && method === "POST") {
        const b = await body(req);
        const kind = string(b.kind ?? "answer", 30);
        if (
          !["answer", "summary", "briefing", "study-guide", "faq"].includes(
            kind,
          )
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
          id: store.saveArtifact(
            n,
            title(b.title),
            "note",
            JSON.stringify({ text: string(b.text, 100000) }),
            true,
          ),
        });
        return;
      }
      const a = store.one(
        "SELECT * FROM artifacts WHERE id=? AND notebook_id=?",
        p[4],
        n,
      );
      if (!a) throw new Error("Note not found.");
      if (method === "PATCH") {
        const b = await body(req);
        store.editArtifact(n, a.id, title(b.title), string(b.text, 100000));
        json(res, 200, { saved: true });
        return;
      }
      if (p[5] === "export" && method === "GET") {
        const text = exportMarkdown(a.title, JSON.parse(a.content), (id) => {
          try {
            return store.passage(n, id);
          } catch {
            return null;
          }
        });
        res.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": 'attachment; filename="codeboom-note.md"',
        });
        res.end(text);
        return;
      }
      if (p[5] === "promote" && method === "POST") {
        if (a.unavailable)
          throw new Error(
            "This note has unavailable evidence and cannot be promoted.",
          );
        const content = JSON.parse(a.content),
          text =
            content.text ??
            content.blocks?.map((b: any) => b.text).join("\n\n") ??
            "";
        const job = store.beginImport(n, a.title, randomUUID());
        void service.import(n, job.id, {
          title: a.title,
          kind: "note",
          bytes: Buffer.from(text),
          derivedFrom: a.id,
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
const shutdown = () => {
  service.shutdown();
  server.close();
  if (existsSync(lock)) unlinkSync(lock);
  setTimeout(() => {
    store.close();
    process.exit(0);
  }, 1000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
