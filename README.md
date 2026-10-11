# Codeboom

A local notebook for personal notes and source-grounded research, powered by the Codex agent harness.

Import sources, ask questions with inspectable citations, and turn answers into notes, summaries, briefing documents, study guides, and FAQs.

Voice input is for questions about existing saved notes. Note editing uses the text editor. Voice questions use the installed local English model (`npm run audio:setup`); microphone recordings and transient transcripts are not stored as sources or included in backups. Recording is limited to two minutes. Microphone permission and hardware behavior still need end-to-end qualification on the user's setup.

To ask about a saved note, open it and choose **Ask about this note**. This retains a cited snapshot of the displayed version and opens its conversation. Choose **Dictate question** to speak instead of typing in the question composer, stop, review, then **Insert into question**. Choose **Send** when ready; answers are written. Later note edits require opening that new saved version. Reopening the same version reuses its conversation. Generated audio remains disabled by default.

Open a saved note and choose **Export HTML** for a formatted file you can open offline or print through your browser. Formatting, readable references and the displayed saved revision are preserved, including when you inspect history. No script or remote asset is included, and exporting does not publish to an external service. Print-dialog/pagination and broader assistive-technology qualification remain open.

Closing an unsaved note offers **Keep editing** or **Discard draft**. The editor stays open while Save is pending and retains the draft if saving fails. Drafts are kept in memory until you explicitly save them.

Choose **Slides** in Studio to create up to eight concise cited slides from selected sources. Open the saved deck to browse slides, inspect references and expand speaker notes or the complete outline. **Export PowerPoint** downloads the displayed generated revision as editable text, with full references and qualifications in speaker notes. Edited decks become authored notes; their generated originals remain in history while the evidence is available. Native Office-viewer layout and human semantic review remain open. `npm run evaluate:slides` runs four synthetic cases through the configured Codex model and preserves results under `.codeboom/evals`.

Choose **Infographic** in Studio for cited cards, a two-position comparison or source-supported process steps. Every headline/body claim has inspectable references; steps additionally require evidence for their order. **Export PNG/SVG** downloads the displayed generated revision with readable references and full notices, plus exact quotes/spans/revisions and derived ancestry in embedded provenance. Edited copies become authored notes; generated originals remain in history while evidence is available. Images use local text/shapes, with no external assets. Dense content that exceeds the readable layout is refused. `npm run evaluate:infographic` runs five synthetic model cases; `node --import tsx scripts/qualify-infographic.ts` reconstructs preserved outputs without model requests. [Qualification](evals/results/2026-10-10-infographic-integration-v8.json) records 265-test regression, native image inspection and live comparison checks; human semantics, representative fonts/viewers and model reliability remain open.

Audio generation is deferred following the user's personal-notes clarification. It is absent from the normal interface and disabled by default. Experimental overview code and synthetic qualification evidence are retained behind the development-only `CODEBOOM_ENABLE_AUDIO_OVERVIEWS=true` flag; they do not establish release acceptance.

Cloud hosting and team features are deferred at the user's request: accounts, sharing/permissions, collaboration and connector synchronization are outside the current implementation phase. Local notes, explicit selected-file imports and local exports remain active. Voice is dictation for questions about saved notes; YouTube and generated audio remain deferred.

The user has also deferred video output and provider publishing integrations. Continue local notes, cited outputs/exports and explicit web research; historical expansion plans do not override this scope decision.

Choose **Find web sources** in Sources to search for candidate pages. Only your typed query goes to live web search; notebook content and instructions are excluded. Review each title/address and click **Import snapshot** for pages you want to save. Search adds nothing automatically. Imported pages retain original bytes, retrieval time, URL and exact revision; subsequent answers use selected saved snapshots with ordinary citations. Search is limited to two concurrent requests, eight searches and two minutes, and cancels when you close its dialog. `node --import tsx scripts/web-research-check.ts` and `scripts/web-research-cancel-check.ts` run synthetic live discovery/cancellation probes. [Qualification](evals/results/2026-10-10-web-research-integration-v1.json) records the prototype checks; relevance and representative-site/release assessment remain open.

