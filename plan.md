# Codeboom implementation plan

Status: First working prototype implemented. M1–M4 are substantially complete; remaining release checks are listed below and in [verification](docs/verification.md).  
Basis: [Product specification](docs/spec.md) and [product intent](intent.md).  
Technical authority: [Technical decisions](docs/technical-decisions.md).

Build the first source-grounded notebook as a sequence of working increments. Prove the Codex integration and its access boundaries before building the full interface. The first release covers the formats, conversations, notes, and four Studio outputs defined by the spec; expanded parity remains a later backlog.

## Document ownership

| Document | Owns |
| --- | --- |
| [intent.md](intent.md) | Product purpose and guiding principles |
| [docs/spec.md](docs/spec.md) | Product behavior, scope, requirements, and acceptance criteria |
| [docs/technical-decisions.md](docs/technical-decisions.md) | Architecture, technology choices, tradeoffs, and technical questions awaiting evidence |
| This plan | Work sequence, dependencies, deliverables, and completion evidence |

Technical changes must update the decision record. Requirement changes must also update the spec. Completing a task means recording its verification evidence, not merely creating its files. Unchecked items below are planned work.

## Delivery sequence

| Milestone | Depends on | Demonstrable outcome |
| --- | --- | --- |
| M1 Harness proof | None | Codex answers over two fixture sources with resolvable citations and enforced access boundaries |
| M2 Notebook foundation | M1 access and protocol gates | Sources import, remain inspectable, and survive restart |
| M3 Grounded conversation | M2 | A user selects sources, chats, follows citations, and safely changes context |
| M4 Notes and Studio | M3 | Research becomes editable notes and exported cited documents |
| M5 First-release readiness | M2–M4 | Recovery, deletion, quality, and accessibility meet the spec |
| Later expansion | M5 and a selected next priority | Additional formats, study tools, media, research, or collaboration |

M1 is the first milestone throughout these documents. Its work includes dependency selection and a minimal scaffold; no separate milestone zero is required.

## M1 Harness proof

Technical decisions: TD-01 through TD-05, TD-10, TD-12, and TD-16.

### Work

- [x] M1.1 Establish the minimal TypeScript project, chosen Node release, package manager and lockfile, type checking, and a small test runner. Record exact choices in TD-02 and the dependency inventory.
- [x] M1.2 Select a Codex executable, generate its protocol types, and record a tested runtime version. Exercise initialization, supported authentication setup, available-model discovery, structured output, and error handling. Avoid copying existing credential stores.
- [x] M1.3 Test effective filesystem, tool, instruction, and network boundaries on macOS with synthetic sources. Prove that unrelated files, other notebooks, external tools, and arbitrary network destinations are inaccessible. Record any unavailable control.
- [x] M1.4 Implement the application adapter and the four scoped read tools from the spec against two small text fixtures. Associate every tool request with a server-held run manifest.
- [x] M1.5 Validate a structured answer and exact citation spans. Add one bounded citation repair attempt and an explicit failure path.
- [x] M1.6 Exercise progress, cancellation, timeout, late results, and process exit. Persist enough run identity to distinguish an interrupted attempt from a fresh attempt.
- [x] M1.7 Demonstrate one cross-source question with a minimal passage viewer or command-line output that resolves each citation. Save the tested configuration and results without raw credentials.

### Deliverables and exit gate

Deliver a reproducible integration check, adapter boundary, versioned output contract, two-source fixture, and documented compatibility evidence. The gate passes only when the notebook tools work under the required access restrictions and cancelled runs cannot save late results.

If dynamic tools fail the compatibility gate, evaluate the scoped MCP alternative under TD-03. If access isolation cannot be enforced, keep M1 incomplete, record the failing condition, and revise the runtime design. Do not bypass the gate with broader permissions or prompt-only restrictions.

## M2 Notebook foundation

Technical decisions: TD-02, TD-06 through TD-09, TD-14, and TD-15.

### Work

- [x] M2.1 Select the SQLite driver and extraction libraries through the bounded evaluations in TD-17. Add migrations for notebooks, source revisions, passages, conversations, runs, messages, artifacts, jobs, and application events.
- [x] M2.2 Implement notebook create, rename, archive, and instruction editing. Establish IDs, timestamps, schema versions, and ownership checks. Notebook deletion is completed with cleanup in M5.
- [x] M2.3 Implement original-byte storage, immutable extracted revisions, hashing, transactional publication, and recoverable cleanup of staged files.
- [x] M2.4 Import TXT, Markdown, and pasted text with deterministic normalization and stable passage locations.
- [x] M2.5 Import text PDFs while preserving pages. Reject or flag image-only and poorly extracted documents. Add public HTML and direct PDF URL imports through the restricted fetcher.
- [x] M2.6 Add import jobs, visible failure states, capacity limits, duplicate handling, idempotent retries, source refresh, and removal from current selection.
- [x] M2.7 Implement scoped full-text retrieval, neighboring-passage reads, ordered section enumeration, and coverage reporting.
- [x] M2.8 Build the notebook/source interface and a safe source viewer. Show extraction warnings and ready status; prevent use of failed or incomplete sources.
- [ ] M2.9 Verify restart persistence, duplicate import retries, URL redirect protections, Unicode locations, cross-notebook access rejection, and citations to older revisions.

