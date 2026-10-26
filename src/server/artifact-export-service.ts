import type { Store } from "../storage/store.ts";
import type { Answer } from "../domain/evidence.ts";
import type { ExportResolver } from "../domain/export.ts";
import type { ExportRevision } from "../domain/export-html.ts";

type Assemble<Options extends unknown[]> = (
  title: string,
  content: Answer,
  resolve: ExportResolver,
  revision: ExportRevision,
  ...options: Options
) => Promise<Buffer>;

/** Each service holds its own capacity until assembly settles, even after cancellation. */
export class ArtifactExportService<Options extends unknown[]> {
  private readonly pending = new Set<Promise<void>>();
  private stopping = false;

  constructor(
    private readonly store: Store,
    private readonly assemble: Assemble<Options>,
    private readonly errors: {
      stopping: string;
      cancelled: string;
      capacity: string;
      unavailable: string;
    },
  ) {}

  export(
    notebookId: string,
    artifactId: string,
    revisionId: string | undefined,
    signal: AbortSignal | undefined,
    ...options: Options
  ): Promise<Buffer> {
    if (this.stopping) return Promise.reject(Error(this.errors.stopping));
    if (signal?.aborted) return Promise.reject(Error(this.errors.cancelled));
    if (this.pending.size >= 2)
      return Promise.reject(Error(this.errors.capacity));
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.pending.add(settled);
    return this.execute(
      notebookId,
      artifactId,
      revisionId,
      signal,
      options,
    ).finally(() => {
      this.pending.delete(settled);
      finish();
    });
  }

  private async execute(
    notebookId: string,
    artifactId: string,
    revisionId: string | undefined,
    signal: AbortSignal | undefined,
    options: Options,
  ): Promise<Buffer> {
    this.store.activeArtifact(notebookId, artifactId);
    const current = this.store.artifactHistory(notebookId, artifactId, 0, 1)
      .results[0];
    if (!current) throw Error("Saved note revision not found.");
    const snapshot = this.store.artifactRevision(
      notebookId,
      artifactId,
      revisionId ?? current.id,
    );
    const bytes = await this.assemble(
      snapshot.title,
      snapshot.content,
      (id) => {
        try {
          const passage = this.store.passage(notebookId, id);
          return {
            ...passage,
            derivation: this.store.sourceDerivation(
              notebookId,
              passage.revisionId,
            ),
          };
        } catch {
          return null;
        }
      },
      {
        revisionId: snapshot.revision_id,
        created: snapshot.created,
        authored: Boolean(snapshot.authored),
        historical: snapshot.revision_id !== current.id,
        available: snapshot.available,
      },
      ...options,
    );
    if (this.stopping || signal?.aborted) throw Error(this.errors.cancelled);
    const after = this.store.artifactRevision(
      notebookId,
      artifactId,
      snapshot.revision_id,
    );
    if (!after.available) throw Error(this.errors.unavailable);
    this.store.activeArtifact(notebookId, artifactId);
    return bytes;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.pending]);
  }
}
