import type { Store } from "./store.ts";
import { noteCitations, richNote } from "../domain/notes.ts";
import { digest } from "../domain/evidence.ts";
import type {
  DraftReference,
  NoteDraft,
  NoteDraftSummary,
} from "../domain/note-drafts.ts";

export class NoteDraftStore {
  constructor(private store: Store) {}

  saveOnce(
    n: string,
    key: unknown,
    request: unknown,
    save: () => string,
  ): string {
    // Older API clients may omit an operation ID.
    if (key === undefined) return save();
    if (typeof key !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(key))
      throw Error("Invalid note save ID.");
    const hash = digest(JSON.stringify(request));
    return this.store.tx(() => {
      this.store.notebook(n);
      const previous = this.store.one(
        "SELECT * FROM note_saves WHERE id=?",
        key,
      );
      if (previous) {
        if (previous.notebook_id !== n || previous.request_hash !== hash)
          throw Error("Save ID belongs to another note save.");
        if (!previous.artifact_id)
          throw Error("The saved note was permanently deleted.");
        this.store.activeArtifact(n, previous.artifact_id);
        return previous.artifact_id;
      }
      const artifact = save();
      this.store.activeArtifact(n, artifact);
      this.store.run(
        "INSERT INTO note_saves(id,notebook_id,request_hash,artifact_id) VALUES(?,?,?,?)",
        key,
        n,
        hash,
        artifact,
      );
      return artifact;
    });
  }

  private reference(value: any): DraftReference {
    if (
      !value ||
      typeof value.id !== "string" ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(value.id) ||
      !Number.isSafeInteger(value.version) ||
      value.version < 1
    )
      throw Error("Invalid draft reference.");
    return value;
  }
  list(n: string, artifactId?: string | null): NoteDraftSummary[] {
    this.store.notebook(n);
    return this.store.all(
      "SELECT id,version,artifact_id AS artifactId,base_revision_id AS baseRevisionId,title,updated FROM note_drafts WHERE notebook_id=? AND closed=0 AND (artifact_id IS NULL OR artifact_id IN (SELECT id FROM artifacts WHERE trashed_at IS NULL))" +
        (artifactId === undefined ? "" : " AND artifact_id IS ?") +
        " ORDER BY updated DESC,id",
      n,
      ...(artifactId === undefined ? [] : [artifactId]),
    );
  }
  read(n: string, id: string): NoteDraft {
    const row = this.store.one(
      "SELECT * FROM note_drafts WHERE notebook_id=? AND id=? AND closed=0",
      n,
      id,
    );
    if (!row) throw Error("Draft not found.");
    if (row.artifact_id) this.store.activeArtifact(n, row.artifact_id);
    const document = JSON.parse(row.document);
    return {
      id: row.id,
      version: row.version,
      artifactId: row.artifact_id,
      baseRevisionId: row.base_revision_id,
      title: row.title,
      updated: row.updated,
      document,
      referenceAvailability: Object.fromEntries(
        noteCitations(document).map((c) => [
          c.passageId,
          !!this.passage(n, c.passageId),
        ]),
      ),
    };
  }
  private passage(n: string, id: string) {
    try {
      return this.store.passage(n, id);
    } catch {
      return null;
    }
  }
  save(n: string, id: string, input: any): DraftReference {
    this.reference({ id, version: input?.version });
    this.store.notebook(n);
    if (
      typeof input.title !== "string" ||
      Array.from(input.title).length > 200 ||
      input.title.includes("\0")
    )
      throw Error("Draft title must be at most 200 characters.");
    const artifactId = input.artifactId,
      base = input.baseRevisionId;
    if (
      !(artifactId === null && base === null) &&
      !(
        typeof artifactId === "string" &&
        typeof base === "string" &&
        artifactId.length <= 100 &&
        base.length <= 100
      )
    )
      throw Error("Invalid draft note revision.");
    const inherited =
      artifactId === null
        ? []
        : noteCitations(
            this.store.artifactRevision(n, artifactId, base).content,
          );
    if (artifactId !== null) this.store.activeArtifact(n, artifactId);
    return this.store.tx(() => {
      const row = this.store.one("SELECT * FROM note_drafts WHERE id=?", id);
      if (
        row &&
        (row.notebook_id !== n ||
          row.artifact_id !== artifactId ||
          row.base_revision_id !== base)
      )
        throw Error("Draft belongs to another note.");
      if (row?.closed)
        throw Error("Draft closed. Keep a separate recovery copy.");
      // Drafts are authored work: preserve already attached missing references,
      // but never admit a fabricated or foreign reference as an inherited one.
      if (row) inherited.push(...noteCitations(JSON.parse(row.document)));
      const document = JSON.stringify(
        richNote(input.document, (id) => this.passage(n, id), inherited),
      );
      if (
        row?.version === input.version &&
        row.title === input.title &&
        row.document === document
      )
        return { id, version: row.version }; // A lost response can be retried.
      if ((row?.version ?? 0) !== input.version - 1)
        throw Error("Draft changed. Keep a separate recovery copy.");
      if (
        !row &&
        this.store.one(
          "SELECT count(*) AS count FROM note_drafts WHERE notebook_id=? AND closed=0",
          n,
        ).count >= 50
      )
        throw Error(
          "This notebook has 50 recoverable drafts. Recover or discard a draft before adding another.",
        );
      this.store.run(
        "INSERT INTO note_drafts(id,notebook_id,artifact_id,base_revision_id,version,title,document,updated) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,title=excluded.title,document=excluded.document,updated=excluded.updated",
        id,
        n,
        artifactId,
        base,
        input.version,
        input.title,
        document,
        new Date().toISOString(),
      );
      return { id, version: input.version };
    });
  }
  discard(n: string, value: unknown) {
    const ref = this.reference(value);
    const row = this.store.one(
      "SELECT * FROM note_drafts WHERE notebook_id=? AND id=?",
      n,
      ref.id,
    );
    if (!row) throw Error("Draft not found.");
    if (row.closed) return;
    if (row.version !== ref.version)
      throw Error("Draft changed. Reopen it before discarding.");
    // A content-free tombstone rejects delayed writes after discard or Save.
    this.store.run(
      "UPDATE note_drafts SET closed=1,title='',document=NULL WHERE id=?",
      ref.id,
    );
  }
  publish<T>(
    n: string,
    value: unknown,
    artifactId: string | null,
    base: string | null,
    save: (draft?: NoteDraft) => T,
  ): T {
    if (value === undefined) return save();
    const ref = this.reference(value);
    return this.store.tx(() => {
      const draft = this.read(n, ref.id);
      if (
        draft.version !== ref.version ||
        draft.artifactId !== artifactId ||
        draft.baseRevisionId !== base
      )
        throw Error("Draft changed. Recover the latest draft before saving.");
      const result = save(draft);
      this.discard(n, ref);
      return result;
    });
  }
}
