# Codeboom technical decisions

Status: First prototype implemented; release qualification remains open. See [verification evidence](verification.md).  
Scope: Technical choices for the first release defined in [the specification](spec.md).  
Delivery: [Implementation plan](../plan.md).

This document is the authority for Codeboom's architecture, technology choices, interfaces, data rules, and operational behavior. It also owns unresolved technical questions and the evidence required to settle them.

The [intent](../intent.md) owns purpose. The spec owns product requirements and release acceptance criteria. The plan owns work order. Technical descriptions elsewhere are context; change this record first when an implementation choice changes. A technical choice cannot silently weaken a requirement: update the spec and its acceptance criteria explicitly when scope changes.

## Decision process

Every material runtime, dependency, data, API, security, or deployment choice needs a decision here. The implementer changing an area maintains its record and linked plan tasks.

Statuses:

- **Implemented**: selected and running in this prototype; only the linked checks are verified, and remaining release gates still apply.

- **Baseline**: chosen for planning from the spec; still requires implementation and verification.
- **Provisional**: preferred approach, contingent on the named proof.
- **Open**: no selection yet; evaluation and decision deadline are recorded.
- **Deferred**: outside the first release.
- **Superseded**: retained for history with a link to its replacement.

Each record includes the choice, rationale, alternatives or tradeoffs, and the condition for revisiting it. Baseline does not mean experimentally verified. Record dependency versions and compatibility evidence when selected; do not infer support from a package name or documentation example.

## Decision index

| ID | Area | Status | Delivery gate |
| --- | --- | --- | --- |
| TD-01 | Product runtime and architecture boundary | Implemented | M1 |
| TD-02 | Language, UI, tooling, and project layout | Implemented | M1.1 and M2.8 |
| TD-03 | Codex protocol and notebook tools | Implemented | M1.2–M1.7 |
| TD-04 | Authentication and model selection | Implemented | M1.2 |
| TD-05 | Runtime and tool isolation | Implemented | M1.3 |
| TD-06 | Persistence, migrations, and blob storage | Implemented | M2.1–M2.3 |
| TD-07 | Source revisions, text locations, and provenance | Implemented | M2.3–M2.5 |
| TD-08 | Extraction and URL ingestion | Implemented | M2.4–M2.6 |
| TD-09 | Retrieval and coverage | Implemented | M2.7 |
| TD-10 | Output schemas and citation validation | Implemented | M1.5 and M3.6 |
| TD-11 | Context compatibility and source selection | Implemented | M3.1–M3.2 |
| TD-12 | Run lifecycle, concurrency, and recovery | Implemented | M1.6, M3, M5.1 |
| TD-13 | Local API, events, and browser transport | Implemented | M3.3–M3.4 |
| TD-14 | UI rendering and reusable artifacts | Implemented | M2.8 and M4 |
| TD-15 | Deletion, retention, and backup | Implemented | M5.3 and M5.8 |
| TD-16 | Tests, evaluations, and diagnostics | Implemented | M1 and M5 |
| TD-17 | Dependency selections and capability evidence | Implemented | Before the consuming task |
| TD-18 | Deferred architecture | Deferred | Future scope decision |

## TD-01 Product runtime and architecture boundary

**Current implementation (2026-10-08):** The local browser/service/child-process boundary is implemented. Only macOS 26.6.2 arm64 has been exercised. No cloud hosting or desktop packaging is included.

**Choice:** A single-user browser app backed by a local service, initially supported on macOS. Codex runs the agent loop. The local service owns ingestion, storage, retrieval, citation checks, and saving outputs. The browser cannot invoke Codex or access the database directly.

**Reason:** This gives the product durable evidence and application state while reusing Codex for reasoning and tool execution. Notebook data remains recoverable independently of execution history.

**Alternatives and tradeoffs:** A workflow entirely inside Codex needs less custom UI; a hosted app enables collaboration but adds tenancy and deployment requirements. The local approach requires setup and still sends selected context to a model provider.

**Validation and revisit:** M1 must prove the local integration. Revisit if the product surface changes, local runtime restrictions prevent implementation, or hosting becomes a requirement.

## TD-02 Language, UI, tooling, and project layout

**Current implementation (2026-10-08):** Selected Node 26.10.0, npm 12.1.0, TypeScript 7.0.2, React 19.3.0, Vite 8.3.4, tsx 4.23.15, Node's built-in test runner, and Prettier 3.9.9. The service uses Node's HTTP server directly. Tests currently live in `tests/*.test.ts`; no unused framework scaffold is created.

