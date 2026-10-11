import type { CodexErrorInfo } from "./protocol/v2/CodexErrorInfo.ts";
export type FailureCategory =
  | "authentication"
  | "rate_limit"
  | "invalid_output"
  | "timeout"
  | "interrupted"
  | "runtime";
export interface UnverifiedDraft {
  text: string;
  truncated: boolean;
}
export function unverifiedDraft(raw: string): UnverifiedDraft {
  let text = raw;
  try {
    const value = JSON.parse(raw);
    const parts = [typeof value?.title === "string" ? value.title : ""];
    if (Array.isArray(value?.blocks))
      parts.push(
        ...value.blocks.map((block: any) =>
          typeof block?.text === "string" ? block.text : "",
        ),
      );
    if (parts.some((part) => part.trim()))
      text = parts.filter(Boolean).join("\n\n");
  } catch {
    /* Malformed model output is still inspectable as plain text. */
  }
  const characters = Array.from(text);
  return {
    text: characters.slice(0, 200000).join(""),
    truncated: characters.length > 200000,
  };
}
export class GenerationError extends Error {
  constructor(
    readonly category: FailureCategory,
    message: string,
    options?: ErrorOptions,
    readonly draft?: UnverifiedDraft,
  ) {
    super(message, options);
    this.name = "GenerationError";
  }
}
export function runtimeFailure(message: string, info?: CodexErrorInfo | null) {
  let status: unknown;
  if (info && typeof info === "object")
    for (const value of Object.values(info))
      if (value && typeof value === "object" && "httpStatusCode" in value)
        status = value.httpStatusCode;
  if (info === "unauthorized" || status === 401 || status === 403)
    return new GenerationError(
      "authentication",
      "Codex authentication expired or was rejected. Check your connection and sign in again.",
    );
  if (
    [
      "rateLimitExceeded",
      "usageLimitExceeded",
      "sessionBudgetExceeded",
    ].includes(String(info)) ||
    status === 429
  )
    return new GenerationError(
      "rate_limit",
      "The provider's rate or usage limit was reached. Wait for capacity before retrying.",
    );
  if (
    info &&
    typeof info === "object" &&
    [
      "httpConnectionFailed",
      "responseStreamConnectionFailed",
      "responseStreamDisconnected",
      "responseTooManyFailedAttempts",
    ].some((key) => key in info)
  )
    return new GenerationError(
      "interrupted",
      "The provider connection was lost. The remote outcome is unknown; retry only when you want a new attempt.",
    );
  // Provider messages may echo source text or credentials. Only structured
  // categories cross into routine persisted diagnostics; drafts have their
  // own explicit, unverified storage and display path.
  const category = generationFailure(new Error(message)).category;
  return new GenerationError(
    category,
    category === "authentication"
      ? "Codex authentication failed. Check your connection and sign in again."
      : category === "interrupted"
        ? "The runtime was interrupted. The remote outcome is unknown; retry only when you want a new attempt."
        : "The runtime could not complete the request. Retry to start a new attempt.",
  );
}
export function generationFailure(error: unknown): GenerationError {
  if (error instanceof GenerationError) return error;
  const message = error instanceof Error ? error.message : "Generation failed.";
  if (
    /Codex process exited|Invalid runtime protocol|Runtime message exceeded limit|Codex request timed out|Codex (?:is )?closed/.test(
      message,
    )
  )
    return new GenerationError("interrupted", message, { cause: error });
  if (
    /Sign in with the project Codex CLI|unauthorized|authentication.*(?:expired|failed)/i.test(
      message,
    )
  )
    return new GenerationError("authentication", message, { cause: error });
  return new GenerationError("runtime", message, { cause: error });
}