### Deliverables and exit gate

A notebook can ingest every first-release source type, inspect the extracted evidence, refresh it without changing previous revisions, and recover after a restart. Every ready source has a complete, inspectable provenance record. Partial imports cannot enter the ready set.

## M3 Grounded conversation

Technical decisions: TD-03 through TD-05 and TD-09 through TD-14.

### Work

- [x] M3.1 Implement persistent conversations and atomically capture each run's selected source revisions, instruction version, grounding mode, and output contract version.
- [x] M3.2 Connect the Codex adapter to production retrieval handlers. Reuse only compatible execution contexts and create fresh contexts after source or instruction changes.
- [x] M3.3 Implement local API session protection, request validation, run creation idempotency, a bounded queue, and one active run per conversation.
- [ ] M3.4 Persist ordered application events and expose replayable server-sent events. Reattach after a browser reconnect without rerunning generation.
- [x] M3.5 Render the conversation, source selection, progress, stop control, insufficient-evidence responses, conflicts, and coverage warnings. Mark streamed drafts provisional.
- [x] M3.6 Resolve citation links through application records and open the stored passage. Preserve keyboard focus and the historical revision label.
- [x] M3.7 Cancel affected runs when sources, instructions, or selections change. Guard completion with the run's cancellation and context generation, then save the final answer atomically.
- [ ] M3.8 Handle invalid output, citation repair failure, authentication expiry, rate limits, and app-server exit without duplicate completed messages.
- [x] M3.9 Verify that excluded evidence never enters new tool responses or replayed model context. Include in-flight mutation and cancellation/completion race tests.

### Deliverables and exit gate

The source/conversation/output layout supports a complete cited conversation. Source boundaries hold across follow-ups and selection changes. A citation resolves to selected evidence, an unanswerable question abstains, and the UI recovers an existing run after reconnect.

## M4 Notes and Studio

Technical decisions: TD-10, TD-12 through TD-15.

### Work

- [x] M4.1 Add manual notes and save-answer-as-note with retained citations, manifest, and originating run.
- [x] M4.2 Implement immutable artifact revisions and user-authored edit labels. Changed text must not inherit a claim that its old citation remains verified.
- [x] M4.3 Add explicit note-to-source promotion with a derived-content label and provenance links.
- [x] M4.4 Implement summary, briefing document, study guide, and FAQ generation through the same retrieval and validation contracts as chat.
- [x] M4.5 Add queued/running/validating/completed/failed/cancelled artifact states, linked retry attempts, and controls that preserve completed versions.
- [x] M4.6 Export Markdown with readable citation footnotes, source revision and locator, and origin URLs where available.
- [x] M4.7 Verify complete source coverage or visible omissions, artifact restart persistence, editing behavior, cancellation, and export provenance.

### Deliverables and exit gate

A user completes the intended research workflow: import sources, ask a question, inspect citations, save and edit a note, generate a cited document, export it, and reopen the notebook after restarting.

## M5 First-release readiness

Technical decisions: TD-04 through TD-17.

### Work

- [ ] M5.1 Implement reconciliation for interrupted imports and runs, recovery after app-server exit, and cleanup of abandoned staged blobs. Unknown provider outcomes remain interrupted until reconciled or explicitly retried.
- [x] M5.2 Apply configurable source limits, retrieval call budgets, evidence size budgets, and run deadlines. Report partial coverage and unavailable usage accurately.
- [x] M5.3 Complete source purge and notebook deletion across blobs, indexes, retained output evidence, application events, diagnostics, and managed execution contexts. Report partial cleanup and preserve tombstones where needed for honest citation display.
- [ ] M5.4 Exercise malicious document instructions, unauthorized source IDs, source paths, unsafe markup, private-address URLs, redirects, and unrelated runtime tools. Verify boundaries at the service and runtime levels.
- [ ] M5.5 Run keyboard, focus-return, responsive layout, and screen-reader-label checks for imports, source selection, citation navigation, generation, and stop controls.
- [ ] M5.6 Version the evaluation corpus and human-review rubric. Run the semantic support and abstention gates below using the pinned model/runtime configuration.
- [ ] M5.7 Measure ingestion time, time to first progress, answer latency, cancellation completion, and resource use. Record the baseline rather than inventing performance guarantees.
- [x] M5.8 Document setup, supported macOS/runtime versions, authentication, data locations, backup/restore, known limits, and model-data flow. Verify a clean setup and a backup restore.
- [x] M5.9 Record release evidence against every acceptance row, update decision statuses, and document unresolved limitations. No gate is marked passed solely because its code exists.