**Choice:** Use TypeScript for the local service, adapter, and shared application contracts; React for the browser; and a supported Node release for the service. Keep one repository and one dependency lockfile. Pin the actual Node release and package manager during M1.1.

A proposed module layout, to create only as the work needs it:

```text
src/
  server/       local API, jobs, and application services
  web/          notebook interface and source viewer
  domain/       shared application types and validation contracts
  codex/        adapter and generated protocol bindings
  storage/      database access, migrations, and blobs
  ingestion/    format adapters and restricted URL fetching
  retrieval/    notebook-scoped search and passage reads
tests/
  fixtures/     redistributable source corpus
  integration/  storage, API, runtime, and recovery checks
  e2e/          user workflows
evals/          questions, rubric, and recorded results
```

**Reason:** Shared types and a single local service keep the first implementation small. Boundaries prevent the UI and storage layer from depending on Codex protocol details.

**Alternatives and tradeoffs:** Python is a viable service alternative, but a mixed-language application adds packaging and interface work. A desktop shell is deferred. The HTTP server, bundler, validation library, and test tools are recorded in TD-17.

**Validation and revisit:** M1.1 selects the minimum compatible tooling; M2.8 settles UI build tooling. Revisit if extraction or runtime requirements justify another process or language.

## TD-03 Codex protocol and notebook tools

**Current implementation (2026-10-08):** Pinned project executable `@openai/codex@0.161.0`; generated the transitive protocol bindings from that executable. The four dynamic read tools worked under the restricted profile with real model requests. Each run creates an ephemeral thread in an empty working directory and closes its app-server afterward. The run stores its thread ID for diagnostics, but never resumes it after a crash. The internal `code_mode_host` feature must stay enabled to dispatch dynamic tools; disabling it made notebook tools unavailable during the proof. No MCP fallback was needed.

**Choice:** Prefer a child `codex app-server` process over stdio behind a Codeboom adapter. Generate types from the pinned executable. The app-facing adapter exposes application operations for starting a session, running a turn, cancelling, and disposing; these names are not claims about SDK APIs.

Use the four read-only notebook tools defined in the spec. Initially evaluate dynamic tool registration and tool-call responses. Bind each call to the server-held notebook, manifest, run, and active execution context; never let a model argument select its own authority.

