import type { Store } from "../storage/store.ts";
import { exportPptx } from "../domain/export-pptx.ts";
import { ArtifactExportService } from "./artifact-export-service.ts";

export class SlideExportService {
  private readonly service: ArtifactExportService<[]>;

  constructor(store: Store, assemble = exportPptx) {
    this.service = new ArtifactExportService(store, assemble, {
      stopping: "PowerPoint export is shutting down.",
      cancelled: "Slide export was cancelled.",
      capacity: "PowerPoint export capacity is full. Try again shortly.",
      unavailable: "Slide evidence became unavailable during export.",
    });
  }

  export(
    notebookId: string,
    artifactId: string,
    revisionId?: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    return this.service.export(notebookId, artifactId, revisionId, signal);
  }

  shutdown(): Promise<void> {
    return this.service.shutdown();
  }
}
