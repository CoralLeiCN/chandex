import type { Store } from "../storage/store.ts";
import {
  exportInfographic,
  type InfographicFormat,
} from "../domain/export-infographic.ts";

export class InfographicExportService {
  private readonly pending = new Set<Promise<void>>();
  private stopping = false;
  constructor(
    private readonly store: Store,
    private readonly assemble = exportInfographic,
  ) {}
  export(
    notebookId: string,
    artifactId: string,
    revisionId: string | undefined,
    format: InfographicFormat,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (this.stopping || signal?.aborted)
      return Promise.reject(Error("Infographic export was cancelled."));
    if (this.pending.size >= 2)
      return Promise.reject(
        Error("Image export capacity is full. Try again shortly."),
      );
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.pending.add(settled);
    return this.execute(
      notebookId,
      artifactId,
      revisionId,
      format,
      signal,
    ).finally(() => {
      this.pending.delete(settled);
      finish();
    });
  }
  private async execute(
    n: string,
    id: string,
    revisionId: string | undefined,
    format: InfographicFormat,
    signal?: AbortSignal,
  ) {
    this.store.activeArtifact(n, id);
    const current = this.store.artifactHistory(n, id, 0, 1).results[0];
    if (!current) throw Error("Saved note revision not found.");
    const snapshot = this.store.artifactRevision(
      n,
      id,
      revisionId ?? current.id,
    );
    const bytes = await this.assemble(
      snapshot.title,
      snapshot.content,
      (passageId) => {
        try {
          const p = this.store.passage(n, passageId);
          return {
            ...p,
            derivation: this.store.sourceDerivation(n, p.revisionId),
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
      format,
    );
    if (this.stopping || signal?.aborted)
      throw Error("Infographic export was cancelled.");
    if (!this.store.artifactRevision(n, id, snapshot.revision_id).available)
      throw Error("Infographic evidence became unavailable during export.");
    this.store.activeArtifact(n, id);
    return bytes;
  }
  async shutdown() {
    this.stopping = true;
    await Promise.allSettled([...this.pending]);
  }
}