**Status:** working macOS prototype. The application, storage, Codex integration, and automated checks are implemented. Human semantic review and broader release qualification remain open; see [verification evidence](docs/verification.md).

The latest [release audit](evals/results/2026-10-10-release-audit-v8.json) records 274 passing tests and the refreshed 40-question contract-8 model run. The current main app is available at port 40732 with separate `.codeboom/data`; the synthetic preview stays at 44281. Markdown downloads pin the displayed saved revision even if another window edits it. Human review is pending at the user's request to review later; automated status/span/canary checks do not meet that release gate.

## Run locally

Tested on macOS 26.6.2, Apple silicon, Node **26.10.0**, and npm **12.1.0**.

```sh
npm ci
npx codex login
npm run build
npm start
```

Open **http://127.0.0.1:40732**. If the project Codex CLI already has a working supported sign-in, skip the login command. The project pins Codex **0.161.0**; it does not upgrade the global CLI or copy credential files. Use **Connection → Check connection** after signing in.

Keep the browser origin consistent across restarts: the main app uses port **40732**. Manual browser qualification uses `npm run preview` at **http://127.0.0.1:44281**, with separate synthetic data in `.codeboom/preview`. Neither server selects another port when occupied; stop/reuse the matching instance instead. Browser permission decisions can depend on the exact host and port. Concurrent automated HTTP tests still use isolated ephemeral ports; they do not upload personal notes through the browser.

The runtime verifies its capabilities and permission profile before each run. It currently rejects other operating systems because their access boundaries have not been qualified.

For development, `npm run dev` builds the UI and watches the server. After a UI edit, run `npm run build` and reload the browser.

