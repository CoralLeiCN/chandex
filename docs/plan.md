# Codeboom implementation plan

Latest scope clarification (2026-10-10): **video output and provider publishing integrations are user-deferred**, alongside cloud/team, generated audio and YouTube. Explicit web research remains in current scope and now has a local query-only discovery/snapshot prototype. Retain older checkpoints as history without treating their deferred work as current obligations.

Local infographic increment (2026-10-10): typed cited templates, saved-revision viewer and bounded PNG/SVG exports are implemented with [265-test/lifecycle/native/browser evidence](../evals/results/2026-10-10-infographic-integration-v8.json). Human semantic, representative rendering/load and model reliability gates remain open. Main and manual preview origins are fixed at port 40732/44281 at the user's request. Cloud/team work stays deferred; broader local work remains active.

Current priority, clarified by the user on 2026-10-10: **personal notes and voice questions about existing notes only**. Note dictation is removed from the editor; voice recording is available only in saved-note conversations, with review and explicit Send. Written answers remain the default. Audio generation and YouTube support are deferred at the user's request. Original broader work and named release gates remain recorded; deferred features are not claimed complete.

Status: First working prototype implemented. M1–M4 are substantially complete; remaining release checks are listed below and in [verification](verification.md).
Current release audit (2026-10-10): [274-test/current contract-8 grounding record](../evals/results/2026-10-10-release-audit-v8.json) refreshes the fixed corpus and hash-bound human packet. Automated statuses/spans/canaries pass; M5.6 remains unchecked. The user will provide review later. Human/user-assisted release qualification blocks completion; do not replace it with agent judgments or repeated automated runs. The current main app is running at port 40732 and preview data remains separate at 44281.
Current user priorities (2026-10-10): local personal notes, dictation instead of typing questions about saved notes, and written answers. Cloud hosting/team accounts/sharing/collaboration/synchronization, generated audio and YouTube are deferred. Historical checkpoints below retain their original scope; this explicit user decision supersedes their cloud/team implementation expectations.

Latest local progress: cited slides and exact-revision PowerPoint export have [lifecycle and multislide evidence](../evals/results/2026-10-10-slides-lifecycle-v7.json): 252-test regression, real HTTP exports, controlled actual-encoder purge/cancel/admission/shutdown races and live desktop/mobile two-slide navigation. [Bundled LibreOfficeDev rendering](../evals/results/2026-10-10-slides-native-v7.json) covers three synthetic decks/seven pages; Microsoft PowerPoint, Keynote, stable LibreOffice, representative files/fonts, live assistive technology and named human semantic gates remain open. Existing local requirements remain active; this checkpoint does not establish completion.
Basis: [Product specification](spec.md) and [product intent](../intent.md).
Technical authority: [Technical decisions](technical-decisions.md).

Build the first source-grounded notebook as a sequence of working increments. Prove the Codex integration and its access boundaries before building the full interface. The first release covers the formats, conversations, notes, and four Studio outputs defined by the spec; expanded parity remains a later backlog.

## Document ownership

| Document | Owns |
| --- | --- |
| [intent.md](../intent.md) | Product purpose and guiding principles |
| [docs/spec.md](spec.md) | Product behavior, scope, requirements, and acceptance criteria |
| [docs/technical-decisions.md](technical-decisions.md) | Architecture, technology choices, tradeoffs, and technical questions awaiting evidence |
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
| Later expansion | M5 plus extension acceptance for release; selected priority for local development | Additional formats, study tools, media, research, or collaboration |

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
- [x] M2.9 Verify restart persistence, duplicate import retries, URL redirect protections, Unicode locations, cross-notebook access rejection, and citations to older revisions.

### Deliverables and exit gate

A notebook can ingest every first-release source type, inspect the extracted evidence, refresh it without changing previous revisions, and recover after a restart. Every ready source has a complete, inspectable provenance record. Partial imports cannot enter the ready set.

## M3 Grounded conversation

Technical decisions: TD-03 through TD-05 and TD-09 through TD-14.

### Work

- [x] M3.1 Implement persistent conversations and atomically capture each run's selected source revisions, instruction version, grounding mode, and output contract version.
- [x] M3.2 Connect the Codex adapter to production retrieval handlers. Reuse only compatible execution contexts and create fresh contexts after source or instruction changes.
- [x] M3.3 Implement local API session protection, request validation, run creation idempotency, bounded admission, and one active run per conversation.
- [x] M3.4 Persist ordered application events and expose replayable server-sent events. Reattach after a browser reconnect without rerunning generation.
- [x] M3.5 Render the conversation, source selection, progress, stop control, insufficient-evidence responses, conflicts, and coverage warnings. Mark streamed drafts provisional.
- [x] M3.6 Resolve citation links through application records and open the stored passage. Preserve keyboard focus and the historical revision label.
- [x] M3.7 Cancel affected runs when sources, instructions, or selections change. Guard completion with the run's cancellation and context generation, then save the final answer atomically.
- [x] M3.8 Handle invalid output, citation repair failure, authentication expiry, rate limits, and app-server exit without duplicate completed messages.
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