### Release acceptance mapping

| Spec acceptance scenario | Primary work | Required evidence |
| --- | --- | --- |
| First session | M3.5–M4.7 | End-to-end walkthrough covering import, chat, citation, note, and reopen |
| Citation integrity | M1.5, M3.6 | All completed references resolve to selected revisions with matching quotes |
| Insufficient evidence | M3.5, M5.6 | At least 9 of 10 unanswerable fixture questions abstain |
| Claim support | M5.6 | At least 95% of factual claims in the fixed 30-question set have human-reviewed support |
| Source conflict | M3.5, M5.6 | Both conflicting statements are attributed to their respective evidence |
| Isolation | M1.3, M2.9, M5.4 | Denied cross-notebook IDs, excluded sources, unrelated files, and network destinations |
| Selection change | M3.2, M3.7, M3.9 | New execution context; no excluded evidence in tool responses or replay |
| Refresh and removal | M2.6, M3.7, M5.3 | Historical references remain versioned; affected runs cancel; purged evidence is unavailable |
| Broad summary | M2.7, M4.4, M4.7 | Every selected source covered or omissions displayed |
| Failure and retry | M2.6, M3.8, M5.1 | Fault-injection checks show no duplicate sources, runs, or artifacts |
| Cancellation | M1.6, M3.7, M4.5 | Immediate UI acknowledgement and no late output committed |
| Export | M4.6–M4.7 | Readable provenance in an exported document |
| Persistence | M2.9, M4.7, M5.8 | Restart and backup-restore checks recover notebook state and citation locations |

Use synthetic or redistributable fixtures. Keep deterministic validation separate from human semantic assessment. Store the runtime/model, corpus version, result, and known failure for each evaluation.

## Later expansion

The following are outside first-release completion:

- Flashcards, quizzes, mind maps, and structured data tables.
- DOCX, slide decks, spreadsheets, OCR, audio transcription, YouTube, and Drive imports.
- Cited audio scripts followed by separately selected speech generation; slides, infographics, and video.
- Explicit web-assisted research with separate evidence policy.
- Hosting, account management, sharing, collaboration, and connector synchronization.

Before implementing an extension, define its user acceptance criteria in the spec and its technical implications in the decision record.

## Completion and update procedure

For each completed task, replace its checkbox only after verification and add a short evidence entry below. Include task ID, change or commit reference when available, verification result, and any limitation. Update dependent tasks when a gate changes.

| Task or milestone | Evidence | State |
| --- | --- | --- |
| M1 | Pinned executable/types, live cited comparison, scoped tools, exact quote validation, native sandbox denial, startup cancellation and transport/race tests | Prototype proof passed on tested macOS |
| M2.1–M2.8 | SQLite migrations 1–3, original bytes, immutable revisions, FTS5, isolated parser worker, all initial input adapters, source viewer | Implemented; synthetic checks passed |
| M2.9 | Restart, duplicate imports, Unicode, old revisions and notebook rejection pass; broad redirect matrix remains | Partial verification |
| M3.1–M3.3, M3.5–M3.7, M3.9 | Real browser chat/citation flow and live selection-change abstention; atomic manifest/generation checks | Passed listed checks |
| M3.4, M3.8 | Persisted SSE replay/reconnect implemented; provider expiry/rate-limit and broader event-fault qualification remain | Partial verification |
| M4 | Real summary and saved note with export, artifact revisions, derived sources and shared validation | Implemented; representative flow passed |
| M5.1, M5.4 | Recovery, invalid IDs, malicious appendix, native read/write/network denial and parser tests pass; broader fault corpus remains | Partial qualification |
| M5.2–M5.3 | Configurable budgets; verified purge of managed evidence including generated promoted copies | Implemented and tested |
| M5.5 | Citation focus return, keyboard Escape, labels and 390px mobile layouts checked | Full assistive-technology audit pending |
| M5.6 | 40-question corpus/rubric and original results recorded; 10/10 abstentions; one rejected answer later passed targeted repair recheck | Human semantic gate pending |
| M5.7 | Progress, answer latency and startup cancellation measured | RSS and representative ingestion profiling pending |
| M5.8–M5.9 | Setup, pinned environment, retention, backup restore and acceptance evidence documented | Completed documentation and backup proof |

The next release work is a full quality rerun on the final tool contract, human claim-support review, broader URL/parser fault qualification, and resource/accessibility profiling. These are explicit qualification gaps; the local application can be run using the README.