Google Drive is optional and needs your own registered **Desktop app** OAuth client, with Drive API and a consent screen configured in Google Cloud. Follow [Google’s installed-app setup](https://developers.google.com/identity/protocols/oauth2/native-app). Save the downloaded client JSON in a private location outside this repository and notebook data; do not commit it. Then:

```sh
npm run drive:setup
CODEBOOM_GOOGLE_DESKTOP_CLIENT="/absolute/private/path/desktop-client.json" npm start
```

Use **Connection → Google Drive → Connect Google Drive**, complete the read-only consent in your external system browser, then **Add sources → Google Drive** and paste one supported file link or ID. Docs/Sheets/Slides are retained as DOCX/XLSX/PPTX exports; uploaded supported formats keep their downloaded bytes. Provider versions appear in snapshot provenance. Refresh and linked retry are explicit. Disconnect cancels active Drive imports and removes Codeboom’s Keychain entry while retaining notebook snapshots. Provider-side grant revocation is available in your Google account.

Tokens stay in the macOS Keychain, bound to this notebook data directory and OS user, outside backups and model context. There is no plaintext fallback. Restoring to another directory requires a new connection. Sharing resource keys are used only during the explicit import and are not saved; a key-dependent refresh/retry may require pasting the original sharing link again. `npm run drive:check` verifies the helper using one newly generated synthetic Keychain entry and deletes it; it does not connect a Google account. Real-account consent/import and broader release qualification remain pending.

Uploaded audio uses local English transcription. Install its fixed model before importing recordings:

```sh
npm run audio:setup
```

This explicitly downloads and SHA-256 verifies the pinned English Whisper tiny.en assets (45,081,858 bytes), then installs them atomically under `.codeboom/models`. Set `CODEBOOM_AUDIO_MODEL_DIR` to choose a different model root. Repeating setup verifies existing files without downloading. Damaged existing assets are preserved and refused; choose a new root or remove that damaged model directory before reinstalling. Recognition uses installed assets with remote loading disabled. Model files are separate from notebook data and its backups. Missing or damaged assets fail imports with the setup instruction. Run `npm run audio:check -- .codeboom/new-audio-check.json` for explicit offline native/lifecycle qualification; it refuses to overwrite an existing result and never installs assets. Human listening and release qualification remain pending.

## What works

- Notebooks, conversations, notebook instructions, model selection, archive, and deletion.
- Notebook tags, a local library for searching current sources and saved notes across notebooks, and versioned personal/built-in templates. Recipes copy instructions, tags and starter questions into an empty notebook; their later edits do not change that notebook.
- Text PDFs, Markdown, UTF-8 TXT, pasted text, public HTML, and direct PDF URLs.
- Uploaded PNG/JPEG/static WebP and scanned or mixed PDFs use bundled local English OCR, with page/image locators, confidence estimates and recognition warnings. Download the exact original snapshot from the viewer to compare it with extracted text.
- Uploaded DOCX, PPTX, XLSX, UTF-8 CSV and TSV, with structural locators and visible extraction limitations. Word related parts and slide notes are included; workbook formulas stay as text with separately labeled cached snapshots.
- Uploaded WAV, MP3, AAC-LC ADTS/M4A, FLAC and single-stream Ogg Vorbis/Opus, with local English transcription, estimated time locators, original downloads and recognition warnings.
- Uploaded UTF-8 SRT/WebVTT caption files retain cue timing, explicit speaker labels and original bytes, with warnings for overlap and omitted styling.
- Source selection, immutable revisions, URL refresh, source viewer, removal, and purge.
- Real Codex generation with bounded notebook tools, progress, stop, retry, and reconnect.
- Exact citation checks, one bounded repair attempt, highlighted evidence, and explicit evidence gaps.
- Manual notes, saved answers, visual rich-note editing, note-to-source promotion, the four original Studio documents, flashcards/quizzes, mind maps/data tables, and Markdown/formatted HTML exports with citation footnotes.
- Rich notes support headings, emphasis, links, nested lists, quotes and code. Exact notebook references remain attached through edits, with an explicit authored-content qualification. Browse immutable revisions and restore an original as a new authored revision; stale saves retain the draft and offer an explicit reload.
- Promoted sources pin the exact note revision. Inspect its original text, generated ancestry and evidence manifest in the source viewer, even after editing the note.
- Mind maps show connected, collapsible branches and a cited outline. Data tables preserve attributed values and display missing evidence as “Not stated”; map/table panes scroll within the page on narrow screens.
- Flashcards reveal cited answers. Quizzes use revision-pinned attempts and local scoring; drafts and scores survive reopen. Choose 5–20 items; sparse evidence returns fewer with a warning.
- SQLite persistence, crash recovery, and verified backup/restore.
- Failed imports have linked retry attempts and lifecycle details. URL imports, refreshes and note promotions retry from stored descriptors; file/text retries ask for input again and also allow corrections.
- Runs retain their notebook instruction version and text. Source/instruction changes reset model history even when the earlier values are restored; visible conversation history remains available.
- Generation details show measured latency, selected-source count, evidence calls/characters, reached budgets, model/runtime, conservative context admission and reported token usage. Missing measurements remain unknown.

The current limits are 50 sources per notebook, 25 MiB per input, 500,000 extracted Unicode characters per source, and 1,000 PDF pages or presentation slides. Workbooks allow up to 256 sheets and 25,000 stored cells; CSV/TSV allows 256 columns and 10,000 rows. Decoded Office XML has additional package/part/depth/element limits. OCR permits up to twenty rendered PDF pages and sixty million rendered pixels per source, with an 8,000-pixel side and twelve-million-pixel limit per image/render. Nonblank pages without usable OCR text fail atomically; confirmed entirely white pages are skipped with visible warnings. Ordinary extraction has a 30-second deadline; audio has a five-minute deadline.

Office import preserves stored text and cell representations, with warnings for visual/layout omissions. Formulas are never calculated; cached values can be stale and missing caches stay unavailable. Legacy DOC/PPT/XLS, encrypted or macro-enabled files and embedded Office images are unsupported. YouTube imports are deferred at the user’s request; Drive connection and explicit file-link imports are implemented for macOS when a Desktop OAuth client is configured. Automated and native credential-store checks pass; real Google consent and authenticated-file qualification remain pending. OCR initially supports upright printed English; GIF/TIFF/animated files, other languages, handwriting and general scan/photo fidelity remain unqualified. Recognition confidence is an engine estimate, not proof of accuracy. Mixed PDF pages retain native text and full-page OCR separately and can repeat text. Office/spreadsheet files can be uploaded locally or imported through the explicit Drive connection; web links retain the existing HTML/PDF/plain-text support. Representative authoring-tool fidelity and human release review remain open.

Audio permits ten minutes, one or two channels and 8–96 kHz decoded sampling rates, with an additional 24-million channel-sample budget that can be reached earlier for high-rate stereo. AAC initially supports LC and one local M4A audio track with complete sample tables and a simple timeline; HE-AAC, ALAC, video/fragmented/encrypted M4A, chained Ogg and unknown-length FLAC are refused. Stereo is averaged and resampled to 16 kHz; phase cancellation and codec padding can affect recognition or timing. Transcripts can miss or invent words: listen to the original to verify names, numbers and commitments. Times are estimates, and speakers, translation and other languages are not inferred.

Audio extraction runs in a disposable Node process. Completion, cancellation and deadlines await process exit before releasing the import slot, so native allocations are reclaimed by the OS. The 256 MiB JavaScript heap limit is not a total-memory cap: a tested audio child peaked around 857 MiB. Set `CODEBOOM_IMPORT_CONCURRENCY=1` to reduce simultaneous audio memory use. Other operating systems and sustained production load remain unqualified.

Tags allow ten single-line labels of 48 Unicode characters each. Templates allow eight single-line starter questions of 1,000 characters each and 100 personal recipes. Library queries allow 200 characters, return 30 results by default and at most 50 per page, and include archived notebooks only when requested. Library searches and template operations stay local and do not start model requests.

Rich notes allow 100,000 Unicode text characters (including attached quotes), 5,000 nodes, nesting depth twelve and one MiB of stored JSON. Paste inserts plain text; links require explicit HTTP(S) URLs and open only when clicked. Rich-note exports preserve formatting and citation footnotes. Authored revisions retain references but do not claim the references support changed text; purged references become unavailable and prevent source promotion. Editing, browsing history and restoration stay local.

## Data and model access

Product data is stored in ignored **`.codeboom/data/`** by default. Questions, notebook instructions, selected passages, and compatible conversation context are sent to the provider configured in Codex. This is local storage with remote inference. Valid token counts reported by the runtime are retained, including any repair turn. Monetary cost is not reported and remains unknown; the app does not estimate subscription-backed costs.

The service binds to `127.0.0.1`, validates Host and Origin, and uses a same-origin session cookie. Agent runs use ephemeral Codex threads, an empty working directory, a restricted read profile, and four scoped evidence tools. Shell, web search, apps, plugins, unrelated MCP tools, memory, host skill discovery, and agent network access are disabled or excluded. Authentication and inference still require the Codex client to reach its provider.

Removal retains historical evidence. Purge removes managed source content and affected generated copies, including promoted copies, while preserving user-authored notes. Affected quiz attempts are removed with purged generated material. Exports, existing backups, and requests already sent to a provider remain outside this cleanup. Local deletion is logical application cleanup, not a promise of forensic erasure from storage hardware.

## Configuration

Set environment variables before starting the server. Keep secrets out of Git.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEBOOM_DATA_DIR` | `.codeboom/data` | Database, source blobs, and empty runtime workspace |
| `CODEBOOM_AUDIO_MODEL_DIR` | `.codeboom/models` | Verified local English transcription assets |
| `CODEBOOM_PORT` | `40732` | Fixed loopback web port; explicit override only |
| `CODEBOOM_MAX_SOURCES` | `50` | Notebook source limit; 1–50 |
| `CODEBOOM_IMPORT_CONCURRENCY` | `2` | Active download/extraction imports; 1–2 |
| `CODEBOOM_EVIDENCE_CALLS` | `20` | Per-run read tool call limit; 1–100 |
| `CODEBOOM_EVIDENCE_CHARACTERS` | `200000` | Total serialized evidence response characters, including metadata; 1,600–500,000 |
| `CODEBOOM_CHAT_TIMEOUT_MS` | `120000` | Chat deadline including connection setup |
| `CODEBOOM_ARTIFACT_TIMEOUT_MS` | `300000` | Studio deadline including connection setup |

There is one active run per conversation and at most two across the service. Imports separately admit at most two active downloads/extractions; excess imports fail with an explicit capacity message and can be retried. Additional work is rejected with a retryable capacity message. Evidence coverage records passages actually returned in each run, lists omitted sources/sections, and remains visible in saved outputs and Markdown exports.

Evidence responses also require a usable context window and current-context count reported by the selected runtime model. Until those values arrive, tool reads return a fixed retryable error without source content. The adapter then applies a conservative UTF-8 byte allowance with a 20% generation reserve, alongside the configured call/character limits. It never waits while holding a tool reply. Missing capacity fails explicitly; a capacity cutoff exposes omitted coverage or fails rather than presenting a complete analysis. Context-budget estimates are separate from reported provider usage and do not become monetary estimates.

An identical import with matching provenance offers reuse of the saved source or dismissal of the new import. The offer survives restart, retains the original source selection, and refuses reuse if that revision changes or becomes unavailable. The four original Studio documents have sections specific to their kind; editing and promotion retain section headings, and exports include those headings with citation footnotes.

## Backup and restore

Stop Codeboom first. Choose new destination directories outside the data directory.

```sh
npm run data -- backup .codeboom/data /absolute/path/to/codeboom-backup
npm run data -- restore /absolute/path/to/codeboom-backup /absolute/path/to/restored-data
CODEBOOM_DATA_DIR=/absolute/path/to/restored-data npm start
```

Backups include a checkpointed database, referenced blobs, and a versioned hash manifest. Restore verifies the hashes and schema and never overwrites an existing destination. Protect backups as you would the source documents.

## Verify

Reusable evaluation inputs live in `tests/fixtures/evaluation/`. Generated evaluation artifacts under `evals/` and `.codeboom/` stay local and are ignored by Git; historical result links refer to those local files. Unit tests generate synthetic checker inputs and do not require preserved model results.

```sh
npm run typecheck
npm test
npm run build
npm run isolation:check
npm run harness:check
npm run evaluate
npm run evaluate:artifacts
npm run evaluate:study
npm run evaluate:structured
npm run profile
```

The harness and evaluation commands make real model requests using the configured Codex account. The grounding evaluation has 40 fixed synthetic questions; the artifact evaluation covers all four Studio kinds with supported and insufficient-evidence cases. Each evaluation uses two concurrent workers and writes under ignored `.codeboom/`. The native isolation check runs on macOS and uses synthetic canaries. Regenerate pinned protocol bindings with `npm run codex:generate` after an intentional runtime upgrade, then repeat compatibility checks.

## Project documents

- [Intent](intent.md): purpose and principles.
- [Specification](docs/spec.md): product requirements and acceptance criteria.
- [Plan](docs/plan.md): milestones and task status.
- [Technical decisions](docs/technical-decisions.md): architecture and dependency authority.
- [Requirements audit](docs/requirements-audit.md): individual planned tasks, evidence scope, and remaining gates.
- [Verification](docs/verification.md): test evidence and remaining limitations.
- [Evaluation rubric](evals/README.md): model-quality checks and human review.

Study material is an implemented prototype expansion with human semantic review still pending. Quiz scores compare choices with a generated answer key, not independent truth certification. Markdown exports label candidate options/distractors; generated quiz promotion excludes distractors and learner choices and preserves generated ancestry. Run `npm run evaluate:study` for the six versioned synthetic supported/unanswerable/sparse checks and `npm run review:study -- prepare/check` with result/review paths for the human review workflow; see the [rubric](evals/README.md#study-human-review-rubric-v1) and verification for results and limits.

Mind maps/data tables use output contract 5 and the same scoped generation lifecycle. The eight-case versioned corpus covers supported, sparse, conflicting and insufficient evidence. The [raw result](evals/results/2026-10-10-structured-v5.json) retains initial sparse-check flags; the [hash-bound recheck](evals/results/2026-10-10-structured-v5-checks.json) passes all eight after removing an extra warning requirement that the acceptance criteria did not impose. Human review of hierarchy, values and qualifiers remains pending.
