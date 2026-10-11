import path from "node:path";

// Reuse one browser origin across manual qualification sessions.
// Main notes and preview fixtures have separate data directories.
process.env.CODEBOOM_PORT ??= "44281";
process.env.CODEBOOM_DATA_DIR ??= path.resolve(".codeboom/preview");
await import("../src/server/main.ts");
