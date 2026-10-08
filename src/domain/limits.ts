function setting(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(
      name + " must be an integer between " + min + " and " + max + ".",
    );
  return value;
}
export const limits = {
  sources: setting("CODEBOOM_MAX_SOURCES", 50, 1, 50),
  evidenceCalls: setting("CODEBOOM_EVIDENCE_CALLS", 20, 1, 100),
  evidenceCharacters: setting(
    "CODEBOOM_EVIDENCE_CHARACTERS",
    200000,
    1600,
    500000,
  ),
  chatMs: setting("CODEBOOM_CHAT_TIMEOUT_MS", 120000, 1000, 300000),
  artifactMs: setting("CODEBOOM_ARTIFACT_TIMEOUT_MS", 300000, 1000, 600000),
};
