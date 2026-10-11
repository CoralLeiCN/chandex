import { reportedUsage } from "./run-stats.ts";

export interface ContextBudgetSnapshot {
  modelContextWindow: number | null;
  reportedContextTokens: number | null;
  chargedBytes: number;
  reservedTokens: number | null;
  capacityRefusals: number;
}

// This is a conservative admission tally, not provider-reported token usage.
// UTF-8 bytes bound nonempty byte-token pieces; count full serialized text and
// extra framing, retain all charged bytes, and reserve 20% for generation.
// Reports can already include earlier charged content. Double counting it is
// intentional: a late notification must never free unreported evidence space.
export class ContextBudget {
  private window: number | null = null;
  private reported: number | null = null;
  private bytes = 0;
  private refused = 0;
  reached = false;
  get ready() {
    return this.window !== null && this.reported !== null;
  }
  observe(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    const window = record.modelContextWindow;
    const last = reportedUsage(record.last);
    if (!Number.isSafeInteger(window) || Number(window) <= 0 || !last) return;
    this.window = Math.min(this.window ?? Number(window), Number(window));
    this.reported = Math.max(this.reported ?? 0, last.totalTokens);
    if (!this.fits(0)) this.reached = true;
  }
  private size(text: string) {
    return Buffer.byteLength(text, "utf8") + 256;
  }
  private fits(bytes: number) {
    return (
      this.ready &&
      this.reported! + this.bytes + bytes + Math.ceil(this.window! * 0.2) <=
        this.window!
    );
  }
  accountProtocol(text: string) {
    this.bytes += this.size(text);
    if (this.ready && !this.fits(0)) this.reached = true;
  }
  admitInput(text: string) {
    const bytes = this.size(text);
    if (this.ready && !this.fits(bytes)) {
      this.reached = true;
      throw new Error(
        "The selected-model context budget cannot fit this request.",
      );
    }
    this.bytes += bytes;
  }
  admitEvidence(serialized: string) {
    if (!this.ready) {
      this.refused++;
      throw new Error(
        "Model context capacity is not reported yet. No evidence was sent. Retry this notebook tool request after the runtime usage update.",
      );
    }
    const bytes = this.size(serialized);
    if (!this.fits(bytes)) {
      this.reached = true;
      throw new Error(
        "This evidence response exceeds the selected-model context budget. Request smaller evidence or report the omitted coverage.",
      );
    }
    this.bytes += bytes;
  }
  snapshot(): ContextBudgetSnapshot {
    return {
      modelContextWindow: this.window,
      reportedContextTokens: this.reported,
      chargedBytes: this.bytes,
      reservedTokens:
        this.window === null ? null : Math.ceil(this.window * 0.2),
      capacityRefusals: this.refused,
    };
  }
}
