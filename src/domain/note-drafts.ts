import type { RichNote } from "./notes.ts";

export interface DraftReference {
  id: string;
  version: number;
}
export interface NoteDraftSummary extends DraftReference {
  artifactId: string | null;
  baseRevisionId: string | null;
  title: string;
  updated: string;
}
export interface NoteDraft extends NoteDraftSummary {
  document: RichNote;
  referenceAvailability: Record<string, boolean>;
}
export interface DraftInput {
  artifactId: string | null;
  baseRevisionId: string | null;
  title: string;
  document: RichNote;
}
