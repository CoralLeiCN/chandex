import type { Store } from "../storage/store.ts";
import { exportPptx } from "../domain/export-pptx.ts";

/** Ephemeral exports keep capacity until assembly settles, including after cancellation. */
export class SlideExportService {
  private readonly pending = new Set<Promise<void>>();
  private stopping = false;

  constructor(
    private readonly store: Store,
    private readonly assemble = exportPptx,
  ) {}

  export(
    notebookId: string,
    artifactId: string,
    revisionId?: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (this.stopping)
      return Promise.reject(Error("PowerPoint export is shutting down."));
    if (signal?.aborted)
      return Promise.reject(Error("Slide export was cancelled."));
    if (this.pending.size >= 2)
      return Promise.reject(
        Error("PowerPoint export capacity is full. Try again shortly."),
      );
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.pending.add(settled);
    return this.execute(notebookId, artifactId, revisionId, signal).finally(
      () => {
        this.pending.delete(settled);
        finish();
      },
    );
  }

  private async execute(
    notebookId: string,
    artifactId: string,
    revisionId?: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
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
    );
    if (this.stopping || signal?.aborted)
      throw Error("Slide export was cancelled.");
    const after = this.store.artifactRevision(
      notebookId,
      artifactId,
      snapshot.revision_id,
    );
    if (!after.available)
      throw Error("Slide evidence became unavailable during export.");
    return bytes;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.allSettled([...this.pending]);
  }
}
