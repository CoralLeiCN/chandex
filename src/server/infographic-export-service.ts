import type { Store } from "../storage/store.ts";
import {
  exportInfographic,
  type InfographicFormat,
} from "../domain/export-infographic.ts";
import { ArtifactExportService } from "./artifact-export-service.ts";

export class InfographicExportService {
  private readonly service: ArtifactExportService<[InfographicFormat]>;

  constructor(store: Store, assemble = exportInfographic) {
    this.service = new ArtifactExportService(store, assemble, {
      stopping: "Infographic export was cancelled.",
      cancelled: "Infographic export was cancelled.",
      capacity: "Image export capacity is full. Try again shortly.",
      unavailable: "Infographic evidence became unavailable during export.",
    });
  }

  export(
    notebookId: string,
    artifactId: string,
    revisionId: string | undefined,
    format: InfographicFormat,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    return this.service.export(
      notebookId,
      artifactId,
      revisionId,
      signal,
      format,
    );
  }

  shutdown(): Promise<void> {
    return this.service.shutdown();
  }
}