**Evidence:** OpenAI documents app-server for custom clients and identifies dynamic tools as experimental. Its lifecycle includes initialization, threads, turns, streamed events, and interruption. [Official app-server documentation](https://learn.chatgpt.com/docs/app-server)

**Alternatives and tradeoffs:** A scoped MCP server is the fallback if dynamic tools fail the integration proof. The Codex SDK is another integration surface, but changing to it requires checking the same capabilities rather than assuming equivalence. [Official SDK documentation](https://learn.chatgpt.com/docs/codex-sdk)

**Validation and revisit:** M1 verifies all required protocol operations and records a compatible version. The previously observed CLI version is not a support promise. Experimental changes trigger compatibility checks before upgrades; no unrestricted fallback is permitted.

## TD-04 Authentication and model selection

**Current implementation (2026-10-08):** The CLI uses its existing supported Codex sign-in; `npx codex login` is the setup path. Process-local CLI overrides enforce notebook behavior without copying auth stores or editing global configuration. Account/model discovery worked, and the runtime-reported default used for evaluation was `gpt-6.1-sol`. This is observed availability, not a fixed product requirement. The browser exposes connection status and model selection; a refresh rechecks authentication. Forced expiry/rate-limit qualification remains open.

**Choice:** Use supported Codex authentication with an application-managed runtime environment. Discover available models and retain the chosen model/provider in run provenance. Keep credentials out of the browser, source blobs, diagnostics, and Git.

**Evidence:** App-server exposes account and model discovery operations; exact supported behavior must be checked against the pinned version. [Official account and model interfaces](https://learn.chatgpt.com/docs/app-server)

**Alternatives and tradeoffs:** The integration proof must settle how supported sign-in works with isolated configuration. Do not copy a user's credential store to make isolation appear complete. An API-key setup may be offered if supported and configured by the user; it is not assumed.

**Validation and revisit:** M1.2 proves setup, expiry handling, and model discovery. No fixed model name, subscription entitlement, price, or hosted authentication policy is selected in this document.

## TD-05 Runtime and tool isolation

**Current implementation (2026-10-08):** Use the named `codeboom` permission profile with filesystem `{":minimal":"read"}` and network disabled. Disable shell/unified execution, browser/computer tools, search, apps/plugins/hooks, unrelated MCP servers, memory, multi-agent features, host skills and project instructions. Verify effective configuration and thread permission/instruction metadata before passing notebook data. Native macOS checks denied unrelated canary reads, writes, and a reachable network endpoint. Authentication/inference traffic belongs to the trusted app-server client; the sandbox constrains agent execution, not the provider connection. First config discovery receives no source material, then a restarted process explicitly disables discovered MCP servers. Unsupported configuration keys or enforcement failures reject the connection.

**Choice:** Agent access is limited to notebook read tools and the minimum runtime resources needed for inference. No access to unrelated repository files, home content, global plugins, unrelated instructions, arbitrary network destinations, or direct notebook writes.

**Reason:** Imported documents are untrusted data. A read-only filesystem setting does not by itself establish the required read boundary. Application-level source checks and runtime restrictions protect different surfaces.

**Alternatives and tradeoffs:** Use supported restricted-read controls, explicit tool configuration, and a controlled environment where the selected runtime can enforce them. If that cannot meet the spec, evaluate a stronger execution boundary. Neither prompt-only rules nor unrestricted execution satisfy the requirement.

**Validation and revisit:** M1.3 must demonstrate denied access with synthetic adversarial inputs and inspect effective loaded capabilities. Record exact controls and OS coverage. The recorded macOS proof qualifies the prototype; reassess after runtime or platform changes.

## TD-06 Persistence, migrations, and blob storage

**Current implementation (2026-10-08):** Selected built-in `node:sqlite` `DatabaseSync` on the tested Node release, FTS5, WAL, foreign keys, a five-second busy timeout, and secure deletion of database cells. Schema migrations 1–3 cover base tables, normalized hashes/output provenance, and revision origins/runtime diagnostics. Extracted section text and passages are stored in SQLite; original bytes are private-mode blob files. A staged file is renamed before the metadata transaction, and unreferenced final/staged blobs are reconciled on startup. A data-root PID lock prevents normal concurrent service starts.

**Choice:** SQLite is the canonical store for notebooks, revisions, passages, conversations, runs, messages, artifacts, jobs, and application events. Store original bytes and immutable extracted text as blobs under a configurable data root, outside tracked code. Development may use ignored `.codeboom/`.

Use foreign keys, explicit notebook scoping, versioned migrations, and transactional publication. Stage blobs, verify content hashes, then publish their references with metadata; reconcile orphaned staged files after a crash. Database and filesystem changes do not form one atomic transaction.

**Reason:** One local database fits single-user operation and supports a durable queue and retrieval index without additional services.

**Alternatives and tradeoffs:** An external database or object store becomes relevant for hosted use. The chosen built-in SQLite driver is recorded above. Generated protocol data must not become the canonical product schema.

**Validation and revisit:** M2 verifies crash recovery and migration behavior. M5 verifies backup restoration. Select transaction/concurrency settings with the chosen driver; do not assume a copy of a live database file is a complete backup.

## TD-07 Source revisions, text locations, and provenance

**Current implementation (2026-10-08):** Normalize line endings and NFC deterministically. Store original-byte and normalized-section hashes, extraction version, revision-specific origin URL, and immutable passages. Passage offsets are within a normalized section; citation offsets are within the referenced passage. A section index disambiguates repeated headings. The viewer labels historical revisions explicitly. Refresh does not change historical quote text or revision origins.

**Choice:** A source has a stable identity and immutable revisions. Each revision includes original and normalized content hashes, extraction/normalization version, provenance, and quality warnings. Refreshes publish a new current revision without rewriting old citations.

Define canonical passage offsets as zero-based, half-open Unicode code-point ranges in the stored normalized text. Compute and validate slices using that convention; convert to browser string positions explicitly. Never assume JavaScript UTF-16 indexes are code-point indexes. Include PDF page or heading/paragraph locators for display.

**Reason:** Immutable evidence keeps historical citations reproducible. An explicit offset convention prevents Unicode mismatches between extraction, storage, and rendering.

**Alternatives and tradeoffs:** UTF-8 byte or UTF-16 offsets are possible, but require a single convention across all components. Code-point offsets require explicit conversion in the viewer and tests for combining characters and emoji.

**Validation and revisit:** M2.3–M2.5 test round trips and repeated passages. Changing normalization or offset semantics creates a new revision/schema version; do not mutate historical text.

## TD-08 Extraction and URL ingestion

**Current implementation (2026-10-08):** Selected PDF.js 6.4.299, Readability 0.6.0, JSDOM 30.1.2, and ipaddr.js 2.5.0. Extraction runs in a Worker with a 30-second deadline and a 256-MiB old-generation limit; this is resource isolation, not a separate OS security sandbox. HTML scripts/subresources do not run. Any PDF page without extractable text causes import failure, including otherwise legitimate blank pages. Fetching pins a validated public DNS address, checks every redirect, permits standard HTTP(S) ports, caps four redirects/25 MiB, and applies a 20-second overall deadline. Compressed responses are rejected. Public fetch and private-address tests passed; broad hostile parser/redirect testing remains open.

**Choice:** Deterministic adapters handle TXT, Markdown, pasted text, text PDFs, public HTML, and direct PDF URLs. Preserve page/section boundaries. Extraction reports incomplete or unusable text; OCR and authenticated imports are outside first-release scope.

The trusted ingestion service fetches user-supplied URLs, separately from the agent. Permit public HTTP(S) destinations only; validate resolved addresses and each redirect, enforce byte/time limits, and connect to the validated destination to avoid a DNS validation-to-connection race. Do not execute page scripts or crawl nested links.

**Reason:** Repeatable text supports reliable citations, and a controlled fetcher prevents imported URLs from accessing private services.

**Alternatives and tradeoffs:** Model-assisted extraction and OCR may improve later format coverage but add provenance and evaluation requirements. HTML main-content extraction can omit relevant material; preserve the original snapshot and expose extraction warnings.

**Validation and revisit:** M2 evaluates parser candidates, layout fidelity, malicious inputs, redirect handling, and actual connection behavior. Exact libraries and timeout defaults are owned by TD-17 before implementation.

## TD-09 Retrieval and coverage

**Current implementation (2026-10-08):** FTS5 lexical retrieval is restricted in SQL by selected revision IDs and checked again against the run manifest. Chunks are 1,600 Unicode code points with 200 overlap. Section order follows extraction/insertion order. Reads may include one neighbor on each side from the same selected revision. Section enumeration returns up to eight passages; search up to twelve. Defaults are 20 tool calls and 200,000 returned evidence characters per run, both configurable. Unread passage counts are appended as coverage warnings. No embeddings or automatic claim-support verifier is used.

**Choice:** Start with SQLite full-text search and bounded iterative reading. Every lookup is constrained to the immutable manifest held by the service. Expose search, passage reads, selected-source listing, and paginated section enumeration.

For broad summaries, maintain coverage over selected sources and their sections. Report omissions when a budget prevents complete coverage. An ordered inventory is distinct from relevance-ranked search.

**Reason:** This is a measurable baseline without another index service or embedding provider.

**Alternatives and tradeoffs:** Lexical retrieval can miss semantic matches. Evaluate embeddings or reranking against recorded retrieval failures before adopting them. Revalidate notebook scoping for any new index.

**Validation and revisit:** M2.7 tests exact, paraphrased, and cross-source questions. M5 records retrieval misses separately from generation errors. Ranking, chunk size, overlap, and tokenizer settings are selected against fixtures and recorded in TD-17.

## TD-10 Output schemas and citation validation

**Current implementation (2026-10-08):** Ajv 8.20.0 validates output contract v1. Answers have factual, inferred, or notice blocks and exact quotes; factual/inferred blocks require citations. One model repair turn is allowed. After a failed evaluation, repair gained exact location hints only when the existing quote occurs uniquely in the same selected passage. No quote is silently substituted, and repaired output must pass the original validator. Human semantic review remains required.

**Choice:** Version the application output contract. Answers contain status, typed blocks, citation records, and coverage warnings; artifacts add their kind and sections. Generate display citation labels in the application.

Resolve references through stored IDs, selected revisions, exact evidence spans, and supporting output blocks. Reject invalid references before completing an output. Allow one bounded citation repair attempt using the same source manifest; never repair by substituting unrelated evidence.

**Reason:** Structured validation prevents fabricated locations and separates citation integrity from semantic support. Exact evidence matches do not prove an answer's interpretation is correct.

**Alternatives and tradeoffs:** Free-form Markdown with model-written URLs is simpler to generate but weaker to validate. A semantic verifier may later supplement human evaluation; it must not be represented as a truth guarantee.

**Validation and revisit:** M1.5 proves the minimal schema and validator; M3 adds integration coverage. Human support and abstention targets remain those in the spec. Schema evolution requires version handling for saved outputs.

## TD-11 Context compatibility and source selection

**Current implementation (2026-10-08):** Always create a fresh ephemeral execution thread. Replay only the last eight completed message records from the same conversation with the same context key. The key includes selected revision IDs, notebook instructions, output contract v1, tool contract v2, and source-only mode; conversation/database scoping supplies the notebook boundary. Selection/refresh/removal/instruction changes invalidate the notebook generation and cancel active runs. Visible history remains, while incompatible history is excluded from new model requests. A live deselection test abstained correctly.

**Choice:** Product conversation history lives in SQLite. Codex execution context is replaceable. Compute a compatibility identity from the notebook, sorted selected revision IDs, notebook instruction version, grounding mode, and relevant prompt/tool contract version.

Only resume a compatible context. After a relevant change, start a fresh context without old generated answers or source excerpts. Keep old messages visible; ambiguous follow-ups require clarification. Notes become evidence only after explicit promotion with derivation links.

**Reason:** Retrieval filtering alone cannot remove excluded evidence already present in model context or a compacted history.

**Alternatives and tradeoffs:** Reusing context with a warning is cheaper but does not meet the selected-source requirement. Fresh contexts can lose conversational convenience and increase requests.

**Validation and revisit:** M3 tests selection, refresh, removal, instruction edits, context reconstruction, and source leakage. Version the compatibility rule and invalidate contexts when its meaning changes.

## TD-12 Run lifecycle, concurrency, and recovery

**Current implementation (2026-10-08):** Persist queued/running/validating/completed/failed/cancelled/interrupted states, idempotency keys, retry links, manifest, generation, actual model, runtime version/thread ID, and bounded tool statistics. Admission is immediate with a two-active-run cap; there is no backlog beyond admitted requests. One active run per conversation is enforced by a partial unique index. Default deadlines are 120 seconds for chat and 300 seconds for Studio, including connection setup. Cancellation closes the child and guards publication; restarts mark unresolved work interrupted and require explicit retry. Provider usage remains null/unknown.

**Choice:** Persist runs with explicit states: queued, running, validating, completed, failed, cancelled, or interrupted. Use a bounded local queue and one active run per conversation. Record an idempotency key and a context generation for every request.

Source or instruction mutation invalidates the active context generation and cancels affected runs. The completion transaction checks both run state and generation before saving an output. Cancellation wins once recorded, even if a late Codex event arrives.

For crashes or ambiguous transport failures, reconcile known execution state before retrying. Keep unresolved outcomes interrupted; do not automatically repeat model work. Retry attempts retain a link to the original and cannot overwrite a completed artifact.

**Reason:** Persistent state handles stop/completion races and browser reconnects without relying on exactly-once model execution.

**Alternatives and tradeoffs:** An external queue is deferred. Local processing still needs recovery and backpressure. Cancellation may not immediately stop provider work, but it must immediately prevent future output publication from that run.

**Validation and revisit:** M1.6 and M3 test races; M5 tests crashes and deadlines. Initial configurable targets follow the spec: 20 retrieval calls, 120 seconds per chat turn, and 5 minutes per artifact job. Select global queue capacity and context budgets in TD-17.

## TD-13 Local API, events, and browser transport

**Current implementation (2026-10-08):** Node HTTP serves a Vite build and JSON API on `127.0.0.1:4317`. A random per-boot HttpOnly SameSite=Strict cookie protects the API, with exact Host/Origin checks and cross-site fetch rejection. Mutations require the same Origin. SSE events have database sequence numbers and replay from Last-Event-ID; browser reload attaches to existing runs. Only generic progress/tool labels are streamed; draft answer text is not published before validation. Events remain until source purge or notebook deletion; no separate time-based expiration policy is implemented.

**Choice:** Serve a same-origin browser app and API on loopback. Require a local session credential, validate origins, and protect mutations against cross-site requests. Keep provider credentials server-side.

Use ordinary HTTP for application actions and server-sent events for progress. Persist application-assigned sequence numbers, event/run IDs, and sanitized event payloads. Reconnection replays from an event cursor or returns current state when replay data has expired.

**Reason:** The browser needs a stable product API and ordered recovery semantics independently of the Codex wire protocol.

**Alternatives and tradeoffs:** WebSockets may be useful for future bidirectional collaboration, but first-release actions do not require them. Native browser EventSource cannot send arbitrary authorization headers; choose a protected same-origin cookie flow or authenticated fetch streaming in M3.3. Never put a long-lived session secret in a stream URL.

**Validation and revisit:** M3 settles the HTTP framework, credential transport, streaming client, replay retention, and error contract. Test unauthorized requests, duplicates, out-of-order upstream notifications, reconnect, and expired cursors.

## TD-14 UI rendering and reusable artifacts

**Current implementation (2026-10-08):** React renders imported and generated content as plain text, with application-generated citation buttons and native modal dialogs. The narrow editor is a textarea. Editing marks the entire note user-authored and retains the prior immutable generated revision; it does not preserve automatic verification claims on edited text. Promotion is explicit and propagates derivation metadata to evidence tools. Summary, briefing, study guide, and FAQ use the same output validator. Markdown exports retain quote, title, immutable revision, locator, and revision-specific origin.

**Choice:** Present sources, conversation, and notes/Studio as three areas, with tabs at smaller sizes. Render typed answer blocks and sanitized document content. Never execute model-produced HTML or imported scripts.

Use one artifact model for manual notes, saved answers, and Studio documents, with immutable revisions, authorship, source manifest, and provenance. An edited block becomes user-authored and loses any implication of automatic support verification. Export Markdown with readable citation footnotes.

**Reason:** Shared provenance avoids implementing separate evidence behavior for each output type.

**Alternatives and tradeoffs:** A rich-text editor may improve later usability but complicates location and citation editing. The initial plain-text renderer and textarea editor are recorded in TD-17.

**Validation and revisit:** M2 and M4 verify safe rendering, citation focus return, edits, note promotion, exports, and restart. Add media-specific rendering only after its source/script contract is specified.

## TD-15 Deletion, retention, and backup

**Current implementation (2026-10-08):** Source removal excludes future runs while retaining citations. Purge clears managed passages/FTS, original blobs, generated message/answer copies, generated artifact revisions, and promoted descendants; edited notes remain. SQLite secure_delete plus a WAL checkpoint reduces retained logical database copies, without promising physical-media erasure. Ephemeral Codex threads avoid durable application-managed execution transcripts. Provider requests, user exports, backups, and independently managed Codex/account data are outside product deletion. The backup CLI requires a stopped service, checkpoints SQLite, hashes all files, and restores only into a new directory after schema/hash/integrity checks. Restore qualification passed.

**Choice:** Distinguish removal from purge. Removal excludes a source from future runs while retaining historical evidence. Purge deletes managed local source content and invalidates related execution contexts; affected historical references become unavailable.

Purge must account for copied evidence in tool transcripts, answer citation quotes, artifact revisions, caches, and replayable events. Remove managed verbatim evidence copies and mark affected outputs as needing review or unavailable. Preserve user-authored notes unless notebook deletion or explicit user deletion includes them; do not claim that arbitrary paraphrases or user copies have been erased.

Notebook deletion removes its managed records and blobs and cleans up managed Codex sessions. Report partial cleanup instead of declaring success. Exports, existing backups, and prior provider requests are outside automatic deletion; document those boundaries.

Back up a consistent database snapshot and referenced blobs with a versioned manifest. Restoration verifies schema compatibility and content hashes.

**Reason:** Deleting the original file alone leaves copies in other storage surfaces. Precise retention rules preserve honest citations and protect user-authored work.

**Alternatives and tradeoffs:** Complete erasure from external systems cannot be promised. Retaining historical evidence uses more storage; purging it reduces reproducibility.

**Validation and revisit:** M5.3 inventories every managed copy location and tests interrupted cleanup. M5.8 proves restoration. Revisit before introducing connectors, sharing, new caches, or hosting.

## TD-16 Tests, evaluations, and diagnostics

**Current implementation (2026-10-08):** Twenty-four deterministic tests cover storage, ingestion, boundaries, API, backup, transport failure, and repair behavior. Real harness/native sandbox/browser checks are recorded in `verification.md`. The fixed 40-question run completed 39 outputs with exact citations, including 10/10 abstentions; one citation failure was rejected, then passed a targeted rerun after repair hints were added. No human semantic-review pass is claimed. Routine runtime events omit raw sources and credentials; synthetic evaluation artifacts intentionally contain their redistributable fixture text.

**Choice:** Keep deterministic integration checks separate from model-quality evaluations. Use synthetic or redistributable fixtures, including Unicode, conflicting sources, unanswerable questions, bad PDFs, unsafe URLs, and malicious document instructions.

Test evidence boundaries, transactions, migration/recovery behavior, cancellation races, citations, and end-to-end user workflows. Use the spec's human-review thresholds for semantic support and abstention.

Log structured run IDs, timings, source counts, selected runtime/model version, error categories, and usage when available. Routine logs exclude raw source text and credentials. Treat missing usage as unknown; do not invent cost.

**Reason:** A schema-valid answer can still misrepresent its sources. Separate measures make retrieval, runtime, and answer-quality failures diagnosable.

**Alternatives and tradeoffs:** Broad snapshot tests can pass while missing boundary failures. Use targeted behavioral checks and a small end-to-end set. Real provider tests need a configured account and a recorded execution budget.

**Validation and revisit:** Select test/evaluation tooling in M1.1 and record a performance baseline in M5. Upgrades affecting extraction, retrieval, prompts, models, or the harness require the relevant regression and evaluation checks.

## TD-17 Dependency selections and capability evidence

Selections are recorded below and in each implementation entry above. The package lockfile is authoritative for dependency versions; [verification.md](verification.md) records actual compatibility evidence and remaining qualification work.

| Selection | Chosen implementation | Evidence / limits |
| --- | --- | --- |
| Runtime and tooling | Node 26.10.0; npm 12.1.0; TypeScript 7.0.2; tsx 4.23.15; Prettier 3.9.9 | Type checking, build, and deterministic tests on macOS 26.6.2 arm64 |
| Codex | @openai/codex 0.161.0; generated app-server stdio protocol; dynamic tools | Live cited comparison and named-profile native canaries; experimental protocol pinned |
| Authentication/model | Supported CLI sign-in; runtime model discovery | Live gpt-6.1-sol run; expiry/rate-limit fault tests pending |
| Storage | Node DatabaseSync + FTS5; schema v3; WAL and foreign keys | Restart, old citations, transactional publication, purge, backup restore |
| PDF | pdfjs-dist 6.4.299 | Synthetic text/empty PDF proof; complex layouts pending |
| HTML | @mozilla/readability 0.6.0 + jsdom 30.1.2 | Article extraction and script non-execution; fidelity corpus pending |
| Fetch | Node HTTP(S)/DNS + ipaddr.js 2.5.0 | Private address rejection, public fetch, destination pinning; live redirect matrix pending |
| Output validation | Ajv 8.20.0; JSON schema v1 | Exact citation/Unicode rejection tests and live structured answers |
| UI | React/react-dom 19.3.0; Vite 8.3.4; plain text and textarea editor | Browser flow, focus return, mobile tabs and export |
| Capacity | Two active runs; 20 reads; 200,000 evidence code points; 120/300-second deadlines | Configurable hard budgets; resource profiling remains open |
| Backup | Stopped-service snapshot + hash manifest; new-directory restore | Tampered evidence and active writers rejected |

Do not mark a selection settled without its evidence. If an evaluation fails, update the relevant decision and dependent plan tasks rather than introducing an undocumented substitute.

## TD-18 Deferred architecture

**Choice:** Defer vector infrastructure, cross-notebook knowledge graphs, additional import formats, speech/media providers, web-assisted research, cloud deployment, multi-user identity, collaboration, and connector synchronization.

**Reason:** Each adds a separate retrieval, provenance, permission, cost, or operational contract beyond the first-release scope.

**Validation and revisit:** Promote an area only after defining its product acceptance criteria and a technical decision covering those new boundaries. Hosting must revisit identity, tenancy, runtime support, authentication, network exposure, storage, and retention together.

## Decision history

| Date | Change | Evidence |
| --- | --- | --- |
| 2026-10-08 | Created the technical authority and recorded TD-01 through TD-18 | Existing specification and intent; original planning baseline |

| 2026-10-08 | Implemented TD-01–TD-17; recorded pinned dependencies, ephemeral contexts, admission cap, resource budgets, backup and quality results | [Verification evidence](verification.md); human review and broader release qualification pending |

When superseding a decision, keep its ID and rationale, mark it superseded, link the replacement, and record the migration and affected acceptance checks.
