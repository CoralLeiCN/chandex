import { limits } from "../domain/limits.ts";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  renameSync,
  readFileSync,
  unlinkSync,
  readdirSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import {
  chunkText,
  digest,
  contextKey,
  type Passage,
  type Answer,
} from "../domain/evidence.ts";
import type { Extracted } from "../ingestion/extract.ts";
const now = () => new Date().toISOString();
const id = () => randomUUID();
const parse = (v: any) => (v == null ? null : JSON.parse(v));
export class Store {
  readonly db: DatabaseSync;
  readonly blobs: string;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.blobs = path.join(root, "blobs");
    mkdirSync(this.blobs, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(root, "codeboom.sqlite"));
    this.db
      .exec(`PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS notebooks(id TEXT PRIMARY KEY,title TEXT NOT NULL,instructions TEXT NOT NULL DEFAULT '',generation INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,title TEXT NOT NULL,kind TEXT NOT NULL,origin TEXT,current_revision TEXT,removed INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL,derived_from TEXT);
      CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,hash TEXT NOT NULL,blob TEXT,sections TEXT NOT NULL,warnings TEXT NOT NULL,created TEXT NOT NULL,extractor TEXT NOT NULL DEFAULT '1');
      CREATE TABLE IF NOT EXISTS passages(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,revision_id TEXT NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,title TEXT NOT NULL,locator TEXT NOT NULL,text TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS passage_fts USING fts5(passage_id UNINDEXED,text,title);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,title TEXT NOT NULL,selected TEXT NOT NULL DEFAULT '[]',created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,status TEXT NOT NULL,generation INTEGER NOT NULL,context_key TEXT NOT NULL,manifest TEXT NOT NULL,question TEXT NOT NULL,kind TEXT NOT NULL,model TEXT NOT NULL,output TEXT,error TEXT,idempotency TEXT NOT NULL UNIQUE,created TEXT NOT NULL,ended TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(conversation_id) WHERE status IN ('queued','running','validating');
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,role TEXT NOT NULL,content TEXT NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,title TEXT NOT NULL,kind TEXT NOT NULL,content TEXT NOT NULL,authored INTEGER NOT NULL,run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,unavailable INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL,updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS artifact_revisions(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,content TEXT NOT NULL,authored INTEGER NOT NULL,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,title TEXT NOT NULL,status TEXT NOT NULL,error TEXT,source_id TEXT,idempotency TEXT NOT NULL UNIQUE,created TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,data TEXT NOT NULL);
      INSERT OR IGNORE INTO migrations VALUES(1);
    `);
    if (!this.one("SELECT version FROM migrations WHERE version=2"))
      this.tx(() => {
        this.db.exec(
          "ALTER TABLE revisions ADD COLUMN normalized_hash TEXT; ALTER TABLE runs ADD COLUMN retry_of TEXT REFERENCES runs(id) ON DELETE SET NULL; ALTER TABLE runs ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1; ALTER TABLE runs ADD COLUMN provider TEXT NOT NULL DEFAULT 'codex-configured'; INSERT INTO migrations VALUES(2);",
        );
        for (const r of this.all("SELECT id,sections FROM revisions"))
          this.run(
            "UPDATE revisions SET normalized_hash=? WHERE id=?",
            digest(r.sections),
            r.id,
          );
      });
    if (!this.one("SELECT version FROM migrations WHERE version=3"))
      this.tx(() => {
        this.db.exec(
          "ALTER TABLE revisions ADD COLUMN origin TEXT; ALTER TABLE runs ADD COLUMN runtime_thread_id TEXT; ALTER TABLE runs ADD COLUMN runtime_version TEXT NOT NULL DEFAULT '0.161.0'; ALTER TABLE runs ADD COLUMN stats TEXT; INSERT INTO migrations VALUES(3);",
        );
        this.db.exec(
          "UPDATE revisions SET origin=(SELECT origin FROM sources WHERE sources.id=revisions.source_id)",
        );
      });
    this.db
      .prepare(
        "UPDATE runs SET status='interrupted',error='Application restarted before the run completed.',ended=? WHERE status IN ('queued','running','validating')",
      )
      .run(now());
    this.db
      .prepare(
        "UPDATE jobs SET status='failed',error='Import interrupted. Retry the source.' WHERE status='processing'",
      )
      .run();
    const retained = new Set(
      this.all("SELECT blob FROM revisions WHERE blob IS NOT NULL").map(
        (r) => r.blob,
      ),
    );
    for (const name of readdirSync(this.blobs))
      if (
        name.endsWith(".tmp") ||
        (!retained.has(name) && name.endsWith(".bin"))
      )
        unlinkSync(path.join(this.blobs, name));
  }
  one(sql: string, ...args: any[]): any {
    return this.db.prepare(sql).get(...args);
  }
  all(sql: string, ...args: any[]): any[] {
    return this.db.prepare(sql).all(...args);
  }
  run(sql: string, ...args: any[]) {
    return this.db.prepare(sql).run(...args);
  }
  tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  notebook(n: string) {
    const row = this.one("SELECT * FROM notebooks WHERE id=?", n);
    if (!row) throw new Error("Notebook not found.");
    return row;
  }
  conversation(n: string, c: string) {
    const row = this.one(
      "SELECT * FROM conversations WHERE id=? AND notebook_id=?",
      c,
      n,
    );
    if (!row) throw new Error("Conversation not found.");
    return row;
  }
  createNotebook(title: string) {
    const n = id();
    this.run(
      "INSERT INTO notebooks(id,title,created) VALUES(?,?,?)",
      n,
      title,
      now(),
    );
    this.createConversation(n);
    return this.notebook(n);
  }
  createConversation(n: string) {
    this.notebook(n);
    const c = id();
    const selected = this.all(
      "SELECT id FROM sources WHERE notebook_id=? AND removed=0",
      n,
    ).map((s) => s.id);
    this.run(
      "INSERT INTO conversations VALUES(?,?,?,?,?)",
      c,
      n,
      "Research conversation",
      JSON.stringify(selected),
      now(),
    );
    return this.conversation(n, c);
  }
  invalidate(n: string) {
    this.run("UPDATE notebooks SET generation=generation+1 WHERE id=?", n);
    this.run(
      "UPDATE runs SET status='cancelled',error='Sources or instructions changed.',ended=? WHERE notebook_id=? AND status IN ('queued','running','validating')",
      now(),
      n,
    );
  }
  updateNotebook(
    n: string,
    data: { title?: string; instructions?: string; archived?: boolean },
  ) {
    return this.tx(() => {
      this.notebook(n);
      if (data.title !== undefined)
        this.run("UPDATE notebooks SET title=? WHERE id=?", data.title, n);
      if (data.archived !== undefined)
        this.run(
          "UPDATE notebooks SET archived=? WHERE id=?",
          Number(data.archived),
          n,
        );
      if (data.instructions !== undefined) {
        this.invalidate(n);
        this.run(
          "UPDATE notebooks SET instructions=? WHERE id=?",
          data.instructions,
          n,
        );
      }
      return this.notebook(n);
    });
  }
  setSelection(n: string, c: string, selected: string[]) {
    this.conversation(n, c);
    const allowed = new Set(
      this.all(
        "SELECT id FROM sources WHERE notebook_id=? AND removed=0",
        n,
      ).map((x) => x.id),
    );
    if (selected.some((s) => !allowed.has(s)))
      throw new Error("Invalid source selection.");
    this.tx(() => {
      this.invalidate(n);
      this.run(
        "UPDATE conversations SET selected=? WHERE id=?",
        JSON.stringify([...new Set(selected)]),
        c,
      );
    });
  }
  beginImport(n: string, title: string, key: string) {
    this.notebook(n);
    const existing = this.one("SELECT * FROM jobs WHERE idempotency=?", key);
    if (existing) {
      if (existing.notebook_id !== n)
        throw new Error("Idempotency key belongs to another notebook.");
      return existing;
    }
    const job = {
      id: id(),
      notebook_id: n,
      title,
      status: "processing",
      created: now(),
    };
    this.run(
      "INSERT INTO jobs(id,notebook_id,title,status,idempotency,created) VALUES(?,?,?,?,?,?)",
      job.id,
      n,
      title,
      job.status,
      key,
      job.created,
    );
    return job;
  }
  publishImport(
    n: string,
    job: string,
    title: string,
    kind: string,
    origin: string | null,
    bytes: Buffer,
    extracted: Extracted,
    sourceId?: string,
    derivedFrom?: string,
  ) {
    this.notebook(n);
    const hash = digest(bytes);
    const existing = this.one(
      "SELECT s.id FROM sources s JOIN revisions r ON r.id=s.current_revision WHERE s.notebook_id=? AND s.removed=0 AND r.hash=?",
      n,
      hash,
    );
    if (existing && (!sourceId || existing.id === sourceId)) {
      this.run(
        "UPDATE jobs SET status='completed',source_id=? WHERE id=?",
        existing.id,
        job,
      );
      return existing.id;
    }
    if (
      sourceId &&
      !this.one(
        "SELECT id FROM sources WHERE id=? AND notebook_id=? AND removed=0",
        sourceId,
        n,
      )
    )
      throw new Error("Source not found.");
    if (
      !sourceId &&
      this.one(
        "SELECT count(*) AS count FROM sources WHERE notebook_id=? AND removed=0",
        n,
      ).count >= limits.sources
    )
      throw new Error(
        "Notebook has reached its " + limits.sources + "-source limit.",
      );
    const s = sourceId ?? id(),
      r = id(),
      blob = r + ".bin";
    writeFileSync(path.join(this.blobs, blob + ".tmp"), bytes, { mode: 0o600 });
    renameSync(
      path.join(this.blobs, blob + ".tmp"),
      path.join(this.blobs, blob),
    );
    try {
      return this.tx(() => {
        if (!sourceId)
          this.run(
            "INSERT INTO sources(id,notebook_id,title,kind,origin,created,derived_from) VALUES(?,?,?,?,?,?,?)",
            s,
            n,
            title,
            kind,
            origin,
            now(),
            derivedFrom ?? null,
          );
        this.run(
          "INSERT INTO revisions(id,source_id,hash,blob,sections,warnings,created) VALUES(?,?,?,?,?,?,?)",
          r,
          s,
          hash,
          blob,
          JSON.stringify(extracted.sections),
          JSON.stringify(extracted.warnings),
          now(),
        );
        this.run(
          "UPDATE revisions SET normalized_hash=?,origin=? WHERE id=?",
          digest(JSON.stringify(extracted.sections)),
          origin,
          r,
        );
        for (const [sectionIndex, section] of extracted.sections.entries())
          for (const p of chunkText(
            section.text,
            s,
            r,
            title,
            section.locator,
          )) {
            p.id = digest(r + ":" + sectionIndex + ":" + p.start).slice(0, 32);
            this.run(
              "INSERT INTO passages VALUES(?,?,?,?,?,?,?,?)",
              p.id,
              s,
              r,
              title,
              p.locator,
              p.text,
              p.start,
              p.end,
            );
            this.run(
              "INSERT INTO passage_fts VALUES(?,?,?)",
              p.id,
              p.text,
              title,
            );
          }
        this.run("UPDATE sources SET current_revision=? WHERE id=?", r, s);
        if (!sourceId)
          for (const c of this.all(
            "SELECT id,selected FROM conversations WHERE notebook_id=?",
            n,
          ))
            this.run(
              "UPDATE conversations SET selected=? WHERE id=?",
              JSON.stringify([...parse(c.selected), s]),
              c.id,
            );
        this.invalidate(n);
        this.run(
          "UPDATE jobs SET status='completed',source_id=? WHERE id=?",
          s,
          job,
        );
        return s;
      });
    } catch (error) {
      unlinkSync(path.join(this.blobs, blob));
      throw error;
    }
  }
  selectedPassages(n: string, c: string): Passage[] {
    const selection: string[] = parse(this.conversation(n, c).selected);
    return this.all(
      "SELECT p.*,s.derived_from,r.origin,r.warnings FROM passages p JOIN sources s ON s.current_revision=p.revision_id JOIN revisions r ON r.id=p.revision_id WHERE s.notebook_id=? AND s.removed=0 ORDER BY s.created,p.rowid",
      n,
    )
      .filter((p) => selection.includes(p.source_id))
      .map(this.toPassage);
  }
  toPassage(p: any): Passage {
    return {
      id: p.id,
      sourceId: p.source_id,
      revisionId: p.revision_id,
      title: p.title,
      locator: p.locator,
      text: p.text,
      start: p.start,
      end: p.end,
      derivedFrom: p.derived_from ?? null,
      origin: p.origin ?? null,
      warnings: parse(p.warnings) ?? [],
    };
  }
  passage(n: string, p: string) {
    const row = this.one(
      "SELECT p.*,s.derived_from,r.origin,r.warnings FROM passages p JOIN sources s ON p.source_id=s.id JOIN revisions r ON r.id=p.revision_id WHERE p.id=? AND s.notebook_id=?",
      p,
      n,
    );
    if (!row) throw new Error("Evidence is unavailable.");
    return this.toPassage(row);
  }
  search(manifest: Passage[], query: string, limit: number): Passage[] {
    const terms = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 20);
    if (!terms?.length) return [];
    const allowed = new Map(manifest.map((p) => [p.id, p]));
    const expression = terms.map((t) => '"' + t + '"').join(" OR ");
    const revisions = [...new Set(manifest.map((p) => p.revisionId))];
    if (!revisions.length) return [];
    return this.all(
      "SELECT passage_id FROM passage_fts JOIN passages p ON p.id=passage_id WHERE passage_fts MATCH ? AND p.revision_id IN (" +
        revisions.map(() => "?").join(",") +
        ") ORDER BY rank",
      expression,
      ...revisions,
    )
      .filter((p) => allowed.has(p.passage_id))
      .slice(0, limit)
      .map((p) => allowed.get(p.passage_id)!);
  }
  removeSource(n: string, s: string) {
    this.tx(() => {
      if (
        !this.one("SELECT id FROM sources WHERE notebook_id=? AND id=?", n, s)
      )
        throw new Error("Source not found.");
      this.run("UPDATE sources SET removed=1 WHERE id=?", s);
      for (const c of this.all(
        "SELECT id,selected FROM conversations WHERE notebook_id=?",
        n,
      ))
        this.run(
          "UPDATE conversations SET selected=? WHERE id=?",
          JSON.stringify(parse(c.selected).filter((id: string) => id !== s)),
          c.id,
        );
      this.invalidate(n);
    });
  }
  createRun(
    n: string,
    c: string,
    question: string,
    kind: string,
    model: string,
    key: string,
    retryOf?: string,
  ) {
    if (!key.trim() || !question.trim())
      throw new Error("Question and idempotency key are required.");
    const previous = this.one("SELECT * FROM runs WHERE idempotency=?", key);
    if (previous) {
      if (previous.notebook_id !== n || previous.conversation_id !== c)
        throw new Error("Invalid idempotency key.");
      return previous;
    }
    if (
      retryOf &&
      !this.one(
        "SELECT id FROM runs WHERE id=? AND notebook_id=? AND conversation_id=? AND status IN ('failed','cancelled','interrupted')",
        retryOf,
        n,
        c,
      )
    )
      throw new Error("Invalid retry attempt.");
    const nb = this.notebook(n),
      ps = this.selectedPassages(n, c);
    if (!ps.length) throw new Error("Select at least one ready source.");
    if (
      this.one(
        "SELECT count(*) AS count FROM runs WHERE status IN ('queued','running','validating')",
      ).count >= 2
    )
      throw new Error("Two runs are already active. Wait or stop one.");
    const run = id(),
      manifest = [...new Set(ps.map((p) => p.revisionId))];
    this.tx(() => {
      this.run(
        "INSERT INTO runs(id,notebook_id,conversation_id,status,generation,context_key,manifest,question,kind,model,idempotency,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        run,
        n,
        c,
        "queued",
        nb.generation,
        contextKey(manifest, nb.instructions),
        JSON.stringify(manifest),
        question,
        kind,
        model,
        key,
        now(),
      );
      if (retryOf)
        this.run("UPDATE runs SET retry_of=? WHERE id=?", retryOf, run);
      if (kind === "answer")
        this.run(
          "INSERT INTO messages VALUES(?,?,?,?,?,?)",
          id(),
          c,
          run,
          "user",
          JSON.stringify({ text: question }),
          now(),
        );
    });
    return this.one("SELECT * FROM runs WHERE id=?", run);
  }
  event(run: string, data: unknown) {
    this.run(
      "INSERT INTO events(run_id,data) VALUES(?,?)",
      run,
      JSON.stringify(data),
    );
  }
  active(run: string) {
    return !!this.one(
      "SELECT r.id FROM runs r JOIN notebooks n ON n.id=r.notebook_id WHERE r.id=? AND r.generation=n.generation AND r.status IN ('queued','running','validating')",
      run,
    );
  }
  completeRun(run: string, answer: Answer) {
    return this.tx(() => {
      if (!this.active(run)) return false;
      const r = this.one("SELECT * FROM runs WHERE id=?", run);
      this.run(
        "UPDATE runs SET status='completed',output=?,ended=? WHERE id=?",
        JSON.stringify(answer),
        now(),
        run,
      );
      if (r.kind === "answer")
        this.run(
          "INSERT INTO messages VALUES(?,?,?,?,?,?)",
          id(),
          r.conversation_id,
          run,
          "assistant",
          JSON.stringify(answer),
          now(),
        );
      else
        this.saveArtifact(
          r.notebook_id,
          answer.title,
          r.kind,
          JSON.stringify(answer),
          false,
          run,
        );
      this.event(run, { type: "completed" });
      return true;
    });
  }
  saveArtifact(
    n: string,
    title: string,
    kind: string,
    content: string,
    authored: boolean,
    runId: string | null = null,
  ) {
    return this.tx(() => {
      this.notebook(n);
      const a = id();
      this.run(
        "INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?)",
        a,
        n,
        title,
        kind,
        content,
        Number(authored),
        runId,
        0,
        now(),
        now(),
      );
      this.run(
        "INSERT INTO artifact_revisions VALUES(?,?,?,?,?)",
        id(),
        a,
        content,
        Number(authored),
        now(),
      );
      return a;
    });
  }
  editArtifact(n: string, a: string, title: string, text: string) {
    if (
      !this.one("SELECT id FROM artifacts WHERE id=? AND notebook_id=?", a, n)
    )
      throw new Error("Note not found.");
    this.tx(() => {
      const content = JSON.stringify({ text });
      this.run(
        "UPDATE artifacts SET title=?,content=?,authored=1,updated=? WHERE id=?",
        title,
        content,
        now(),
        a,
      );
      this.run(
        "INSERT INTO artifact_revisions VALUES(?,?,?,?,?)",
        id(),
        a,
        content,
        1,
        now(),
      );
    });
  }
  view(n: string) {
    const nb = this.notebook(n);
    return {
      ...nb,
      sources: this.all(
        "SELECT s.*,r.warnings,r.hash FROM sources s LEFT JOIN revisions r ON r.id=s.current_revision WHERE s.notebook_id=? ORDER BY s.created",
        n,
      ).map((s) => ({ ...s, warnings: parse(s.warnings) })),
      conversations: this.all(
        "SELECT * FROM conversations WHERE notebook_id=? ORDER BY created",
        n,
      ).map((c) => ({ ...c, selected: parse(c.selected) })),
      messages: this.all(
        "SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.notebook_id=? ORDER BY m.created,m.rowid",
        n,
      ).map((m) => ({ ...m, content: parse(m.content) })),
      runs: this.all(
        "SELECT * FROM runs WHERE notebook_id=? ORDER BY created",
        n,
      ).map((r) => ({
        ...r,
        output: parse(r.output),
        manifest: parse(r.manifest),
      })),
      artifacts: this.all(
        "SELECT * FROM artifacts WHERE notebook_id=? ORDER BY updated DESC",
        n,
      ).map((a) => ({ ...a, content: parse(a.content) })),
      jobs: this.all(
        "SELECT * FROM jobs WHERE notebook_id=? ORDER BY created DESC",
        n,
      ),
    };
  }
  purgeSource(n: string, s: string, visited = new Set<string>()) {
    if (visited.has(s)) return;
    visited.add(s);
    this.removeSource(n, s);
    const revisions = this.all("SELECT * FROM revisions WHERE source_id=?", s),
      revisionIds = new Set(revisions.map((r) => r.id));
    const affected = this.all(
      "SELECT * FROM runs WHERE notebook_id=?",
      n,
    ).filter((r) => parse(r.manifest).some((v: string) => revisionIds.has(v)));
    const derived: string[] = [];
    this.tx(() => {
      const unavailable = JSON.stringify({
        text: "Evidence was purged. This generated output is unavailable.",
      });
      for (const r of affected) {
        this.run("UPDATE runs SET output=NULL WHERE id=?", r.id);
        this.run(
          "UPDATE messages SET content=? WHERE run_id=? AND role='assistant'",
          unavailable,
          r.id,
        );
        const artifacts = this.all(
          "SELECT * FROM artifacts WHERE run_id=?",
          r.id,
        );
        for (const a of artifacts) {
          derived.push(
            ...this.all(
              "SELECT id FROM sources WHERE derived_from=? AND notebook_id=?",
              a.id,
              n,
            ).map((s) => s.id),
          );
          this.run(
            "UPDATE artifacts SET unavailable=1,content=CASE WHEN authored=0 THEN ? ELSE content END WHERE id=?",
            unavailable,
            a.id,
          );
          this.run(
            "UPDATE artifact_revisions SET content=? WHERE artifact_id=? AND authored=0",
            unavailable,
            a.id,
          );
        }
        this.run("DELETE FROM events WHERE run_id=?", r.id);
      }
      for (const p of this.all("SELECT id FROM passages WHERE source_id=?", s))
        this.run("DELETE FROM passage_fts WHERE passage_id=?", p.id);
      this.run("DELETE FROM passages WHERE source_id=?", s);
      this.run(
        "UPDATE revisions SET sections='[]',warnings='[\"Evidence purged\"]' WHERE source_id=?",
        s,
      );
    });
    for (const r of revisions)
      if (r.blob && existsSync(path.join(this.blobs, r.blob)))
        unlinkSync(path.join(this.blobs, r.blob));
    this.run("UPDATE revisions SET blob=NULL WHERE source_id=?", s);
    for (const source of derived) this.purgeSource(n, source, visited);
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  deleteNotebook(n: string) {
    this.notebook(n);
    for (const s of this.all("SELECT id FROM sources WHERE notebook_id=?", n))
      this.purgeSource(n, s.id);
    this.run("DELETE FROM notebooks WHERE id=?", n);
  }
  close() {
    this.db.close();
  }
}
