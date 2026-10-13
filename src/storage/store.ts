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
  rmSync,
} from "node:fs";
import path from "node:path";
import {
  chunkText,
  digest,
  contextKey,
  OUTPUT_CONTRACT_VERSION,
  validateAnswer,
  type Passage,
  type Answer,
  type Citation,
} from "../domain/evidence.ts";
import type { Extracted } from "../ingestion/extract.ts";
import { EXTRACTION_VERSION } from "../ingestion/version.ts";
import { isArtifactKind, documentText } from "../domain/artifacts.ts";
import {
  fold,
  notebookInstructions,
  notebookTags,
  starterQuestions,
  recipe,
  builtinTemplates,
  type NotebookTemplate,
  type DiscoveryResult,
} from "../domain/notebooks.ts";
import { isStudyKind, studyCount, validateStudy } from "../domain/study.ts";
import { isStructuredKind } from "../domain/structured.ts";
import { initialRunStats } from "../domain/run-stats.ts";
import {
  richNote,
  editableNote,
  noteCitations,
  isRichNote,
  type NoteNode,
} from "../domain/notes.ts";
import { SpeechStore } from "./speech-store.ts";
import { NoteDraftStore } from "./note-draft-store.ts";
import {
  safeDriveProvenance,
  type DriveProvenance,
} from "../domain/drive-provenance.ts";
const now = () => new Date().toISOString();
const id = () => randomUUID();
const parse = (v: any) => (v == null ? null : JSON.parse(v));
export interface ImportDescriptor {
  kind: string;
  url?: string;
  driveUrl?: string;
  sourceId?: string;
  derivedFrom?: string;
  derivedRevision?: string;
}
export class Store {
  readonly db: DatabaseSync;
  readonly blobs: string;
  readonly speech: SpeechStore;
  readonly drafts: NoteDraftStore;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.blobs = path.join(root, "blobs");
    mkdirSync(this.blobs, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(root, "codeboom.sqlite"));
    this.db.function("unicode_fold", { deterministic: true }, (value) =>
      fold(String(value ?? "")),
    );
    this.db.function("note_text", { deterministic: true }, (value) =>
      documentText(JSON.parse(String(value)), true),
    );
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
    if (!this.one("SELECT version FROM migrations WHERE version=4"))
      this.tx(() => {
        this.db.exec(
          "ALTER TABLE runs ADD COLUMN error_category TEXT; INSERT INTO migrations VALUES(4);",
        );
      });
    if (!this.one("SELECT version FROM migrations WHERE version=5"))
      this.tx(() => {
        this.db.exec(
          "ALTER TABLE sources ADD COLUMN requested_origin TEXT; ALTER TABLE revisions ADD COLUMN requested_origin TEXT; ALTER TABLE revisions ADD COLUMN retrieved_at TEXT; INSERT INTO migrations VALUES(5);",
        );
        // Legacy imports only recorded the final URL. Leave the requested URL
        // and retrieval time unknown rather than inventing missing provenance.
      });
    if (!this.one("SELECT version FROM migrations WHERE version=6"))
      this.tx(() => {
        this.db.exec(
          "ALTER TABLE runs ADD COLUMN failure_draft TEXT; INSERT INTO migrations VALUES(6);",
        );
      });
    if (!this.one("SELECT version FROM migrations WHERE version=7"))
      this.tx(() => {
        this.db.exec(
          "ALTER TABLE jobs ADD COLUMN duplicate_revision TEXT; INSERT INTO migrations VALUES(7);",
        );
      });
    if (!this.one("SELECT version FROM migrations WHERE version=8"))
      this.tx(() => {
        this.db.exec(
          "ALTER TABLE revisions ADD COLUMN derived_revision TEXT REFERENCES artifact_revisions(id); ALTER TABLE artifact_revisions ADD COLUMN title TEXT; INSERT INTO migrations VALUES(8);",
        );
        // Earlier promotions did not pin a note revision. Do not guess which
        // revision produced their bytes or assign today's title to old edits.
      });
    if (!this.one("SELECT version FROM migrations WHERE version=9"))
      this.tx(() => {
        this.db.exec(`
          ALTER TABLE jobs ADD COLUMN type TEXT NOT NULL DEFAULT 'unknown';
          ALTER TABLE jobs ADD COLUMN input_kind TEXT NOT NULL DEFAULT 'unknown';
          ALTER TABLE jobs ADD COLUMN input_metadata TEXT;
          ALTER TABLE jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE jobs ADD COLUMN retry_of TEXT REFERENCES jobs(id) ON DELETE SET NULL;
          ALTER TABLE jobs ADD COLUMN started TEXT;
          ALTER TABLE jobs ADD COLUMN updated TEXT;
          ALTER TABLE jobs ADD COLUMN ended TEXT;
          CREATE UNIQUE INDEX one_import_retry ON jobs(retry_of) WHERE retry_of IS NOT NULL;
          CREATE TRIGGER jobs_lifecycle AFTER UPDATE OF status ON jobs
          WHEN OLD.status IS NOT NEW.status BEGIN
            UPDATE jobs SET updated=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              ended=CASE WHEN NEW.status IN ('completed','failed','dismissed')
                THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END
              WHERE id=NEW.id;
          END;
          INSERT INTO migrations VALUES(9);
        `);
        // Historic execution descriptors and completion times are unknown.
      });
    if (!this.one("SELECT version FROM migrations WHERE version=10"))
      this.tx(() => {
        this.db.exec(`
          ALTER TABLE notebooks ADD COLUMN instruction_version INTEGER NOT NULL DEFAULT 1;
          ALTER TABLE notebooks ADD COLUMN updated TEXT;
          ALTER TABLE runs ADD COLUMN instruction_version INTEGER;
          ALTER TABLE runs ADD COLUMN instruction_snapshot TEXT;
          ALTER TABLE runs ADD COLUMN grounding_mode TEXT NOT NULL DEFAULT 'sources';
          INSERT INTO migrations VALUES(10);
        `);
        // Version 1 is the first recorded current instruction version. Older
        // runs and notebook edit times were not captured; leave them unknown.
      });
    if (!this.one("SELECT version FROM migrations WHERE version=11"))
      this.tx(() => {
        this.db.exec(`
          ALTER TABLE runs ADD COLUMN study_count INTEGER CHECK(study_count BETWEEN 5 AND 20);
          CREATE TABLE quiz_attempts(id TEXT PRIMARY KEY,notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,revision_id TEXT NOT NULL REFERENCES artifact_revisions(id) ON DELETE CASCADE,answers TEXT NOT NULL DEFAULT '{}',submitted TEXT,score INTEGER,total INTEGER NOT NULL,idempotency TEXT NOT NULL UNIQUE,created TEXT NOT NULL,updated TEXT NOT NULL);
          CREATE INDEX quiz_attempts_artifact ON quiz_attempts(artifact_id,created);
          INSERT INTO migrations VALUES(11);
        `);
      });
    if (!this.one("SELECT version FROM migrations WHERE version=12"))
      this.tx(() => {
        this.db.exec(`
        ALTER TABLE notebooks ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE notebooks ADD COLUMN starter_questions TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE notebooks ADD COLUMN template_snapshot TEXT;
        CREATE TABLE notebook_templates(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,instructions TEXT NOT NULL,tags TEXT NOT NULL,questions TEXT NOT NULL,version INTEGER NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);
        CREATE VIRTUAL TABLE note_fts USING fts5(artifact_id UNINDEXED,title,text);
        INSERT INTO note_fts(artifact_id,title,text) SELECT id,title,note_text(content) FROM artifacts WHERE unavailable=0 OR authored=1;
        CREATE TRIGGER note_search_insert AFTER INSERT ON artifacts BEGIN
          INSERT INTO note_fts(artifact_id,title,text) SELECT NEW.id,NEW.title,note_text(NEW.content) WHERE NEW.unavailable=0 OR NEW.authored=1;
        END;
        CREATE TRIGGER note_search_update AFTER UPDATE OF title,content,authored,unavailable ON artifacts BEGIN
          DELETE FROM note_fts WHERE artifact_id=OLD.id;
          INSERT INTO note_fts(artifact_id,title,text) SELECT NEW.id,NEW.title,note_text(NEW.content) WHERE NEW.unavailable=0 OR NEW.authored=1;
        END;
        CREATE TRIGGER note_search_delete AFTER DELETE ON artifacts BEGIN DELETE FROM note_fts WHERE artifact_id=OLD.id; END;
        INSERT INTO migrations VALUES(12);
      `);
      });
    if (!this.one("SELECT version FROM migrations WHERE version=13"))
      this.tx(() => {
        this.db.exec(`
        CREATE TABLE speech_jobs(id TEXT PRIMARY KEY,notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,revision_id TEXT NOT NULL REFERENCES artifact_revisions(id) ON DELETE CASCADE,status TEXT NOT NULL CHECK(status IN ('processing','completed','failed','cancelled','interrupted','unavailable')),provider TEXT NOT NULL,voice_id TEXT NOT NULL,script_hash TEXT NOT NULL,script_version INTEGER NOT NULL,idempotency TEXT NOT NULL UNIQUE,retry_of TEXT REFERENCES speech_jobs(id) ON DELETE SET NULL,created TEXT NOT NULL,ended TEXT,error TEXT);
        CREATE UNIQUE INDEX one_speech_render ON speech_jobs(revision_id) WHERE status='processing';
        CREATE UNIQUE INDEX one_speech_retry ON speech_jobs(retry_of) WHERE retry_of IS NOT NULL;
        CREATE TABLE speech_assets(id TEXT PRIMARY KEY,notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,revision_id TEXT NOT NULL REFERENCES artifact_revisions(id) ON DELETE CASCADE,job_id TEXT NOT NULL REFERENCES speech_jobs(id) ON DELETE CASCADE,blob TEXT,hash TEXT NOT NULL,size INTEGER NOT NULL,duration REAL NOT NULL,provider TEXT NOT NULL,voice_id TEXT NOT NULL,renderer_version INTEGER NOT NULL,os_version TEXT NOT NULL,script_hash TEXT NOT NULL,script_version INTEGER NOT NULL,available INTEGER NOT NULL DEFAULT 1,created TEXT NOT NULL);
        INSERT INTO migrations VALUES(13);
      `);
      });
    if (!this.one("SELECT version FROM migrations WHERE version=14"))
      this.tx(() => {
        this.db.exec(
          `CREATE TABLE note_conversations(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,note_revision TEXT NOT NULL,source_id TEXT NOT NULL,UNIQUE(notebook_id,note_revision)); INSERT INTO migrations VALUES(14);`,
        );
      });
    if (!this.one("SELECT version FROM migrations WHERE version=15"))
      this.tx(() => {
        this.db.exec(
          "ALTER TABLE revisions ADD COLUMN provider_metadata TEXT; INSERT INTO migrations VALUES(15);",
        );
      });
    if (!this.one("SELECT version FROM migrations WHERE version=16"))
      this.tx(() => {
        this.db.exec(
          "ALTER TABLE revisions ADD COLUMN kind TEXT; UPDATE revisions SET kind=(SELECT s.kind FROM sources s WHERE s.id=revisions.source_id AND s.current_revision=revisions.id); INSERT INTO migrations VALUES(16);",
        );
        // The current source kind does not identify earlier revisions after a
        // URL refresh changes format. Leave those historical kinds unknown.
      });
    if (!this.one("SELECT version FROM migrations WHERE version=17"))
      this.tx(() => {
        this.db.exec(`CREATE TABLE note_drafts(
          id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
          artifact_id TEXT REFERENCES artifacts(id) ON DELETE CASCADE,
          base_revision_id TEXT REFERENCES artifact_revisions(id), version INTEGER NOT NULL,
          title TEXT NOT NULL, document TEXT, updated TEXT NOT NULL, closed INTEGER NOT NULL DEFAULT 0
        ); CREATE INDEX note_drafts_notebook ON note_drafts(notebook_id,artifact_id,closed);
        INSERT INTO migrations VALUES(17);`);
      });
    if (!this.one("SELECT version FROM migrations WHERE version=18"))
      this.tx(() => {
        this.db.exec(`
          ALTER TABLE artifacts ADD COLUMN trashed_at TEXT;
          ALTER TABLE artifacts ADD COLUMN trash_version INTEGER NOT NULL DEFAULT 0;
          CREATE TABLE deleted_notes(id TEXT PRIMARY KEY,notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,trash_version INTEGER NOT NULL);
          DROP TRIGGER note_search_insert;
          DROP TRIGGER note_search_update;
          CREATE TRIGGER note_search_insert AFTER INSERT ON artifacts BEGIN
            INSERT INTO note_fts(artifact_id,title,text) SELECT NEW.id,NEW.title,note_text(NEW.content) WHERE NEW.trashed_at IS NULL AND (NEW.unavailable=0 OR NEW.authored=1);
          END;
          CREATE TRIGGER note_search_update AFTER UPDATE OF title,content,authored,unavailable,trashed_at ON artifacts BEGIN
            DELETE FROM note_fts WHERE artifact_id=OLD.id;
            INSERT INTO note_fts(artifact_id,title,text) SELECT NEW.id,NEW.title,note_text(NEW.content) WHERE NEW.trashed_at IS NULL AND (NEW.unavailable=0 OR NEW.authored=1);
          END;
          INSERT INTO migrations VALUES(18);
        `);
      });
    this.drafts = new NoteDraftStore(this);
    this.speech = new SpeechStore(this);
    this.run(
      "UPDATE speech_jobs SET status='interrupted',error='Speech rendering was interrupted. Retry explicitly.',ended=? WHERE status='processing'",
      now(),
    );
    rmSync(path.join(root, "speech-staging"), { recursive: true, force: true });
    this.tx(() => {
      const unfinished = this.all(
        "SELECT id FROM runs WHERE status IN ('queued','running','validating')",
      );
      const error = "Application restarted before the run completed.";
      this.run(
        "UPDATE runs SET status='interrupted',error_category='interrupted',error=?,ended=? WHERE status IN ('queued','running','validating')",
        error,
        now(),
      );
      for (const run of unfinished)
        this.event(run.id, { type: "interrupted", text: error });
      this.run(
        "UPDATE jobs SET status='failed',error='Import interrupted. Retry the source.' WHERE status='processing'",
      );
    });
    const retained = new Set(
      this.all(
        "SELECT blob FROM revisions WHERE blob IS NOT NULL UNION SELECT blob FROM speech_assets WHERE blob IS NOT NULL",
      ).map((r) => r.blob),
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
    return {
      ...row,
      tags: parse(row.tags),
      starterQuestions: parse(row.starter_questions),
      templateSnapshot: parse(row.template_snapshot),
    };
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
  createNotebook(
    title: string,
    options: {
      templateId?: string;
      templateVersion?: number;
      instructions?: string;
      tags?: unknown;
      questions?: unknown;
    } = {},
  ) {
    const template = options.templateId
      ? this.template(options.templateId)
      : null;
    if (template && options.templateVersion !== template.version)
      throw new Error(
        "Template changed. Review its current version before creating the notebook.",
      );
    const instructions = notebookInstructions(
      options.instructions ?? template?.instructions ?? "",
    );
    const tags = notebookTags(options.tags ?? template?.tags ?? []),
      questions = starterQuestions(
        options.questions ?? template?.questions ?? [],
      );
    const n = id(),
      timestamp = now();
    return this.tx(() => {
      this.run(
        "INSERT INTO notebooks(id,title,created,updated,instructions,tags,starter_questions,template_snapshot) VALUES(?,?,?,?,?,?,?,?)",
        n,
        title,
        timestamp,
        timestamp,
        instructions,
        JSON.stringify(tags),
        JSON.stringify(questions),
        template ? JSON.stringify(template) : null,
      );
      this.createConversation(n);
      return this.notebook(n);
    });
  }
  notebooks() {
    return this.all(
      "SELECT id,title,archived,created,updated,tags FROM notebooks ORDER BY created DESC,id",
    ).map((n) => ({ ...n, tags: parse(n.tags) }));
  }
  templates(): NotebookTemplate[] {
    return [
      ...builtinTemplates,
      ...this.all("SELECT * FROM notebook_templates ORDER BY title,id").map(
        (t) => ({
          ...t,
          tags: parse(t.tags),
          questions: parse(t.questions),
          builtin: false,
        }),
      ),
    ];
  }
  template(key: string) {
    const t = this.templates().find((t) => t.id === key);
    if (!t) throw new Error("Template not found.");
    return t;
  }
  saveTemplate(value: unknown, key?: string, version?: number) {
    const data = recipe(value);
    return this.tx(() => {
      const previous = key ? this.template(key) : null;
      if (previous?.builtin)
        throw new Error(
          "Built-in templates are read-only. Save a personal copy.",
        );
      if (previous && previous.version !== version)
        throw new Error("Template changed. Reload before editing.");
      if (
        previous &&
        JSON.stringify(
          recipe({
            title: previous.title,
            description: previous.description,
            instructions: previous.instructions,
            tags: previous.tags,
            questions: previous.questions,
          }),
        ) === JSON.stringify(data)
      )
        return previous;
      if (
        !previous &&
        this.one("SELECT count(*) AS n FROM notebook_templates").n >= 100
      )
        throw new Error("Use at most 100 personal templates.");
      const keyId = key ?? id(),
        timestamp = now();
      if (previous)
        this.run(
          "UPDATE notebook_templates SET title=?,description=?,instructions=?,tags=?,questions=?,version=version+1,updated=? WHERE id=?",
          data.title,
          data.description,
          data.instructions,
          JSON.stringify(data.tags),
          JSON.stringify(data.questions),
          timestamp,
          keyId,
        );
      else
        this.run(
          "INSERT INTO notebook_templates VALUES(?,?,?,?,?,?,?,?,?)",
          keyId,
          data.title,
          data.description,
          data.instructions,
          JSON.stringify(data.tags),
          JSON.stringify(data.questions),
          1,
          timestamp,
          timestamp,
        );
      return this.template(keyId);
    });
  }
  deleteTemplate(key: string, version: number) {
    const previous = this.template(key);
    if (previous.builtin) throw new Error("Built-in templates are read-only.");
    if (previous.version !== version)
      throw new Error("Template changed. Reload before deleting.");
    this.run("DELETE FROM notebook_templates WHERE id=?", key);
  }
  discover(
    query = "",
    options: {
      tag?: string;
      archived?: boolean;
      offset?: number;
      limit?: number;
    } = {},
  ) {
    if (
      typeof query !== "string" ||
      Array.from(query).length > 200 ||
      query.includes("\0")
    )
      throw new Error("Search must be at most 200 characters.");
    const q = fold(query.trim()),
      offset = options.offset ?? 0,
      limit = options.limit ?? 30;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 1000000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw new Error("Invalid discovery page.");
    const tag = options.tag ? fold(notebookTags([options.tag])[0]) : "",
      tokens = q.match(/[\p{L}\p{N}_]+/gu) ?? [];
    const filters =
      "(:archived=1 OR n.archived=0) AND (:tag='' OR EXISTS(SELECT 1 FROM json_each(n.tags) t WHERE unicode_fold(t.value)=:tag))";
    const params = {
      q,
      tag,
      archived: options.archived ? 1 : 0,
      offset,
      limit: limit + 1,
      fts: tokens.map((t) => '"' + t + '"').join(" AND "),
    };
    const parts = [
      `SELECT 0 AS rank,'notebook' AS kind,n.id,n.id AS notebookId,n.title AS notebookTitle,n.archived,n.title,'' AS snippet,NULL AS locator,NULL AS revisionId FROM notebooks n WHERE ${filters} AND (:q='' OR instr(unicode_fold(n.title),:q)>0 OR EXISTS(SELECT 1 FROM json_each(n.tags) t WHERE instr(unicode_fold(t.value),:q)>0))`,
    ];
    if (q) {
      parts.push(
        `SELECT 1,'source',s.id,n.id,n.title,n.archived,s.title,'',NULL,s.current_revision FROM sources s JOIN notebooks n ON n.id=s.notebook_id WHERE ${filters} AND s.removed=0 AND s.current_revision IS NOT NULL AND instr(unicode_fold(s.title),:q)>0`,
      );
      if (tokens.length) {
        parts.push(
          `SELECT 2,'passage',p.id,n.id,n.title,n.archived,p.title,snippet(passage_fts,1,'','','…',32),p.locator,p.revision_id FROM passage_fts JOIN passages p ON p.id=passage_fts.passage_id JOIN sources s ON s.id=p.source_id AND s.current_revision=p.revision_id JOIN notebooks n ON n.id=s.notebook_id WHERE ${filters} AND s.removed=0 AND passage_fts MATCH :fts`,
        );
        parts.push(
          `SELECT 3,'note',a.id,n.id,n.title,n.archived,a.title,snippet(note_fts,2,'','','…',32),NULL,(SELECT id FROM artifact_revisions WHERE artifact_id=a.id ORDER BY rowid DESC LIMIT 1) FROM note_fts JOIN artifacts a ON a.id=note_fts.artifact_id JOIN notebooks n ON n.id=a.notebook_id WHERE ${filters} AND a.trashed_at IS NULL AND (a.unavailable=0 OR a.authored=1) AND note_fts MATCH :fts`,
        );
      } else {
        parts.push(
          `SELECT 2,'passage',p.id,n.id,n.title,n.archived,p.title,substr(p.text,1,300),p.locator,p.revision_id FROM passages p JOIN sources s ON s.id=p.source_id AND s.current_revision=p.revision_id JOIN notebooks n ON n.id=s.notebook_id WHERE ${filters} AND s.removed=0 AND instr(unicode_fold(p.text),:q)>0`,
        );
        parts.push(
          `SELECT 3,'note',a.id,n.id,n.title,n.archived,a.title,substr(note_fts.text,1,300),NULL,(SELECT id FROM artifact_revisions WHERE artifact_id=a.id ORDER BY rowid DESC LIMIT 1) FROM note_fts JOIN artifacts a ON a.id=note_fts.artifact_id JOIN notebooks n ON n.id=a.notebook_id WHERE ${filters} AND a.trashed_at IS NULL AND (a.unavailable=0 OR a.authored=1) AND instr(unicode_fold(note_fts.title||' '||note_fts.text),:q)>0`,
        );
      }
    }
    // Unknown named parameters are allowed so metadata-only queries use this same bounded binding shape.
    const statement = this.db.prepare(
      parts.join(" UNION ALL ") +
        " ORDER BY rank,notebookTitle,id LIMIT :limit OFFSET :offset",
    );
    statement.setAllowUnknownNamedParameters(true);
    const rows = statement.all(params) as unknown as (DiscoveryResult & {
      rank: number;
    })[];
    return {
      results: rows.slice(0, limit).map(({ rank, ...r }) => r),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
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
  noteContext(n: string, c: string) {
    this.conversation(n, c);
    const context = this.one(
      "SELECT nc.*,r.artifact_id FROM note_conversations nc JOIN artifact_revisions r ON r.id=nc.note_revision WHERE nc.notebook_id=? AND nc.conversation_id=?",
      n,
      c,
    );
    if (
      context &&
      !this.one(
        "SELECT s.id FROM sources s JOIN revisions r ON r.id=s.current_revision WHERE s.notebook_id=? AND s.id=? AND s.removed=0 AND r.blob IS NOT NULL AND r.derived_revision=?",
        n,
        context.source_id,
        context.note_revision,
      )
    )
      throw new Error(
        "This saved note snapshot was removed or purged. Its conversation is unavailable.",
      );
    if (context)
      this.sourceNoteRevision(n, context.artifact_id, context.note_revision);
    return context;
  }
  private sourceNoteRevision(n: string, a: string, revision: string) {
    const note = this.artifactRevision(n, a, revision);
    if (
      !note.available ||
      note.unavailable ||
      Object.values(note.referenceAvailability).some((available) => !available)
    )
      throw new Error("This note has unavailable evidence or references.");
    return note;
  }
  openNoteConversation(n: string, a: string, revision: string) {
    this.activeArtifact(n, a);
    const note = this.sourceNoteRevision(n, a, revision);
    const existing = this.one(
      "SELECT conversation_id FROM note_conversations WHERE notebook_id=? AND note_revision=?",
      n,
      revision,
    );
    if (existing) {
      this.noteContext(n, existing.conversation_id);
      return this.conversation(n, existing.conversation_id);
    }
    const hasWords = (node: NoteNode): boolean =>
      Boolean(
        node.text?.trim() ||
        (node.type === "citation" && node.attrs?.citation.quote.trim()) ||
        node.content?.some(hasWords),
      );
    if (isRichNote(note.content) && !hasWords(note.content.doc))
      throw new Error("This note has no usable text.");
    const text = documentText(note.content)
      .replace(/\r\n?/g, "\n")
      .normalize("NFC")
      .trim();
    if (!text || text.includes("\0") || Array.from(text).length > 500000)
      throw new Error(
        "This note has no usable text or exceeds the source text limit.",
      );
    let newBlob: string | undefined;
    try {
      return this.tx(() => {
        const descriptor = {
          kind: "note",
          derivedFrom: a,
          derivedRevision: revision,
        };
        const job = this.beginImport(
          n,
          note.title,
          "note-conversation:" + digest(n + ":" + revision),
          descriptor,
        );
        if (job.input_metadata !== JSON.stringify(descriptor))
          throw new Error("Invalid note context operation.");
        const previous = this.one(
          "SELECT id FROM sources WHERE notebook_id=? AND derived_from=? AND kind='note' AND current_revision IN (SELECT id FROM revisions WHERE derived_revision=? AND hash=? AND origin IS NULL AND requested_origin IS NULL) AND removed=0",
          n,
          a,
          revision,
          digest(Buffer.from(text)),
        );
        const source = this.publishImport(
          n,
          job.id,
          note.title,
          "note",
          null,
          Buffer.from(text),
          {
            sections: [{ locator: "Saved note", text }],
            warnings: [
              "Snapshot of a saved note revision; derived material, not independent corroboration.",
            ],
          },
          undefined,
          a,
          undefined,
          false,
          revision,
          false,
        );
        if (!previous)
          newBlob = this.one(
            "SELECT r.blob FROM revisions r JOIN sources s ON s.current_revision=r.id WHERE s.id=?",
            source,
          )?.blob;
        const c = id();
        this.run(
          "INSERT INTO conversations VALUES(?,?,?,?,?)",
          c,
          n,
          "Note: " + note.title,
          JSON.stringify([source]),
          now(),
        );
        this.run(
          "INSERT INTO note_conversations VALUES(?,?,?,?)",
          c,
          n,
          revision,
          source,
        );
        return this.conversation(n, c);
      });
    } catch (error) {
      if (newBlob && existsSync(path.join(this.blobs, newBlob)))
        unlinkSync(path.join(this.blobs, newBlob));
      throw error;
    }
  }
  invalidate(n: string) {
    this.tx(() => {
      const affected = this.all(
        "SELECT id FROM runs WHERE notebook_id=? AND status IN ('queued','running','validating')",
        n,
      );
      this.run(
        "UPDATE notebooks SET generation=generation+1,updated=? WHERE id=?",
        now(),
        n,
      );
      this.run(
        "UPDATE runs SET status='cancelled',error='Sources or instructions changed.',ended=? WHERE notebook_id=? AND status IN ('queued','running','validating')",
        now(),
        n,
      );
      for (const run of affected)
        this.event(run.id, {
          type: "cancelled",
          text: "Sources or instructions changed.",
        });
    });
  }
  updateNotebook(
    n: string,
    data: {
      title?: string;
      instructions?: string;
      archived?: boolean;
      tags?: unknown;
      questions?: unknown;
    },
  ) {
    if (data.instructions !== undefined)
      notebookInstructions(data.instructions);
    return this.tx(() => {
      const previous = this.notebook(n);
      const tags =
          data.tags === undefined ? previous.tags : notebookTags(data.tags),
        questions =
          data.questions === undefined
            ? previous.starterQuestions
            : starterQuestions(data.questions);
      if (
        JSON.stringify(tags) !== JSON.stringify(previous.tags) ||
        JSON.stringify(questions) !== JSON.stringify(previous.starterQuestions)
      )
        this.run(
          "UPDATE notebooks SET tags=?,starter_questions=?,updated=? WHERE id=?",
          JSON.stringify(tags),
          JSON.stringify(questions),
          now(),
          n,
        );
      if (data.title !== undefined && data.title !== previous.title)
        this.run(
          "UPDATE notebooks SET title=?,updated=? WHERE id=?",
          data.title,
          now(),
          n,
        );
      if (
        data.archived !== undefined &&
        Number(data.archived) !== previous.archived
      )
        this.run(
          "UPDATE notebooks SET archived=?,updated=? WHERE id=?",
          Number(data.archived),
          now(),
          n,
        );
      if (
        data.instructions !== undefined &&
        data.instructions !== previous.instructions
      ) {
        this.invalidate(n);
        this.run(
          "UPDATE notebooks SET instructions=?,instruction_version=instruction_version+1 WHERE id=?",
          data.instructions,
          n,
        );
      }
      return this.notebook(n);
    });
  }
  setSelection(n: string, c: string, selected: string[]) {
    this.conversation(n, c);
    if (this.noteContext(n, c))
      throw new Error(
        "This conversation is pinned to its saved note. Start a new conversation to choose other sources.",
      );
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
  beginImport(
    n: string,
    title: string,
    key: string,
    descriptor: ImportDescriptor = { kind: "unknown" },
    retryOf?: string,
  ) {
    this.notebook(n);
    const existing = this.one("SELECT * FROM jobs WHERE idempotency=?", key);
    if (existing) {
      if (existing.notebook_id !== n)
        throw new Error("Idempotency key belongs to another notebook.");
      if (retryOf && existing.retry_of !== retryOf)
        throw new Error("Idempotency key belongs to another import attempt.");
      return existing;
    }
    return this.tx(() => {
      let attempt = 1;
      if (retryOf) {
        const previous = this.importJob(n, retryOf);
        if (previous.status !== "failed")
          throw new Error("Only failed imports can be retried.");
        if (this.one("SELECT id FROM jobs WHERE retry_of=?", retryOf))
          throw new Error(
            "This import already has a retry. Use the latest attempt.",
          );
        const type = descriptor.sourceId
          ? "refresh"
          : descriptor.derivedFrom
            ? "promotion"
            : "import";
        if (previous.type !== "unknown" && previous.type !== type)
          throw new Error("The retry must preserve the import operation.");
        if (
          ["refresh", "promotion"].includes(type) &&
          previous.input_metadata !== JSON.stringify(descriptor)
        )
          throw new Error(
            "The retry must preserve the source or note revision.",
          );
        attempt = previous.attempt_count + 1;
      }
      const job = id(),
        timestamp = now();
      this.run(
        "INSERT INTO jobs(id,notebook_id,title,status,idempotency,created,type,input_kind,input_metadata,attempt_count,retry_of,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        job,
        n,
        title,
        "processing",
        key,
        timestamp,
        descriptor.sourceId
          ? "refresh"
          : descriptor.derivedFrom
            ? "promotion"
            : "import",
        descriptor.kind,
        JSON.stringify(descriptor),
        attempt,
        retryOf ?? null,
        timestamp,
      );
      return this.importJob(n, job);
    });
  }
  importJob(n: string, job: string) {
    const record = this.one(
      "SELECT * FROM jobs WHERE id=? AND notebook_id=?",
      job,
      n,
    );
    if (!record) throw new Error("Import job not found.");
    return record;
  }
  startImport(n: string, job: string, descriptor: ImportDescriptor) {
    this.run(
      "UPDATE jobs SET started=COALESCE(started,?),updated=?,input_kind=CASE WHEN input_kind='unknown' THEN ? ELSE input_kind END,input_metadata=CASE WHEN input_kind='unknown' THEN ? ELSE input_metadata END,type=CASE WHEN input_kind='unknown' THEN ? ELSE type END WHERE id=? AND notebook_id=? AND status='processing'",
      now(),
      now(),
      descriptor.kind,
      JSON.stringify(descriptor),
      descriptor.sourceId
        ? "refresh"
        : descriptor.derivedFrom
          ? "promotion"
          : "import",
      job,
      n,
    );
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
    provenance?: {
      requestedUrl: string;
      retrievedAt: string;
      drive?: DriveProvenance;
    },
    offerDuplicate = false,
    derivedRevision?: string,
    selectInConversations = true,
  ) {
    this.notebook(n);
    if (
      sourceId &&
      this.one(
        "SELECT conversation_id FROM note_conversations WHERE notebook_id=? AND source_id=?",
        n,
        sourceId,
      )
    )
      throw new Error(
        "A saved note conversation snapshot cannot be refreshed.",
      );
    const importJob = this.one(
      "SELECT * FROM jobs WHERE id=? AND notebook_id=?",
      job,
      n,
    );
    if (!importJob) throw new Error("Import job not found.");
    if (importJob.status === "completed") return importJob.source_id;
    if (importJob.status !== "processing")
      throw new Error("Import job is no longer active.");
    if (
      derivedFrom &&
      !this.one(
        "SELECT id FROM artifacts WHERE id=? AND notebook_id=? AND unavailable=0 AND trashed_at IS NULL",
        derivedFrom,
        n,
      )
    )
      throw new Error(
        "Originating note not found or its evidence is unavailable.",
      );
    const parentRevision = derivedFrom
      ? this.one(
          "SELECT id FROM artifact_revisions WHERE artifact_id=?" +
            (derivedRevision ? " AND id=?" : " ORDER BY rowid DESC LIMIT 1"),
          ...[derivedFrom, ...(derivedRevision ? [derivedRevision] : [])],
        )
      : null;
    if ((derivedFrom && !parentRevision) || (!derivedFrom && derivedRevision))
      throw new Error("Originating note revision not found.");
    if (derivedFrom && parentRevision)
      this.sourceNoteRevision(n, derivedFrom, parentRevision.id);
    const hash = digest(bytes);
    const providerMetadata = provenance?.drive
      ? JSON.stringify(safeDriveProvenance(provenance.drive, hash))
      : null;
    const existing = this.one(
      "SELECT s.id,s.current_revision FROM sources s JOIN revisions r ON r.id=s.current_revision WHERE s.notebook_id=? AND s.removed=0 AND r.hash=? AND s.derived_from IS ? AND r.derived_revision IS ? AND s.kind=? AND r.origin IS ? AND r.requested_origin IS ? AND r.provider_metadata IS ?",
      n,
      hash,
      derivedFrom ?? null,
      parentRevision?.id ?? null,
      kind,
      origin,
      provenance?.requestedUrl ?? null,
      providerMetadata,
    );
    if (existing && (!sourceId || existing.id === sourceId)) {
      if (offerDuplicate && !sourceId) {
        this.run(
          "UPDATE jobs SET status='duplicate',source_id=?,duplicate_revision=? WHERE id=?",
          existing.id,
          existing.current_revision,
          job,
        );
        return existing.id;
      }
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
          "INSERT INTO revisions(id,source_id,hash,blob,sections,warnings,created,extractor,kind) VALUES(?,?,?,?,?,?,?,?,?)",
          r,
          s,
          hash,
          blob,
          JSON.stringify(extracted.sections),
          JSON.stringify(extracted.warnings),
          now(),
          EXTRACTION_VERSION,
          kind,
        );
        this.run(
          "UPDATE revisions SET normalized_hash=?,origin=?,requested_origin=?,retrieved_at=?,provider_metadata=? WHERE id=?",
          digest(JSON.stringify(extracted.sections)),
          origin,
          provenance?.requestedUrl ?? null,
          provenance?.retrievedAt ?? null,
          providerMetadata,
          r,
        );
        if (parentRevision)
          this.run(
            "UPDATE revisions SET derived_revision=? WHERE id=?",
            parentRevision.id,
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
        this.run(
          "UPDATE sources SET current_revision=?,origin=?,requested_origin=?,kind=? WHERE id=?",
          r,
          origin,
          provenance?.requestedUrl ?? null,
          kind,
          s,
        );
        if (!sourceId && selectInConversations)
          for (const c of this.all(
            "SELECT id,selected FROM conversations WHERE notebook_id=? AND id NOT IN (SELECT conversation_id FROM note_conversations WHERE notebook_id=?)",
            n,
            n,
          ))
            this.run(
              "UPDATE conversations SET selected=? WHERE id=?",
              JSON.stringify([...parse(c.selected), s]),
              c.id,
            );
        if (selectInConversations) this.invalidate(n);
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
  resolveDuplicate(n: string, jobId: string, action: "reuse" | "dismiss") {
    return this.tx(() => {
      const job = this.one(
        "SELECT * FROM jobs WHERE id=? AND notebook_id=?",
        jobId,
        n,
      );
      if (!job) throw new Error("Import job not found.");
      if (job.status === "completed" && action === "reuse") return job;
      if (job.status === "dismissed" && action === "dismiss") return job;
      if (job.status !== "duplicate")
        throw new Error("This import has no pending duplicate offer.");
      if (action === "dismiss") {
        this.run(
          "UPDATE jobs SET status='dismissed',source_id=NULL,duplicate_revision=NULL WHERE id=?",
          jobId,
        );
      } else {
        const source = this.one(
          "SELECT id,current_revision FROM sources WHERE id=? AND notebook_id=? AND removed=0",
          job.source_id,
          n,
        );
        if (!source || source.current_revision !== job.duplicate_revision) {
          this.run(
            "UPDATE jobs SET status='failed',error='The offered source changed or is unavailable. Import again to compare its current content.',source_id=NULL,duplicate_revision=NULL WHERE id=?",
            jobId,
          );
        } else {
          this.run(
            "UPDATE jobs SET status='completed',duplicate_revision=NULL WHERE id=?",
            jobId,
          );
        }
      }
      return this.one("SELECT * FROM jobs WHERE id=?", jobId);
    });
  }
  selectedPassages(n: string, c: string): Passage[] {
    const selection: string[] = parse(this.conversation(n, c).selected);
    return this.all(
      "SELECT p.*,s.derived_from,r.origin,r.requested_origin,r.retrieved_at,r.provider_metadata,r.hash,r.extractor,r.warnings FROM passages p JOIN sources s ON s.current_revision=p.revision_id JOIN revisions r ON r.id=p.revision_id WHERE s.notebook_id=? AND s.removed=0 ORDER BY s.created,p.rowid",
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
      requestedOrigin: p.requested_origin ?? null,
      retrievedAt: p.retrieved_at ?? null,
      drive: parse(p.provider_metadata),
      originalHash: p.hash,
      extractionVersion: p.extractor,
      warnings: parse(p.warnings) ?? [],
    };
  }
  passage(n: string, p: string) {
    const row = this.one(
      "SELECT p.*,s.derived_from,r.origin,r.requested_origin,r.retrieved_at,r.provider_metadata,r.hash,r.extractor,r.warnings FROM passages p JOIN sources s ON p.source_id=s.id JOIN revisions r ON r.id=p.revision_id WHERE p.id=? AND s.notebook_id=?",
      p,
      n,
    );
    if (!row) throw new Error("Evidence is unavailable.");
    return this.toPassage(row);
  }
  sourceOriginal(n: string, source: string, revision: string) {
    const row = this.one(
      "SELECT r.id,r.blob,r.hash FROM revisions r JOIN sources s ON s.id=r.source_id WHERE r.id=? AND s.id=? AND s.notebook_id=?",
      revision,
      source,
      n,
    );
    if (
      !row?.blob ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(row.id) ||
      row.blob !== row.id + ".bin"
    )
      throw new Error("Original snapshot is unavailable.");
    let bytes: Buffer;
    try {
      bytes = readFileSync(path.join(this.blobs, row.blob));
    } catch {
      throw new Error("Original snapshot is unavailable.");
    }
    if (digest(bytes) !== row.hash)
      throw new Error("Original snapshot failed its integrity check.");
    return bytes;
  }
  sourceDerivation(n: string, revision: string) {
    const source = this.one(
      "SELECT s.derived_from,r.derived_revision FROM revisions r JOIN sources s ON s.id=r.source_id WHERE r.id=? AND s.notebook_id=?",
      revision,
      n,
    );
    if (!source) throw new Error("Source revision not found.");
    if (!source.derived_from) return null;
    const note = this.one(
      "SELECT * FROM artifacts WHERE id=? AND notebook_id=?",
      source.derived_from,
      n,
    );
    if (!note) {
      if (
        !this.one(
          "SELECT id FROM deleted_notes WHERE id=? AND notebook_id=?",
          source.derived_from,
          n,
        )
      )
        throw new Error("Originating note not found.");
      return {
        artifactId: source.derived_from,
        revisionId: null,
        title: null,
        origin: "unknown",
        authored: null,
        created: null,
        runId: null,
        manifest: [],
        unavailable: true,
        deleted: true,
        content: null,
      };
    }
    const original =
      source.derived_revision &&
      this.one(
        "SELECT * FROM artifact_revisions WHERE id=? AND artifact_id=?",
        source.derived_revision,
        note.id,
      );
    const run =
      note.run_id &&
      this.one(
        "SELECT manifest FROM runs WHERE id=? AND notebook_id=?",
        note.run_id,
        n,
      );
    return {
      artifactId: note.id,
      revisionId: original?.id ?? null,
      title: original?.title ?? null,
      origin: note.run_id
        ? "generated"
        : original?.authored
          ? "user"
          : "unknown",
      authored: original ? Boolean(original.authored) : null,
      created: original?.created ?? null,
      runId: note.run_id,
      manifest: run ? parse(run.manifest) : [],
      unavailable: Boolean(note.unavailable),
      content: original && !note.unavailable ? parse(original.content) : null,
    };
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
    itemCount?: number,
  ) {
    this.noteContext(n, c);
    if (!key.trim() || !question.trim())
      throw new Error("Question and idempotency key are required.");
    if (kind !== "answer" && !isArtifactKind(kind))
      throw new Error("Unknown output kind.");
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
    if (itemCount !== undefined) studyCount(itemCount);
    const retry = retryOf
      ? this.one("SELECT kind,study_count FROM runs WHERE id=?", retryOf)
      : null;
    if (
      retry &&
      (isStudyKind(kind) ||
        isStudyKind(retry.kind) ||
        isStructuredKind(kind) ||
        isStructuredKind(retry.kind) ||
        kind === "infographic" ||
        retry.kind === "infographic" ||
        kind === "slides" ||
        retry.kind === "slides") &&
      retry.kind !== kind
    )
      throw new Error("A retry must preserve its output kind.");
    const count = isStudyKind(kind)
      ? studyCount(itemCount ?? retry?.study_count ?? 10)
      : null;
    if (!isStudyKind(kind) && itemCount !== undefined)
      throw new Error("Only study material has an item count.");
    if (retry?.study_count && count !== retry.study_count)
      throw new Error("A study retry must preserve its requested count.");
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
        "INSERT INTO runs(id,notebook_id,conversation_id,status,generation,context_key,manifest,question,kind,model,idempotency,created,schema_version,instruction_version,instruction_snapshot,grounding_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
        OUTPUT_CONTRACT_VERSION,
        nb.instruction_version,
        nb.instructions,
        "sources",
      );
      if (retryOf)
        this.run("UPDATE runs SET retry_of=? WHERE id=?", retryOf, run);
      if (count !== null)
        this.run("UPDATE runs SET study_count=? WHERE id=?", count, run);
      this.run(
        "UPDATE runs SET stats=? WHERE id=?",
        JSON.stringify(initialRunStats(manifest.length)),
        run,
      );
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
      validateAnswer(
        answer,
        this.selectedPassages(r.notebook_id, r.conversation_id),
        r.kind,
        r.study_count ?? undefined,
      );
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
        "INSERT INTO artifacts(id,notebook_id,title,kind,content,authored,run_id,unavailable,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
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
        "INSERT INTO artifact_revisions(id,artifact_id,content,authored,created,title) VALUES(?,?,?,?,?,?)",
        id(),
        a,
        content,
        Number(authored),
        now(),
        title,
      );
      return a;
    });
  }
  editArtifact(
    n: string,
    a: string,
    title: string,
    text: string,
    base?: string,
  ) {
    this.activeArtifact(n, a);
    if (
      !this.one("SELECT id FROM artifacts WHERE id=? AND notebook_id=?", a, n)
    )
      throw new Error("Note not found.");
    this.tx(() => {
      if (
        base !== undefined &&
        (!base ||
          this.one(
            "SELECT id FROM artifact_revisions WHERE artifact_id=? ORDER BY rowid DESC LIMIT 1",
            a,
          )?.id !== base)
      )
        throw new Error("Note changed. Reopen it before saving this edit.");
      const content = JSON.stringify({ text });
      this.run(
        "UPDATE artifacts SET title=?,content=?,authored=1,updated=? WHERE id=?",
        title,
        content,
        now(),
        a,
      );
      this.run(
        "INSERT INTO artifact_revisions(id,artifact_id,content,authored,created,title) VALUES(?,?,?,?,?,?)",
        id(),
        a,
        content,
        1,
        now(),
        title,
      );
    });
  }
  private resolveNotePassage(n: string, passage: string) {
    try {
      return this.passage(n, passage);
    } catch {
      return null;
    }
  }
  createRichArtifact(
    n: string,
    title: string,
    value: unknown,
    inherited: Citation[] = [],
  ) {
    const content = richNote(
      value,
      (id) => this.resolveNotePassage(n, id),
      inherited,
    );
    return this.saveArtifact(n, title, "note", JSON.stringify(content), true);
  }
  editRichArtifact(
    n: string,
    a: string,
    title: string,
    value: unknown,
    base: string,
    inherited: Citation[] = [],
  ) {
    return this.tx(() => {
      this.activeArtifact(n, a);
      const current = this.one(
        "SELECT a.*,r.id AS revision FROM artifacts a JOIN artifact_revisions r ON r.artifact_id=a.id WHERE a.id=? AND a.notebook_id=? ORDER BY r.rowid DESC LIMIT 1",
        a,
        n,
      );
      if (!current) throw new Error("Note not found.");
      if (!base || current.revision !== base)
        throw new Error("Note changed. Reopen it before saving this edit.");
      const content = JSON.stringify(
        richNote(value, (id) => this.resolveNotePassage(n, id), [
          ...noteCitations(parse(current.content)),
          ...inherited,
        ]),
      );
      // An unchanged rich note is idempotent and does not create a revision.
      if (
        current.authored &&
        current.title === title &&
        current.content === content
      )
        return current.revision;
      const revision = id(),
        time = now();
      this.run(
        "UPDATE artifacts SET title=?,content=?,authored=1,updated=? WHERE id=?",
        title,
        content,
        time,
        a,
      );
      this.run(
        "INSERT INTO artifact_revisions(id,artifact_id,content,authored,created,title) VALUES(?,?,?,?,?,?)",
        revision,
        a,
        content,
        1,
        time,
        title,
      );
      return revision;
    });
  }
  artifactHistory(n: string, a: string, offset = 0, limit = 20) {
    if (
      !this.one("SELECT id FROM artifacts WHERE id=? AND notebook_id=?", a, n)
    )
      throw new Error("Note not found.");
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 1000000 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw new Error("Invalid revision page.");
    const rows = this.all(
      "SELECT r.id,r.title,r.created,r.authored,CASE WHEN r.authored=0 AND a.unavailable=1 THEN 0 ELSE 1 END AS available FROM artifact_revisions r JOIN artifacts a ON a.id=r.artifact_id WHERE a.id=? AND a.notebook_id=? ORDER BY r.rowid DESC LIMIT ? OFFSET ?",
      a,
      n,
      limit + 1,
      offset,
    );
    return {
      results: rows.slice(0, limit),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  }
  artifactRevision(n: string, a: string, revision: string) {
    const row = this.one(
      "SELECT a.id,a.kind,a.run_id,a.unavailable,a.trashed_at,a.trash_version,a.title AS current_title,r.title,r.created,r.authored,r.id AS revision_id,r.content FROM artifact_revisions r JOIN artifacts a ON a.id=r.artifact_id WHERE a.id=? AND a.notebook_id=? AND r.id=?",
      a,
      n,
      revision,
    );
    if (!row) throw new Error("Note revision not found.");
    const content = parse(row.content);
    return {
      ...row,
      title: row.title ?? row.current_title,
      titleRecorded: row.title !== null,
      available: !(row.unavailable && !row.authored),
      content,
      referenceAvailability: Object.fromEntries(
        noteCitations(content).map((c) => [
          c.passageId,
          Boolean(this.resolveNotePassage(n, c.passageId)),
        ]),
      ),
    };
  }
  restoreArtifact(n: string, a: string, revision: string, base: string) {
    return this.tx(() => {
      this.activeArtifact(n, a);
      const historical = this.artifactRevision(n, a, revision);
      if (!historical.available)
        throw new Error(
          "This generated revision is unavailable after evidence purge.",
        );
      const content = editableNote(historical.content);
      // Retain only truly inherited missing references from this scoped historical revision.
      const checked = richNote(
        content,
        (id) => this.resolveNotePassage(n, id),
        noteCitations(historical.content),
      );
      const current = this.one(
        "SELECT r.id FROM artifact_revisions r JOIN artifacts a ON a.id=r.artifact_id WHERE a.id=? AND a.notebook_id=? ORDER BY r.rowid DESC LIMIT 1",
        a,
        n,
      );
      if (!current || current.id !== base)
        throw new Error("Note changed. Reopen it before restoring.");
      const next = id(),
        time = now(),
        serialized = JSON.stringify(checked);
      this.run(
        "UPDATE artifacts SET title=?,content=?,authored=1,updated=? WHERE id=?",
        historical.title,
        serialized,
        time,
        a,
      );
      this.run(
        "INSERT INTO artifact_revisions(id,artifact_id,content,authored,created,title) VALUES(?,?,?,?,?,?)",
        next,
        a,
        serialized,
        1,
        time,
        historical.title,
      );
      return next;
    });
  }
  quizRevision(n: string, a: string, revision: string): Answer {
    this.activeArtifact(n, a);
    const row = this.one(
      "SELECT r.content,r.authored,a.unavailable,a.run_id FROM artifact_revisions r JOIN artifacts a ON a.id=r.artifact_id JOIN runs q ON q.id=a.run_id AND q.notebook_id=a.notebook_id WHERE r.id=? AND a.id=? AND a.notebook_id=? AND q.kind='quiz' AND q.status='completed' AND q.output=r.content",
      revision,
      a,
      n,
    );
    if (!row || row.authored || row.unavailable || !row.run_id)
      throw new Error("Generated quiz revision is unavailable.");
    const content: Answer = parse(row.content);
    if (
      content.kind !== "quiz" ||
      content.status !== "answered" ||
      !content.items?.length
    )
      throw new Error("This revision has no playable quiz.");
    const count = this.one(
      "SELECT study_count FROM runs WHERE id=?",
      row.run_id,
    )?.study_count;
    validateStudy(content, count ?? content.items.length);
    return content;
  }
  startQuizAttempt(n: string, a: string, revision: string, key: string) {
    if (!key.trim())
      throw new Error("Quiz attempt idempotency key is required.");
    const content = this.quizRevision(n, a, revision);
    const existing = this.one(
      "SELECT * FROM quiz_attempts WHERE idempotency=?",
      key,
    );
    if (existing) {
      if (
        existing.notebook_id !== n ||
        existing.artifact_id !== a ||
        existing.revision_id !== revision
      )
        throw new Error("Quiz attempt key belongs to another revision.");
      return { ...existing, answers: parse(existing.answers) };
    }
    const attempt = id(),
      time = now();
    this.run(
      "INSERT INTO quiz_attempts(id,notebook_id,artifact_id,revision_id,total,idempotency,created,updated) VALUES(?,?,?,?,?,?,?,?)",
      attempt,
      n,
      a,
      revision,
      content.items!.length,
      key,
      time,
      time,
    );
    return {
      ...this.one("SELECT * FROM quiz_attempts WHERE id=?", attempt),
      answers: {},
    };
  }
  saveQuizAnswers(
    n: string,
    a: string,
    attempt: string,
    answers: unknown,
    submit = false,
  ) {
    return this.tx(() => {
      const row = this.one(
        "SELECT * FROM quiz_attempts WHERE id=? AND notebook_id=? AND artifact_id=?",
        attempt,
        n,
        a,
      );
      if (!row) throw new Error("Quiz attempt not found.");
      const content = this.quizRevision(n, a, row.revision_id);
      if (!answers || typeof answers !== "object" || Array.isArray(answers))
        throw new Error("Invalid quiz answers.");
      const entries = Object.entries(answers);
      const items = new Map(content.items!.map((item) => [item.id, item]));
      if (
        entries.length > items.size ||
        entries.some(
          ([key, value]) =>
            !items.get(key)?.options?.some((option) => option.id === value),
        )
      )
        throw new Error("Quiz answers reference an unknown item or option.");
      const canonical = JSON.stringify(
        Object.fromEntries(
          content
            .items!.filter((item) => Object.hasOwn(answers, item.id))
            .map((item) => [
              item.id,
              (answers as Record<string, string>)[item.id],
            ]),
        ),
      );
      if (row.submitted) {
        if (!submit || canonical !== row.answers)
          throw new Error(
            "Submitted quiz attempts cannot change. Start a new attempt.",
          );
        return { ...row, answers: parse(row.answers) };
      }
      if (submit && entries.length !== items.size)
        throw new Error("Answer every quiz question before submitting.");
      const score = submit
        ? entries.filter(
            ([key, value]) => items.get(key)!.correctOptionId === value,
          ).length
        : null;
      const time = now();
      this.run(
        "UPDATE quiz_attempts SET answers=?,submitted=?,score=?,updated=? WHERE id=?",
        canonical,
        submit ? time : null,
        score,
        time,
        attempt,
      );
      return {
        ...this.one("SELECT * FROM quiz_attempts WHERE id=?", attempt),
        answers: parse(canonical),
      };
    });
  }
  activeArtifact(n: string, a: string) {
    const note = this.one(
      "SELECT * FROM artifacts WHERE notebook_id=? AND id=?",
      n,
      a,
    );
    if (!note) throw Error("Note not found.");
    if (note.trashed_at)
      throw Error("This note is in Trash. Restore it before using it.");
    return note;
  }
  private trashVersion(version: number) {
    if (!Number.isSafeInteger(version) || version < 0)
      throw Error("Invalid Trash version.");
  }
  trashedArtifact(n: string, a: string, version: number) {
    this.trashVersion(version);
    const note = this.one(
      "SELECT * FROM artifacts WHERE notebook_id=? AND id=?",
      n,
      a,
    );
    if (!note) throw Error("Note not found.");
    if (!note.trashed_at || note.trash_version !== version)
      throw Error(
        "Trash changed. Reopen Trash before restoring or deleting this note.",
      );
    return note;
  }
  trash(n: string) {
    this.notebook(n);
    return this.all(
      `SELECT a.id,a.title,a.kind,a.trashed_at,a.trash_version,
      (SELECT id FROM artifact_revisions WHERE artifact_id=a.id ORDER BY rowid DESC LIMIT 1) AS revision_id,
      (SELECT count(*) FROM artifact_revisions WHERE artifact_id=a.id) AS revision_count,
      (SELECT count(*) FROM note_drafts WHERE artifact_id=a.id AND closed=0) AS draft_count,
      (SELECT count(*) FROM sources WHERE notebook_id=a.notebook_id AND derived_from=a.id) AS snapshot_count,
      (SELECT count(*) FROM note_conversations nc JOIN artifact_revisions r ON r.id=nc.note_revision WHERE r.artifact_id=a.id) AS conversation_count
      FROM artifacts a WHERE notebook_id=? AND trashed_at IS NOT NULL ORDER BY trashed_at DESC,a.id`,
      n,
    );
  }
  trashArtifact(n: string, a: string, base: string, version: number) {
    this.trashVersion(version);
    return this.tx(() => {
      const note = this.activeArtifact(n, a);
      if (
        note.trash_version !== version ||
        this.artifactHistory(n, a, 0, 1).results[0]?.id !== base
      )
        throw Error("Note changed. Reopen it before moving it to Trash.");
      this.run(
        "UPDATE artifacts SET trashed_at=?,trash_version=trash_version+1 WHERE id=?",
        now(),
        a,
      );
      // Prevent delayed promotion publication or duplicate acceptance after Trash.
      this.run(
        "UPDATE jobs SET status='failed',error='Originating note moved to Trash. Restore it before retrying.' WHERE notebook_id=? AND json_extract(input_metadata,'$.derivedFrom')=? AND status IN ('processing','duplicate')",
        n,
        a,
      );
      return this.trash(n).find((note) => note.id === a)!;
    });
  }
  restoreTrashedArtifact(n: string, a: string, version: number) {
    return this.tx(() => {
      this.trashedArtifact(n, a, version);
      this.run(
        "UPDATE artifacts SET trashed_at=NULL,trash_version=trash_version+1 WHERE id=?",
        a,
      );
      return { restored: true };
    });
  }
  deleteArtifact(n: string, a: string, version: number) {
    this.notebook(n);
    this.trashVersion(version);
    // Content-free receipts make retry after a lost response safe.
    if (
      this.one(
        "SELECT id FROM deleted_notes WHERE notebook_id=? AND id=? AND trash_version=?",
        n,
        a,
        version,
      )
    )
      return;
    this.trashedArtifact(n, a, version);
    this.invalidate(n);
    const snapshots = this.all(
      "SELECT id FROM sources WHERE notebook_id=? AND derived_from=?",
      n,
      a,
    );
    for (const snapshot of snapshots) this.purgeSource(n, snapshot.id);
    this.speech.invalidate(n, a);
    this.speech.cleanup(n);
    // Purge is restartable: retain the trashed note until filesystem cleanup succeeds.
    this.tx(() => {
      this.trashedArtifact(n, a, version);
      this.run(
        "DELETE FROM conversations WHERE id IN (SELECT nc.conversation_id FROM note_conversations nc JOIN artifact_revisions r ON r.id=nc.note_revision WHERE nc.notebook_id=? AND r.artifact_id=?)",
        n,
        a,
      );
      this.run(
        "DELETE FROM jobs WHERE notebook_id=? AND json_extract(input_metadata,'$.derivedFrom')=?",
        n,
        a,
      );
      this.run(
        "UPDATE revisions SET derived_revision=NULL WHERE derived_revision IN (SELECT id FROM artifact_revisions WHERE artifact_id=?)",
        a,
      );
      this.run("INSERT INTO deleted_notes VALUES(?,?,?)", a, n, version);
      this.run("DELETE FROM artifacts WHERE notebook_id=? AND id=?", n, a);
    });
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  view(n: string) {
    const nb = this.notebook(n);
    return {
      ...nb,
      drafts: this.drafts.list(n),
      trashCount: this.one(
        "SELECT count(*) AS count FROM artifacts WHERE notebook_id=? AND trashed_at IS NOT NULL",
        n,
      ).count,
      sources: this.all(
        "SELECT s.*,r.warnings,r.hash,r.provider_metadata,CASE WHEN a.run_id IS NOT NULL THEN 'generated' WHEN a.authored=1 THEN 'user' ELSE 'unknown' END AS derived_origin FROM sources s LEFT JOIN revisions r ON r.id=s.current_revision LEFT JOIN artifacts a ON a.id=s.derived_from AND a.notebook_id=s.notebook_id WHERE s.notebook_id=? ORDER BY s.created",
        n,
      ).map(({ provider_metadata, ...s }) => ({
        ...s,
        warnings: parse(s.warnings),
        drive: parse(provider_metadata),
      })),
      conversations: this.all(
        "SELECT c.*,nc.note_revision,nc.source_id AS note_source FROM conversations c LEFT JOIN note_conversations nc ON nc.conversation_id=c.id WHERE c.notebook_id=? ORDER BY c.created",
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
        failureDraft: parse(r.failure_draft),
        output: parse(r.output),
        manifest: parse(r.manifest),
        stats: parse(r.stats),
      })),
      artifacts: this.all(
        "SELECT a.*,(SELECT id FROM artifact_revisions WHERE artifact_id=a.id ORDER BY rowid DESC LIMIT 1) AS revision_id FROM artifacts a WHERE notebook_id=? AND trashed_at IS NULL ORDER BY updated DESC",
        n,
      ).map((a) => {
        const content = parse(a.content);
        const referenceAvailability = isRichNote(content)
          ? Object.fromEntries(
              noteCitations(content).map((c) => [
                c.passageId,
                Boolean(this.resolveNotePassage(n, c.passageId)),
              ]),
            )
          : {};
        return {
          ...a,
          content,
          referenceAvailability,
          referencesUnavailable: Object.values(referenceAvailability).some(
            (available) => !available,
          ),
        };
      }),
      quizAttempts: this.all(
        "SELECT q.* FROM quiz_attempts q JOIN artifacts a ON a.id=q.artifact_id WHERE q.notebook_id=? AND a.trashed_at IS NULL ORDER BY q.created,q.rowid",
        n,
      ).map((a) => ({ ...a, answers: parse(a.answers) })),
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
      revisionIds = new Set(revisions.map((r) => r.id)),
      passageIds = new Set(
        this.all("SELECT id FROM passages WHERE source_id=?", s).map(
          (p) => p.id,
        ),
      );
    const affected = this.all(
      "SELECT * FROM runs WHERE notebook_id=?",
      n,
    ).filter((r) => parse(r.manifest).some((v: string) => revisionIds.has(v)));
    // Authored notes need not originate from a run. Follow the revision that
    // actually supplied each snapshot, even when the note has since been edited.
    // Also recover snapshots left behind by an earlier, interrupted purge.
    const derived: string[] = this.all(
      "SELECT s.id,a.content FROM sources s JOIN revisions r ON r.source_id=s.id JOIN artifact_revisions a ON a.id=r.derived_revision WHERE s.notebook_id=?",
      n,
    )
      .filter((snapshot) =>
        noteCitations(parse(snapshot.content)).some(
          (c) =>
            passageIds.has(c.passageId) ||
            !this.resolveNotePassage(n, c.passageId),
        ),
      )
      .map((snapshot) => snapshot.id);
    this.tx(() => {
      const unavailable = JSON.stringify({
        text: "Evidence was purged. This generated output is unavailable.",
      });
      for (const r of affected) {
        this.run(
          "UPDATE runs SET output=NULL,failure_draft=NULL WHERE id=?",
          r.id,
        );
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
          this.speech.invalidate(n, a.id);
          derived.push(
            ...this.all(
              "SELECT id FROM sources WHERE derived_from=? AND notebook_id=?",
              a.id,
              n,
            ).map((s) => s.id),
          );
          this.run("DELETE FROM quiz_attempts WHERE artifact_id=?", a.id);
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
    this.speech.cleanup(n);
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
    for (const a of this.all("SELECT id FROM artifacts WHERE notebook_id=?", n))
      this.speech.invalidate(n, a.id);
    this.speech.cleanup(n);
    this.run("DELETE FROM notebooks WHERE id=?", n);
  }
  close() {
    this.db.close();
  }
}
