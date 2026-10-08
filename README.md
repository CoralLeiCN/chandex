# Codeboom

A local, source-grounded research notebook powered by the Codex agent harness.

Import sources, ask questions with inspectable citations, and turn answers into notes, summaries, briefing documents, study guides, and FAQs.

**Status:** working macOS prototype. The application, storage, Codex integration, and automated checks are implemented. Human semantic review and broader release qualification remain open; see [verification evidence](docs/verification.md).

## Run locally

Tested on macOS 26.6.2, Apple silicon, Node **26.10.0**, and npm **12.1.0**.

```sh
npm ci
npx codex login
npm run build
npm start
```

Open **http://127.0.0.1:4317**. If the project Codex CLI already has a working supported sign-in, skip the login command. The project pins Codex **0.161.0**; it does not upgrade the global CLI or copy credential files. Use **Connection → Check connection** after signing in.

The runtime verifies its capabilities and permission profile before each run. It currently rejects other operating systems because their access boundaries have not been qualified.

For development, `npm run dev` builds the UI and watches the server. After a UI edit, run `npm run build` and reload the browser.

## What works

- Notebooks, conversations, notebook instructions, model selection, archive, and deletion.
- Text-based PDF, Markdown, UTF-8 TXT, pasted text, public HTML, and direct PDF URLs.
- Source selection, immutable revisions, URL refresh, source viewer, removal, and purge.
- Real Codex generation with bounded notebook tools, progress, stop, retry, and reconnect.
- Exact citation checks, one bounded repair attempt, highlighted evidence, and explicit evidence gaps.
- Manual notes, saved answers, authored edits, note-to-source promotion, four Studio outputs, and Markdown exports with citation footnotes.
- SQLite persistence, crash recovery, and verified backup/restore.

The current limits are 50 sources per notebook, 25 MiB per input, 500,000 extracted Unicode characters per source, and 1,000 PDF pages. PDFs containing any page without extractable text are rejected; OCR, DOCX, slides, spreadsheets, audio, YouTube, and Drive imports are not implemented.

## Data and model access

Product data is stored in ignored **`.codeboom/data/`** by default. Questions, notebook instructions, selected passages, and compatible conversation context are sent to the provider configured in Codex. This is local storage with remote inference. Provider usage and cost are not currently reported.

The service binds to `127.0.0.1`, validates Host and Origin, and uses a same-origin session cookie. Agent runs use ephemeral Codex threads, an empty working directory, a restricted read profile, and four scoped evidence tools. Shell, web search, apps, plugins, unrelated MCP tools, memory, host skill discovery, and agent network access are disabled or excluded. Authentication and inference still require the Codex client to reach its provider.

Removal retains historical evidence. Purge removes managed source content and affected generated copies, including promoted copies, while preserving user-authored notes. Exports, existing backups, and requests already sent to a provider remain outside this cleanup. Local deletion is logical application cleanup, not a promise of forensic erasure from storage hardware.

## Configuration

Set environment variables before starting the server. Keep secrets out of Git.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEBOOM_DATA_DIR` | `.codeboom/data` | Database, source blobs, and empty runtime workspace |
| `CODEBOOM_PORT` | `4317` | Loopback web port |
| `CODEBOOM_MAX_SOURCES` | `50` | Notebook source limit; 1–50 |
| `CODEBOOM_EVIDENCE_CALLS` | `20` | Per-run read tool call limit; 1–100 |
| `CODEBOOM_EVIDENCE_CHARACTERS` | `200000` | Total returned evidence characters; 1,600–500,000 |
| `CODEBOOM_CHAT_TIMEOUT_MS` | `120000` | Chat deadline including connection setup |
| `CODEBOOM_ARTIFACT_TIMEOUT_MS` | `300000` | Studio deadline including connection setup |

There is one active run per conversation and at most two across the service. Additional work is rejected with a retryable capacity message. Partial reading is shown as a coverage warning.

## Backup and restore

Stop Codeboom first. Choose new destination directories outside the data directory.

```sh
npm run data -- backup .codeboom/data /absolute/path/to/codeboom-backup
npm run data -- restore /absolute/path/to/codeboom-backup /absolute/path/to/restored-data
CODEBOOM_DATA_DIR=/absolute/path/to/restored-data npm start
```

Backups include a checkpointed database, referenced blobs, and a versioned hash manifest. Restore verifies the hashes and schema and never overwrites an existing destination. Protect backups as you would the source documents.

## Verify

```sh
npm run typecheck
npm test
npm run build
npm run isolation:check
npm run harness:check
npm run evaluate
```

The last two commands make real model requests using the configured Codex account. The evaluation has 40 fixed synthetic questions and two concurrent workers. Its outputs are written under ignored `.codeboom/`. The native isolation check runs on macOS and uses synthetic canaries. Regenerate pinned protocol bindings with `npm run codex:generate` after an intentional runtime upgrade, then repeat compatibility checks.

## Project documents

- [Intent](intent.md): purpose and principles.
- [Specification](docs/spec.md): product requirements and acceptance criteria.
- [Plan](plan.md): milestones and task status.
- [Technical decisions](docs/technical-decisions.md): architecture and dependency authority.
- [Verification](docs/verification.md): test evidence and remaining limitations.
- [Evaluation rubric](evals/README.md): model-quality checks and human review.
