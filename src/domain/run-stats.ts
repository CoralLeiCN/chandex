import type { TokenUsageBreakdown } from "../codex/protocol/v2/TokenUsageBreakdown.ts";
import type { ContextBudgetSnapshot } from "./context-budget.ts";

export type ReportedUsage = TokenUsageBreakdown;
export type BudgetCutoff =
  | "evidence_calls"
  | "evidence_characters"
  | "model_context"
  | "model_context_unknown"
  | "deadline";
export interface AdapterStats {
  toolCalls: number;
  evidenceCharacters: number;
  usage: ReportedUsage | null;
  budgetReached: BudgetCutoff[];
  context?: ContextBudgetSnapshot;
}
export interface RunStats {
  sourceCount: number;
  firstProgressMs: number | null;
  elapsedMs: number | null;
  toolCalls: number | null;
  evidenceCharacters: number | null;
  usage: ReportedUsage | null;
  budgetReached: BudgetCutoff[];
  context: ContextBudgetSnapshot | null;
}
const usageFields = [
  "totalTokens",
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const;
export function reportedUsage(value: unknown): ReportedUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    usageFields.some(
      (field) =>
        !Number.isSafeInteger(record[field]) || Number(record[field]) < 0,
    )
  )
    return null;
  return Object.fromEntries(
    usageFields.map((field) => [field, record[field]]),
  ) as ReportedUsage;
}
export function cumulativeUsage(
  previous: ReportedUsage | null,
  next: unknown,
): ReportedUsage | null {
  const usage = reportedUsage(next);
  if (
    !usage ||
    (previous && usageFields.some((field) => usage[field] < previous[field]))
  )
    return previous;
  return usage;
}
export function initialRunStats(sourceCount: number): RunStats {
  return {
    sourceCount,
    firstProgressMs: null,
    elapsedMs: null,
    toolCalls: null,
    evidenceCharacters: null,
    usage: null,
    budgetReached: [],
    context: null,
  };
}