- [x] M5.1 Implement reconciliation for interrupted imports and runs, recovery after app-server exit, and cleanup of abandoned staged blobs. Unknown provider outcomes remain interrupted until reconciled or explicitly retried.
- [x] M5.2 Apply configurable source limits, retrieval call budgets, evidence size budgets, and run deadlines. Report partial coverage and unavailable usage accurately. Selected-model context admission uses validated runtime capacity, conservative byte accounting and a generation reserve; deterministic cutoff/missing-capacity checks and fresh model/browser evidence are recorded in verification.
- [x] M5.3 Complete source purge and notebook deletion across blobs, indexes, retained output evidence, application events, diagnostics, and managed execution contexts. Report partial cleanup and preserve tombstones where needed for honest citation display.
- [x] M5.4 Exercise malicious document instructions, unauthorized source IDs, source paths, unsafe markup, private-address URLs, redirects, and unrelated runtime tools. Verify boundaries at the service and runtime levels.
- [x] M5.5 Run keyboard, focus-return, responsive layout, and screen-reader-label checks for imports, source selection, citation navigation, generation, and stop controls. The named checks are recorded in verification; live assistive-technology qualification remains a separate limitation.
- [ ] M5.6 Version the evaluation corpus and human-review rubric. Run the semantic support and abstention gates below using the pinned model/runtime configuration.
  Current packet: `.codeboom/review/2026-10-10-final-v8-rubric-v1.json`, bound to `evals/results/2026-10-10-final-grounding-v8.json`. Corpus/rubric/run/packet are prepared; named human review remains pending until the user reviews later.
  [Review integrity verification](../evals/results/2026-10-10-review-integrity-v1.json) closes copied-context/date checks with 275 passing regressions; the actual packet remains unchanged and unreviewed. The rubric and support thresholds remain unchanged.
- [x] M5.7 Measure ingestion time, time to first progress, answer latency, cancellation completion, and resource use. Record the baseline rather than inventing performance guarantees.
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

- Notebook tags/templates/cross-notebook discovery: implemented local prototype with bounded migration/API/browser checks; release acceptance remains open.
- Rich note editing: implemented local prototype with formatting, attached references, immutable history and authored restoration; human/release qualification remains open.
- Publishing integrations from spec §2 are user-deferred (2026-10-10).
- Portable formatted HTML export: implemented local attachment/print-style workflow with exact displayed revision, safe formatting and evidence footnotes. It does not complete provider-specific publishing integrations.
- Flashcards, quizzes, mind maps, and structured data tables: implemented local prototypes; human expanded-release acceptance pending.
- Uploaded DOCX/PPTX/XLSX/CSV/TSV: implemented local prototype; representative authoring-tool fidelity and expanded-release acceptance remain open.
- OCR: implemented local English image/scanned/mixed-PDF prototype with page/image warnings, original downloads and bounded verification; human fidelity/release acceptance remains open.
- Audio transcription, YouTube and Drive imports, and remaining input adapters.
- Generated audio scripts/speech and video output: user-deferred. Slides and infographics: implemented local prototypes with lifecycle/native/browser qualification; human and broader rendering acceptance remain open.
- Explicit web-assisted research: implemented query-only candidate discovery and selected dated snapshot imports; ordinary questions remain source-only. Human relevance/representative-site/release qualification remains open.
- **Deferred by the user:** hosting, account management, sharing, collaboration, and connector synchronization.

Before implementing an extension, define its user acceptance criteria in the spec and its technical implications in the decision record.

Explicit web research checkpoint (2026-10-10): [273-test integration record](../evals/results/2026-10-10-web-research-integration-v1.json), query-only live search and cancellation probes, desktop/mobile reviewed import, retained snapshot provenance and exact source-only answer citation. This implements the separate discovery/evidence policy; human relevance, representative-site/provider qualification and the existing release gates remain open. Video and provider publishing are user-deferred.

Flashcards/quizzes now have [acceptance criteria](spec.md#study-expansion-flashcards-and-quizzes), TD-14/TD-15 implications and an implemented local prototype. Their deterministic/runtime/browser checks are recorded in verification; named human support and quiz-ambiguity review remain open. Mind maps/data tables now have their own criteria and implementation evidence below; the other expansions above remain planned.

Sequencing update, 2026-10-10: the ongoing request to implement all planned work authorizes continued local development while M5.6 awaits human judgments. M5 remains a release acceptance dependency. This changes development order, preserves every original acceptance threshold, and does not claim a complete first or expanded release.

## Completion and update procedure

For each completed task, replace its checkbox only after verification and add a short evidence entry below. Include task ID, change or commit reference when available, verification result, and any limitation. Update dependent tasks when a gate changes.

| Task or milestone | Evidence | State |
| --- | --- | --- |
| M1 | Pinned executable/types, live cited comparison, scoped tools, exact quote validation, native sandbox denial, startup cancellation and transport/race tests | Prototype proof passed on tested macOS |
| M2.1–M2.8 | SQLite migrations 1–12, original bytes, immutable revisions, FTS5, isolated parser worker, all initial input adapters, source viewer, durable duplicate offers, linked import retries and instruction versions | Implemented; synthetic checks passed |
| M2.9 | Restart, duplicate imports, Unicode, old revisions and notebook rejection; all redirect statuses, relative/malformed locations, mixed DNS, rebinding, pinned lookup and download limits verified in controlled transport tests | Passed listed regression checks |
| M3.1–M3.3, M3.5–M3.7, M3.9 | Real browser chat/citation flow and live selection-change abstention; atomic manifest/generation checks | Passed listed checks |
| M3.4, M3.8 | Persisted terminal events and Last-Event-ID replay; live browser reload retained run 8a45475e-948d-433d-a164-966fa41a65bc with one attempt; structured authentication/rate-limit/validation/timeout/interruption categories and linked retry fault tests | Passed controlled faults and live reconnect |
| M4 | Real summary and saved note with export, artifact revisions, derived sources and shared validation | Implemented; representative flow passed |
| M5.1, M5.4 | Atomic restart/cancellation events, staged cleanup, parser/runtime faults, scoped IDs, private URLs, 40/40 injection-canary resistance and fresh native read/write/network denial | Passed named regression corpus; broader production inputs remain a qualification limit |
| M5.2 | Configurable hard budgets, scoped usage/diagnostics and runtime-reported model context admission; 85 tests and fresh contract-4 model/browser checks | Verified named limits, unknown-capacity failure and smaller-evidence admission |
| M5.3 | Verified purge of managed evidence including generated promoted copies | Implemented and tested |
| M5.5 | Keyboard create/import/select/send/stop/citation/save/reconnect; Send/Stop focus return; mobile pressed state, visible source count and 390px layout checked | Named checks passed; live assistive-technology qualification pending |
| M5.6 | Fresh 2026-10-10 tool-contract-4 run: 30/30 answerable, 10/10 abstentions, 40/40 injection canaries; validated unreviewed claim packet and human-review checker prepared | Human semantic gate pending |
| M5.7 | New 40-run latency baseline; sampled server/worker RSS and ingestion timings for long TXT/Markdown/HTML and a 25-page PDF, including two concurrent imports | Baseline recorded; sustained production load is not qualified |
| M5.8–M5.9 | Setup, pinned environment, retention, backup restore and acceptance evidence documented | Completed documentation and backup proof |

The next release gate is named human claim-support review. Selected-model context admission is implemented and verified in the stated scope. Live assistive-technology use and expanded real-document/fault qualification remain limitations where the bounded synthetic corpus does not establish production behavior. The 2026-10-09 full quality rerun and resource baseline are recorded in verification. The local application can be run using the README. The [requirement-by-requirement audit](requirements-audit.md) records all planned tasks, acceptance contracts and later work without declaring the goal complete.

### Additional specification-audit evidence, 2026-10-09

M2.3–M2.9 now preserve requested/final URL provenance, retrieval timestamps, scoped terminal-job publication and immutable historical metadata; the source viewer exposes that provenance. M3.8 retains failed unverified drafts, including provider failure during repair, without completed messages or artifacts. M3.9/M5.2 now enforce canonical manifest search results and budgets over complete serialized evidence responses (tool contract 3). M5.1/M5.2 bound active imports and cancel download/extraction work on shutdown; clean worker exit cannot hang an import. M5.3 clears retained failure drafts on source purge. M5.8 includes schema 3-to-6 backup restoration. The 54-test suite and a fresh 40/40 tool-contract-3 evaluation pass; the named human claim review and full assistive-technology audit remain open.

The subsequent audit adds stored output contract 2 with source/section omissions computed from successful evidence reads, preserving every model warning; UI and Markdown export retain these details. Extraction version 2 keeps complete heading evidence while bounding its repeated locator metadata. Duplicate reuse preserves derivation and URL provenance. Provider and isolated-parser diagnostics cannot echo the tested source/credential canaries into routine application output. These changes extend the regression and live browser qualification recorded in verification; M5.5/M5.6 remain open.

The latest audit adds contract 3 Studio kinds and ordered sections, final publication validation, and shared structured rendering/edit/promotion/export. All four kinds pass supported/insufficient-evidence live model cases. Schema 7 adds explicit duplicate reuse/dismiss offers with durable candidate revisions, scoped idempotent acceptance, stale-revision refusal and active-run preservation. Browser evidence confirms artifact-citation focus return and duplicate-resolution focus return at desktop/mobile widths. A real filesystem permission fault verifies failed notebook cleanup is exposed and retryable. Human review now binds rubric version 1, corpus content and exact questions; the original semantic-support gate remains pending.

M4.3 now pins promotion to the exact artifact revision before extraction and makes its original text, title, originating run and manifest inspectable. Schema 8 preserves this ancestry across edits, restart and backup; duplicates from different note revisions do not collapse. Purge withholds unavailable generated content. The 73-test suite, scoped HTTP concurrent-edit check and desktop/mobile keyboard viewer checks establish the recorded scope. First-release completion remains unproven while the human semantic gate, assistive-technology audit and remaining requirement-by-requirement audit are open.

M2.6/M5.1 now offer explicit import retry controls and persist operation type, input descriptors, linked attempt counts and lifecycle timestamps (schema 9). File/text input is requested again; refresh/promotion descriptors preserve their target and note revision. Idempotent replay never creates or dispatches another child. A 76-test suite plus real browser file/paste/URL/promotion recovery, mobile details/focus checks and direct fixture-database inspection establish this scope. Legacy descriptor/time gaps remain visible. See the dated verification entry for evidence and pending release gates.

M2.2/M3.1/M3.2/M3.7/M3.9 now record instruction versions/snapshots, notebook update times and explicit grounding mode (schema 10), and enforce context-generation boundaries during history replay. Reverting instructions or source selection cannot resurrect old model history. Unchanged settings/metadata edits preserve active work; real instruction edits cancel it and reject late completion. The 79-test suite, restart/backup/legacy migration checks and desktop/mobile browser inspection establish the documented scope. Original instructions are inspectable for recorded runs and explicitly unknown for legacy runs. Release gates remain open as listed above.

### Run diagnostics and complete plan inventory, 2026-10-10

M5.2/M5.7 now record selected-source count, first adapter progress, execution duration, evidence call/character counts, reached budgets and validated cumulative runtime token counts. Usage is scoped to the current runtime thread and known turns, retains repair/failure work, rejects malformed/regressing counters and strips unrelated data. Missing counts and monetary cost remain unknown. Generation details work on answers, saved notes and failed/interrupted/cancelled attempts. A browser-discovered horizontal failure-layout problem is fixed. The 81-test suite, backup restore, current typecheck/build/diff checks, a fresh native isolation check, a real two-source service run and desktop/mobile UI checks establish this scope.

The [audit](requirements-audit.md) now inventories every numbered task, spec contract/acceptance row, command and later expansion. It separates M5.5's completed named label/keyboard/layout checks from a live assistive-technology qualification. It also identifies the unverified selected-model context-capacity requirement: hard character budgets alone do not prove that relationship. M5.2 and the named human M5.6 gate remain open; the full goal remains active.

M2.8's ready status is now explicit on published source rows, with a clear extraction-warning inspection prompt; desktop/mobile label, keyboard and focus checks pass. The remaining M5.2 design has a recorded protocol constraint: context-capacity notifications follow first-batch tool replies, and waiting while holding those replies did not yield earlier metadata in a bounded live probe. This evidence informs the next implementation without declaring the requirement complete.

### Selected-model context evidence, 2026-10-10

M5.2 now uses validated `ThreadTokenUsage.modelContextWindow` and current-context counters before sending tool evidence. Unknown capacity gets an immediate fixed, retryable tool error, avoiding the observed protocol dependency; permanently missing capacity fails explicitly. UTF-8 byte accounting, framing allowance and a 20% generation reserve conservatively admit serialized evidence and repair input. Charges never decrease. Cutoffs do not claim read coverage, and budget estimates remain separate from reported usage/cost. Tool contract 4 invalidates earlier replay compatibility; output contract 3 and storage schema 10 remain current.

The 85-test suite, typecheck/build/diff checks, fresh two-proposal harness, 40 grounding cases and eight Studio cases pass. Desktop/mobile replay and controlled failure fixtures verify context/unknown labels, keyboard disclosure, saved-note focus return and no horizontal overflow. [Verification](verification.md) records the exact scope and current review packet. M5.6 still requires named human judgments; the later expansion retains its dependency and acceptance-design requirements. The full user goal remains active.

### Study expansion implementation, 2026-10-10

Output contract 4 adds typed flashcards and single-choice quizzes with exact cited answer/explanation blocks and bounded, distinct item/key validation. Schema 11 captures requested counts and revision-pinned quiz attempts. Local scoring, immutable submission, explicit fresh attempts and historical attempt selection introduce no model runs. Typed exports label distractors; promotion excludes distractors/learner data and retains the original generated revision. Edits become authored text without interactive keys; purge removes affected attempts.

The 92-test suite, typecheck/build/diff checks and six supported/unanswerable/sparse real-model cases pass. Keyboard reveal/navigation, citation focus, a 4/5 controlled quiz interaction, persisted draft/history, 390px layout and actual source promotion are checked in the temporary browser fixture. The initial provider schema rejection is preserved and resolved without relaxing local uniqueness validation. This is implementation/runtime evidence; human semantic support and ambiguity acceptance remain pending.

### Study review tooling, 2026-10-10

The study evaluation now uses a preserved version-1 corpus rather than rebuilding cases from external fixture files. The original six-case result hash remains compatible. Review-format-1/rubric-1 preparation binds the full corpus/result/contract/model/runtime/count context, includes every component and full selected passages, and leaves every judgment empty. Its checker requires component coverage, atomic support/qualification/inference judgments, both clean abstentions, sufficiency judgments and one unambiguous correct key for every quiz item. The prepared packet is `.codeboom/review/2026-10-10-study-v4-rubric-v1.json`; checking it correctly refuses the missing named human review.

The suite now passes 95 tests, including altered-source/context, skipped-component, ambiguity, wrong-key, abstention, threshold and non-overwrite regressions. Typechecking and diff checking pass. Neither this tooling nor its synthetic verifier judgments pass M5.6 or study semantic acceptance. Other expansion development remains authorized and planned.

### Mind maps and data tables, 2026-10-10

The spec and TD-10/TD-12/TD-14/TD-15 define acceptance before implementation. Output contract 5 adds rooted cited map nodes and ordered cited table cells, preserving existing chat/document/study schemas and changing history compatibility. A connected scrollable map has a keyboard collapse outline; tables expose row/column headers and explicit “Not stated” cells. Typed Markdown and derived text retain labels, relationships, cells, gaps, qualifiers, inference labels and immutable provenance. Schema 11 remains sufficient; no new provider or tool permission is added.

The suite passes 103 tests with structural/refusal, exact-span/repair, export/promotion, HTTP idempotency, type-preserving retry, backup/edit/purge and late-publication coverage for the new kinds. Typecheck/build/diff checks pass. Eight real cases have valid outputs and pass the separate hash-bound recheck. Initial sparse flags are retained; the checker removes an unnecessary generic-warning predicate when the requested single fact is complete or missing cells are already explicitly labeled. Browser fixtures verify connected branches, keyboard collapse/citation focus, semantic headers, insufficient evidence and 390px containment; an 11-node/two-proposal live-output replay renders correctly. Temporary browser/server/data/scripts were cleaned up. Named human semantic acceptance, M5.6 and other expansions remain open; the full objective stays active.

### Office/delimited import implementation, 2026-10-10

The spec §4 criteria and TD-17 implications now have a local DOCX/PPTX/XLSX/CSV/TSV implementation. Bounded in-memory ZIP/XML/text parsers use the existing isolated worker, immutable source publication, retries/duplicates, revision-scoped citations, backup and purge. Extraction version 3 preserves old stored revisions. The 117-test suite, typecheck/build, browser picker/focus/mobile checks and one preserved five-source Codex comparison are recorded in verification. Human authoring-tool fidelity and semantic/release acceptance remain pending. Legacy/macro/encrypted Office, OCR/media/YouTube/Drive and the other planned expansions remain in scope. Every original numbered task and M5.6 threshold is retained.


### Notebook organization implementation, 2026-10-10

Tags, versioned reusable templates and authenticated cross-notebook discovery now have specification/decision criteria and a local implementation. Schema 12 adds metadata, immutable recipe snapshots and atomic note FTS indexing. Searches cover current source text and available notes, exclude removed/stale/purged generated material and open the owning scoped viewer without changing evidence selection or invoking a model. Templates create one empty conversation with no copied evidence; stale versions and built-in mutations are refused.

The 123-test suite, strict typecheck, production build and diff checks pass. Genuine schema-11 migration, schema-3 restore, backup/restart, purge/index updates, session protection and unchanged foreign evidence refusal are covered. Browser checks cover tags/archives, passage/note opening, template creation/edit/instantiation, snapshot independence, keyboard focus and 390px containment, including maximum valid name/question lengths. The saved preview is `.codeboom/notebook-library-preview.jpg`. Rich note editing/publishing and all other unimplemented expansions remain in scope; M5.6 remains unchecked and the goal stays active.


### Rich note editing implementation, 2026-10-10

The spec and TD acceptance/design preceded implementation. A pinned, local, lazy-loaded visual editor provides headings, emphasis, nested lists, quotes, code, explicit links, undo/redo and exact inline notebook references. Version-1 structured notes are independently validated for allowed nodes/marks/links, Unicode spans and text/node/depth/JSON budgets. Generated conversion retains labels, citations, inference/gap/coverage qualifications and immutable originals. Authored revisions explicitly avoid implying semantic revalidation.

Notebook-scoped history supports inspection, pagination, historical export and restoration into a new authored revision. Stale saves retain the unsaved draft and require explicit reload to replace it. Search, promotion ancestry, restart/backup and purge remain integrated; missing inherited references are labeled unavailable and cannot be forged into new notes or promoted. Quiz keys/attempts remain pinned to the generated original.

Clean `npm ci`, strict typecheck, production build, diff checks and 131 tests pass. Eight rich-note groups, extended HTTP and real desktop/mobile interaction checks are recorded in verification. Initial broad-selection citation formatting was caught in the browser and fixed with a regression; 390px containment, selected links, plain paste, source focus, history/restoration and concurrent-edit recovery pass. The saved editor/history/unavailable previews remain under ignored `.codeboom/`; temporary server/tab/data/scripts are cleaned up. Output/tool/extraction/storage versions remain 5/4/3/12. Publishing and the other remaining expansions, M5.6 and named human release gates remain open; the full objective stays active.


### OCR import implementation, 2026-10-10

The spec's OCR criteria and TD design preceded implementation. Uploaded PNG/JPEG/static WebP and scanned/mixed PDFs use pinned local Tesseract WASM, bundled English language data and bounded native canvas rendering inside the existing worker. Original bytes and exact normalized text survive the existing immutable storage, citation, duplicate, backup and purge lifecycle. Mixed pages retain native text and OCR separately; warnings disclose repetition, page confidence and fidelity limits. White pages are explicitly labeled; nonblank unusable pages, parser recoveries, malformed/animated inputs and budget/deadline failures publish no partial revision. Snapshot downloads are scoped, integrity checked and served as attachments, including historical originals.

Clean installation, strict typecheck, production build, diff checking and 137 tests pass. Six OCR groups and extended HTTP coverage verify recognition, limits, offline execution, completed worker termination, spans and lifecycle; actual desktop/mobile uploads, failed retry, original download and focus/layout checks are recorded in verification. The preserved two-case live Codex result validates four exact spans across two OCR reports and abstention for missing final-approval evidence. Extraction version is 4; output/tool/storage stay 5/4/12 and old revisions remain unchanged. General scan/photo, language and semantic/release qualification remains open. Publishing, all other remaining expansions and M5.6 stay in scope; the full goal remains active.

### Audio transcription foundations, 2026-10-10

The fixed English model catalog and atomic explicit setup are implemented and verified with a real public download followed by an offline idempotent verification. Internal helpers validate WAV PCM, downmix/normalize with warnings, resample with anti-aliasing, enforce duration/channel/sample budgets, run local quantized CPU recognition and reject incomplete/mismatched timestamped transcripts. MP3/ADTS/FLAC/Ogg preflight validates real synthetic recording frames/pages/checksums and refusal cases. Eleven new deterministic groups bring the full regression suite to 148 passing tests; typecheck/build/diff checks pass. A preserved offline direct-helper probe recognizes one short example and three excerpts separated by pauses over 45 seconds, with zero intercepted network attempts. These foundations do not complete the audio import expansion: compressed decoder startup/gapless/rate behavior, bounded M4A parsing, worker cancellation/native resource qualification, application/API/UI/lifecycle evidence and human listening review remain to implement or qualify. Public audio uploads remain unsupported. Other expansion items and M5.6 remain in scope; the full objective stays active.

### Enabled audio import implementation, 2026-10-10

The audio criteria now have an enabled local English adapter for WAV/MP3/AAC-LC M4A/ADTS/FLAC/Ogg Vorbis/Opus, complete bounded decoding/container validation, estimated transcript locators and immutable warnings/model/original provenance. Extraction version 5 preserves historical revisions. Missing assets direct users to the fixed explicit installer; imports and default tests never download models. AAC distinguishes actual packet errors from priming, MP3 validates gapless metadata and M4A admits only complete self-contained supported timelines.

Native Worker probes revealed retained ONNX memory. A design correction moves audio into one fixed disposable Node process, with no shell or nested inference/decoder subprocess; extraction waits for exit before releasing capacity. Clean installation, typecheck/build/diff checks and **159 tests** pass. The preserved nineteen-process guarded check covers all seven fixtures, separated speech across windows, native-token cancellation, parent disconnect, deadlines and four concurrent batches; every process exits. Parent RSS stays near 88 MB in those batches; individual child/native memory remains substantial and has no measured hard cap.

The actual browser/provider record verifies eight exact spans for two recordings and missing-approval abstention, real file uploads, failed/corrected linked retry, duplicate reuse, integrity-checked original download, keyboard focus and 390px containment. Mocked deterministic lifecycle tests are explicitly separate from actual ASR evidence. [Verification](verification.md) records raw results and limitations. Human listening/timestamp/representative-input acceptance, sustained load, decoder distribution licensing and all named semantic gates remain open. Publishing, YouTube/Drive, generated media, explicit research policy, hosting/accounts/sharing/collaboration/connector sync and the rest of the original plan remain in scope; the objective stays active.

### Personal-note voice input implementation, 2026-10-10

Following the user's clarification, generated audio is disabled by default and removed from normal Studio/note controls. Voice input is available directly in new/edit note drafts without requiring any source selection. The initial implementation uses a fixed silent-output AudioWorklet, bounded mono PCM WAV capture, explicit stop/cancel, transient installed local English recognition, editable wording review, literal insertion at the captured editor position and explicit note saving. Permission cancellation stops any late-granted tracks; recognition shares bounded native capacity with imports and does not publish sources, jobs, blobs or automatic note revisions. Verification records 180 passing tests, actual synthetic local recognition, session/scope/cleanup checks and desktop/mobile permission-cancel previews. Real microphone capture and full recognized-review/insertion/save interaction remain unverified. The complete goal remains active with this corrected priority.

Voice-input hardening now handles disconnected microphones, recorder failures and stalled startup, preserves reviewed words when insertion fails, and clears failed transient jobs immediately. Eleven added deterministic capture/component groups bring the regression suite to **191 passing tests**, with typecheck/build/diff checks passing. Late microphone grants and upload responses after cancellation cannot restore an abandoned recording or overwrite a newer one. Hardware and the full real-browser dictation flow remain to qualify; generated audio remains deferred.

The real editor/service/storage integration and a native-recognizer replay caught unwanted paragraph splitting. Dictation now joins timestamp sections with spaces and inserts reviewed schema text inline, preserving the captured cursor, surrounding block structure and reviewed line breaks. The corrected native result records unchanged storage until explicit Save, then one authored note/revision and zero remaining transient recognizers. Two added groups bring regression to **193 passing tests**; typecheck/build/diff checks pass. Actual microphone/full-browser listening qualification remains open; generated audio stays deferred and the original goal retains its remaining planned work and human gates.

Personal-note draft protection now prevents accidental Close/Escape loss, preserves drafts after save failures and refuses closing during a pending explicit save. Undo/title reversion clears protection by serialized content; voice startup/review also counts as unfinished work. Browser checks caught and corrected editor-body Escape delivery and identity-sensitive undo detection. Legacy/reviewed line breaks use explicit editor break nodes so real typing and Save preserve them. Five added groups bring regression to **198 passing tests**, with typecheck/build/diff and actual desktop/mobile/explicit-save evidence recorded in verification. Drafts remain in memory, generated audio remains deferred, and the complete objective retains its remaining expansions and human gates.

Voice cancellation now works by recording request key before the upload response arrives. The client aborts pending upload, cancels with a small keepalive request and stops capture/review on pagehide/unmount. Bounded owner-scoped server markers reject late uploads/retries and reserve cancellation space for admitted jobs. A real HTTP partial-body race passes; installed native recognition cancels after a generated token and settles in 12.561 ms with zero storage/blob effects. Five added groups bring regression to **203 passing tests**, with typecheck/build/diff checks passing. Actual hardware/browser-exit delivery remains unverified; generated audio is deferred, and the original planned expansions/human release gates remain open.

Portable formatted HTML export now preserves the displayed immutable saved/historical revision, rich formatting, all existing typed outputs, qualifiers and exact readable references, with safe escaping/no scripts or remote assets and explicit download only. Four groups and extended authenticated HTTP checks bring regression to **207 passing tests**; typecheck/build/diff and actual download/desktop/mobile/keyboard observations pass. No stored revision or model run is added. Print CSS is inspected; native print pagination, broader assistive-technology acceptance, provider publishing and original human/expansion gates remain open. The user's follow-up describes voice interaction with notes; the next priority includes questions about existing notes as well as dictation, with spoken output still deferred. At that checkpoint the question interaction was not yet implemented; the following checkpoint records its implementation and remaining qualification.

### Saved-note voice question implementation, 2026-10-10

The user clarified voice interaction with notes. The question composer now reuses transient local capture/recognition with editable review, literal cursor insertion and explicit Send. “Ask about this note” retains/reuses the displayed revision as one derived source and opens its pinned conversation without changing other selections or interrupting existing runs. Schema 14 preserves ownership across restart/backup; note edits/imports cannot change that selection, while unavailable references, empty/foreign/purged snapshots and refresh/selection changes fail visibly.

Five groups and extended HTTP coverage bring regression to **212 passing tests**, with typecheck/build/diff checks passing. A preserved actual browser/model record verifies an explicitly typed question about one synthetic note, exact cited budget/venue wording, zero automatic runs, snapshot reuse and desktop/mobile permission-cancel/controls/focus. The voice review/insertion flow has deterministic capture tests; actual microphone/listening/full hardware spoken-question acceptance remains open. Written answers remain the default, generated audio stays deferred, and all original expansions and named human release gates remain open. The overall objective is still active.

### Latest priority and verification checkpoint, 2026-10-10

The user explicitly limits voice interaction to **questions about existing notes only** and defers YouTube. Remove note-editor recording and ordinary-source recording; keep capture only in saved-note conversations, with local recognition, transcript review, explicit Insert/Send and written answers. Remove the experimental YouTube adapter and flag. Earlier dictation/video groundwork is historical evidence, not a required current workflow or a completed expansion. Generated audio remains deferred.

Uploaded SRT/WebVTT file parsing has bounded deterministic/isolated extraction, retained originals/timing/labels/overlaps, scoped lifecycle and API checks. Extraction version is 6. Current regression is **216 passing tests**, with typecheck/build/diff checks. Actual desktop/mobile UI verification and cleanup are recorded in [verification](verification.md); microphone-to-answer/listening acceptance remains pending. Original named release gates and the broader plan remain recorded and are not claimed complete.

Latest clarification: voice dictation supplies the user’s question text instead of typing. **Dictate question** and its local-transcription help now make that input role explicit. Ten existing capture/question groups, typecheck/build and desktop/mobile browser labels pass; microphone/listening and the overall remaining plan stay open.

### Google Drive retrieval checkpoint, 2026-10-10

Drive expansion now has spec acceptance criteria and a technical decision. Its server-only retrieval layer validates explicit selected links/IDs, permission/type/provider versions, bounds fixed API requests, refuses credential-forwarding redirects, verifies binary size/checksum and brackets native exports with metadata checks. Docs/Sheets/Slides reuse the existing isolated Office parsers. Seven controlled groups and an actual synthetic-token 401 probe pass; full regression is 223/223 and final focused refinements/typecheck/build/diff checks pass.

This advances the planned Drive import implementation but does not complete it: explicit OAuth connection/disconnect, source publication/provenance migration, API/UI import/refresh/retry and actual authenticated-file qualification remain. No user account is implicitly reused from Codex. Generated audio and YouTube stay deferred, hardware voice-question and named human release acceptance remain open, and the full objective is active.


### Drive account and notebook integration checkpoint, 2026-10-10

Superseded scope note: cloud hosting/team features were subsequently deferred by the user. The historical implementation evidence below remains valid.

Explicit macOS connection/disconnect, external-browser Desktop OAuth/state/S256, private Keychain persistence and serialized refresh are implemented. The app now has connection controls and selected-file link/ID imports through the existing worker/publication boundaries. Storage schema 15 retains allowlisted provider metadata per immutable revision; provider-version changes produce new revisions even when bytes are identical. Refresh/retry, duplicates, historical evidence, matching export downloads, restart/backup/purge and disconnect cancellation have controlled coverage.

[Integration evidence](../evals/results/2026-10-10-drive-integration-v1.json) records 239 passing tests, native synthetic Keychain lifecycle, actual invalid-client token-endpoint 401 and seeded desktop/mobile UI. Real Google account consent and selected-file end-to-end qualification remain pending; this checkpoint does not close full Drive acceptance or human release gates. Sharing-key re-entry is an explicit limitation. Publishing, remaining research/media workflows, hosting/accounts/sharing/collaboration/sync and every original unfinished requirement remain in scope. Generated audio and YouTube are deferred; the full goal remains active.
