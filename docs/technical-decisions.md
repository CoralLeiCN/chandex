# Codeboom technical decisions

Note reliability refinement (2026-10-23): schema 19 stores content-free save receipts (operation ID, notebook, request hash and resulting note ID) in the same transaction as note publication and draft closure. Exact retries return the original result before checking a closed draft or stale base revision; changed requests and cross-notebook reuse are rejected. The editor retains the exact request after an unconfirmed response and pauses editing until explicit retry resolves it. Receipts survive restart and backup; permanent deletion clears their note link and rejects replay, while notebook deletion removes them. Source promotion supplies the displayed revision and rejects a stale view before starting an import. Notebook loading applies only the latest response for the current selection, including switching away and back. Personal notes and recovery precede Studio, whose generation controls are collapsed initially.

Human-review integrity refinement (2026-10-10): the fixed grounding checker must reconstruct and compare each packet's question, expected status/answer aid and full citation/passages from the pinned corpus and result bytes. A matching result hash alone does not protect copied review context. Reject changed corpus versions, modified evidence or impossible calendar dates while preserving reviewer-entered judgments and the existing rubric/thresholds. Qualification uses temporary synthetic judgments only; the user's actual packet remains unreviewed.

Displayed Markdown revision refinement (2026-10-10): every saved-note Markdown download supplies the viewer's immutable revision ID, including the current note. The server already resolves and scopes requested revisions. This prevents an edit in another window between viewing and downloading from exporting different text; HTML/PowerPoint/PNG/SVG already supply their displayed revision. Qualification requires current/history API coverage and a live stale-view/edit/download check.

Current release-evaluation refresh (2026-10-10): retain the fixed version-1, 30-answerable/10-unanswerable corpus and human rubric. Re-run it using current contract 8/tool 4/runtime 0.161.0 rather than treating older contract-3 results as current release evidence. The evaluation command accepts an explicit new result path, refuses overwriting that path before provider calls, and exits unsuccessfully for execution, expected-status or injection-canary failures. These are automated checks; a new hash-bound review packet still needs named human judgments to satisfy M5.6.

Explicit web discovery decision (2026-10-10): use the pinned Codex app-server's built-in `web_search="live"` only for a separate query-only discovery thread. The normal adapter retains its verified disabled-search configuration. The discovery adapter verifies the same minimal read-only, OS-network-disabled permission profile and disables inherited MCP/apps/tools/skills. It accepts only bounded candidate titles and canonical public HTTP(S) URLs after a completed search protocol item; it supplies no notebook contents or dynamic tools. Candidates remain ephemeral and cannot be citations. Selected candidates go through the ordinary public URL importer, preserving dated source snapshots and source-only answer validation. Admission is bounded with no queue; cancellation, notebook deletion and shutdown suppress late results and runtime process settlement retains admission capacity. No new provider credentials or persistent search history are introduced. The live/disabled distinction follows [official Codex configuration guidance](https://learn.chatgpt.com/docs/config-file/config-basic#web-search-mode); the pinned runtime is separately probed and verified. Bounds are two active requests with no queue, 120 seconds, eight completed searches and five candidate pages.

Consistent localhost origins (user request, 2026-10-10): the main server defaults to `127.0.0.1:40732`, preserving the user's current app address. `npm run preview` defaults to fixed port `44281` and isolated `.codeboom/preview` data. Reuse these origins for manual browser uploads/downloads and never select a new port automatically after a collision. Explicit `CODEBOOM_PORT` overrides remain supported; concurrent API tests retain ephemeral ports. Codex network approval destinations include the port, per [official approval documentation](https://learn.chatgpt.com/docs/app-server#command-execution-approvals); consistency reduces destination changes but does not disable sandbox approval boundaries.

Infographic decision (2026-10-10): output contract 8 adds a typed card layout with block-index ownership. The model supplies cited content only; the application owns all geometry, colors and typography. Fixed cards/comparison/steps templates avoid unsupported scales and totals. A steps layout requires an additional factual order block whose exact references pass ordinary evidence validation. Native Canvas measures/draws PNG; SVG uses only escaped metadata, rectangles, lines and text from the same bounded layout. No remote assets, font paths, scripts, links or foreignObject are accepted. Export is capped at 1200×4000 pixels, one MiB input/provenance, two MiB SVG and eight MiB PNG; overflow fails instead of truncating or shrinking. PNG embeds uncompressed UTF-8 iTXt provenance with the standard separators and CRC, per [W3C PNG textual information](https://www.w3.org/TR/png-3/#11iTXt). Local exports share fixed admission and revision/purge/cancellation/shutdown checks. This is a local prototype; semantic ordering/attribution and representative font rendering require human qualification.

Export lifecycle consolidation, 2026-10-26 (retains the 2026-10-10 contract): `ArtifactExportService` owns immutable-revision capture, notebook-scoped citation/derivation resolution, two-assembly admission with no queue, post-assembly availability/active-note checks, cancellation and shutdown. `SlideExportService` and `InfographicExportService` each compose a separate instance, preserving independent capacity, public arguments, format-specific assembly and existing error messages. Cancellation and shutdown withhold bytes but retain capacity until encoding settles; shutdown waits before storage closes. Shared lifecycle code keeps these safeguards consistent across formats. Deterministic tests gate the actual writers over a real Store without timing hooks in the HTTP API. Format-specific layout and validation remain in their writers: text measurement preserves grapheme clusters and dense content that does not fit remains an explicit failure. Revisit the shared helper if another format needs a different lifecycle, rather than weakening either existing contract.

Status: First prototype implemented; release qualification remains open. See [verification evidence](verification.md).  
Scope: Technical choices for the first release defined in [the specification](spec.md).  
Delivery: [Implementation plan](plan.md).

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

**Implementation before OCR expansion (2026-10-08):** The local browser/service/child-process boundary is implemented. Only macOS 26.6.2 arm64 has been exercised. No cloud hosting or desktop packaging is included.

**Choice:** A single-user browser app backed by a local service, initially supported on macOS. Codex runs the agent loop. The local service owns ingestion, storage, retrieval, citation checks, and saving outputs. The browser cannot invoke Codex or access the database directly.

**Reason:** This gives the product durable evidence and application state while reusing Codex for reasoning and tool execution. Notebook data remains recoverable independently of execution history.

**Alternatives and tradeoffs:** A workflow entirely inside Codex needs less custom UI; a hosted app enables collaboration but adds tenancy and deployment requirements. The local approach requires setup and still sends selected context to a model provider.

**Validation and revisit:** M1 must prove the local integration. Revisit if the product surface changes, local runtime restrictions prevent implementation, or hosting becomes a requirement.

## TD-02 Language, UI, tooling, and project layout

**Implementation before OCR expansion (2026-10-08):** Selected Node 26.10.0, npm 12.1.0, TypeScript 7.0.2, React 19.3.0, Vite 8.3.4, tsx 4.23.15, Node's built-in test runner, and Prettier 3.9.9. The service uses Node's HTTP server directly. Tests currently live in `tests/*.test.ts`; no unused framework scaffold is created.

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

**Implementation before OCR expansion (2026-10-08):** Pinned project executable `@openai/codex@0.161.0`; generated the transitive protocol bindings from that executable. The four dynamic read tools worked under the restricted profile with real model requests. Each run creates an ephemeral thread in an empty working directory and closes its app-server afterward. The run stores its thread ID for diagnostics, but never resumes it after a crash. The internal `code_mode_host` feature must stay enabled to dispatch dynamic tools; disabling it made notebook tools unavailable during the proof. No MCP fallback was needed.

**Choice:** Prefer a child `codex app-server` process over stdio behind a Codeboom adapter. Generate types from the pinned executable. The app-facing adapter exposes application operations for starting a session, running a turn, cancelling, and disposing; these names are not claims about SDK APIs.

Use the four read-only notebook tools defined in the spec. Initially evaluate dynamic tool registration and tool-call responses. Bind each call to the server-held notebook, manifest, run, and active execution context; never let a model argument select its own authority.

**Evidence:** OpenAI documents app-server for custom clients and identifies dynamic tools as experimental. Its lifecycle includes initialization, threads, turns, streamed events, and interruption. [Official app-server documentation](https://learn.chatgpt.com/docs/app-server)

**Alternatives and tradeoffs:** A scoped MCP server is the fallback if dynamic tools fail the integration proof. The Codex SDK is another integration surface, but changing to it requires checking the same capabilities rather than assuming equivalence. [Official SDK documentation](https://learn.chatgpt.com/docs/codex-sdk)

**Validation and revisit:** M1 verifies all required protocol operations and records a compatible version. The previously observed CLI version is not a support promise. Experimental changes trigger compatibility checks before upgrades; no unrestricted fallback is permitted.

## TD-04 Authentication and model selection

**Implementation before OCR expansion (2026-10-08):** The CLI uses its existing supported Codex sign-in; `npx codex login` is the setup path. Process-local CLI overrides enforce notebook behavior without copying auth stores or editing global configuration. Account/model discovery worked, and the runtime-reported default used for evaluation was `gpt-6.1-sol`. This is observed availability, not a fixed product requirement. The browser exposes connection status and model selection; a refresh rechecks authentication. Forced expiry/rate-limit qualification remains open.

**Choice:** Use supported Codex authentication with an application-managed runtime environment. Discover available models and retain the chosen model/provider in run provenance. Keep credentials out of the browser, source blobs, diagnostics, and Git.

**Evidence:** App-server exposes account and model discovery operations; exact supported behavior must be checked against the pinned version. [Official account and model interfaces](https://learn.chatgpt.com/docs/app-server)

**Alternatives and tradeoffs:** The integration proof must settle how supported sign-in works with isolated configuration. Do not copy a user's credential store to make isolation appear complete. An API-key setup may be offered if supported and configured by the user; it is not assumed.

**Validation and revisit:** M1.2 proves setup, expiry handling, and model discovery. No fixed model name, subscription entitlement, price, or hosted authentication policy is selected in this document.

## TD-05 Runtime and tool isolation

**Implementation before OCR expansion (2026-10-08):** Use the named `codeboom` permission profile with filesystem `{":minimal":"read"}` and network disabled. Disable shell/unified execution, browser/computer tools, search, apps/plugins/hooks, unrelated MCP servers, memory, multi-agent features, host skills and project instructions. Verify effective configuration and thread permission/instruction metadata before passing notebook data. Native macOS checks denied unrelated canary reads, writes, and a reachable network endpoint. Authentication/inference traffic belongs to the trusted app-server client; the sandbox constrains agent execution, not the provider connection. First config discovery receives no source material, then a restarted process explicitly disables discovered MCP servers. Unsupported configuration keys or enforcement failures reject the connection.

**Choice:** Agent access is limited to notebook read tools and the minimum runtime resources needed for inference. No access to unrelated repository files, home content, global plugins, unrelated instructions, arbitrary network destinations, or direct notebook writes.

**Reason:** Imported documents are untrusted data. A read-only filesystem setting does not by itself establish the required read boundary. Application-level source checks and runtime restrictions protect different surfaces.

**Alternatives and tradeoffs:** Use supported restricted-read controls, explicit tool configuration, and a controlled environment where the selected runtime can enforce them. If that cannot meet the spec, evaluate a stronger execution boundary. Neither prompt-only rules nor unrestricted execution satisfy the requirement.

**Validation and revisit:** M1.3 must demonstrate denied access with synthetic adversarial inputs and inspect effective loaded capabilities. Record exact controls and OS coverage. The recorded macOS proof qualifies the prototype; reassess after runtime or platform changes.

## TD-06 Persistence, migrations, and blob storage

**Implementation before OCR expansion (2026-10-08):** Selected built-in `node:sqlite` `DatabaseSync` on the tested Node release, FTS5, WAL, foreign keys, a five-second busy timeout, and secure deletion of database cells. Schema migrations 1–6 cover base tables, normalized hashes/output provenance, revision origins/runtime diagnostics, generation failure categories, requested/final URL provenance and retrieval time, and unverified failure drafts. Extracted section text and passages are stored in SQLite; original bytes are private-mode blob files. A staged file is renamed before the metadata transaction, and unreferenced final/staged blobs are reconciled on startup. A data-root PID lock prevents normal concurrent service starts.

**Choice:** SQLite is the canonical store for notebooks, revisions, passages, conversations, runs, messages, artifacts, jobs, and application events. Store original bytes and immutable extracted text as blobs under a configurable data root, outside tracked code. Development may use ignored `.codeboom/`.

Use foreign keys, explicit notebook scoping, versioned migrations, and transactional publication. Stage blobs, verify content hashes, then publish their references with metadata; reconcile orphaned staged files after a crash. Database and filesystem changes do not form one atomic transaction.

**Reason:** One local database fits single-user operation and supports a durable queue and retrieval index without additional services.

**Alternatives and tradeoffs:** An external database or object store becomes relevant for hosted use. The chosen built-in SQLite driver is recorded above. Generated protocol data must not become the canonical product schema.

**Validation and revisit:** M2 verifies crash recovery and migration behavior. M5 verifies backup restoration. Select transaction/concurrency settings with the chosen driver; do not assume a copy of a live database file is a complete backup.

## TD-07 Source revisions, text locations, and provenance

**Implementation before OCR expansion (2026-10-08):** Normalize line endings and NFC deterministically. Store original-byte and normalized-section hashes, extraction version, revision-specific origin URL, and immutable passages. Passage offsets are within a normalized section; citation offsets are within the referenced passage. A section index disambiguates repeated headings. The viewer labels historical revisions explicitly. Refresh does not change historical quote text or revision origins.

**Choice:** A source has a stable identity and immutable revisions. Each revision includes original and normalized content hashes, extraction/normalization version, provenance, and quality warnings. Refreshes publish a new current revision without rewriting old citations.

Define canonical passage offsets as zero-based, half-open Unicode code-point ranges in the stored normalized text. Compute and validate slices using that convention; convert to browser string positions explicitly. Never assume JavaScript UTF-16 indexes are code-point indexes. Include PDF page or heading/paragraph locators for display.

**Reason:** Immutable evidence keeps historical citations reproducible. An explicit offset convention prevents Unicode mismatches between extraction, storage, and rendering.

**Alternatives and tradeoffs:** UTF-8 byte or UTF-16 offsets are possible, but require a single convention across all components. Code-point offsets require explicit conversion in the viewer and tests for combining characters and emoji.

**Validation and revisit:** M2.3–M2.5 test round trips and repeated passages. Changing normalization or offset semantics creates a new revision/schema version; do not mutate historical text.

## TD-08 Extraction and URL ingestion

**Implementation before OCR expansion (2026-10-08):** Selected PDF.js 6.4.299, Readability 0.6.0, JSDOM 30.1.2, and ipaddr.js 2.5.0. Extraction runs in a Worker with a 30-second deadline and a 256-MiB old-generation limit; this is resource isolation, not a separate OS security sandbox. HTML scripts/subresources do not run. Any PDF page without extractable text causes import failure, including otherwise legitimate blank pages. Fetching pins a validated public DNS address, checks every redirect, permits standard HTTP(S) ports, caps four redirects/25 MiB, and applies a 20-second overall deadline. Compressed responses are rejected. Public fetch and private-address tests passed; broad hostile parser/redirect testing remains open.

**Choice:** Deterministic adapters handle TXT, Markdown, pasted text, text PDFs, public HTML, and direct PDF URLs. Preserve page/section boundaries. Extraction reports incomplete or unusable text; OCR and authenticated imports are outside first-release scope.

The trusted ingestion service fetches user-supplied URLs, separately from the agent. Permit public HTTP(S) destinations only; validate resolved addresses and each redirect, enforce byte/time limits, and connect to the validated destination to avoid a DNS validation-to-connection race. Do not execute page scripts or crawl nested links.

**Reason:** Repeatable text supports reliable citations, and a controlled fetcher prevents imported URLs from accessing private services.

**Alternatives and tradeoffs:** Model-assisted extraction and OCR may improve later format coverage but add provenance and evaluation requirements. HTML main-content extraction can omit relevant material; preserve the original snapshot and expose extraction warnings.

**Validation and revisit:** M2 evaluates parser candidates, layout fidelity, malicious inputs, redirect handling, and actual connection behavior. Exact libraries and timeout defaults are owned by TD-17 before implementation.

## TD-09 Retrieval and coverage

**Implementation before OCR expansion (2026-10-08):** FTS5 lexical retrieval is restricted in SQL by selected revision IDs and checked again against the run manifest. Chunks are 1,600 Unicode code points with 200 overlap. Section order follows extraction/insertion order. Reads may include one neighbor on each side from the same selected revision. Section enumeration returns up to eight passages; search up to twelve. Defaults are 20 tool calls and 200,000 returned evidence characters per run, both configurable. Unread passage counts are appended as coverage warnings. No embeddings or automatic claim-support verifier is used.

**Choice:** Start with SQLite full-text search and bounded iterative reading. Every lookup is constrained to the immutable manifest held by the service. Expose search, passage reads, selected-source listing, and paginated section enumeration.

For broad summaries, maintain coverage over selected sources and their sections. Report omissions when a budget prevents complete coverage. An ordered inventory is distinct from relevance-ranked search.

**Reason:** This is a measurable baseline without another index service or embedding provider.

**Alternatives and tradeoffs:** Lexical retrieval can miss semantic matches. Evaluate embeddings or reranking against recorded retrieval failures before adopting them. Revalidate notebook scoping for any new index.

**Validation and revisit:** M2.7 tests exact, paraphrased, and cross-source questions. M5 records retrieval misses separately from generation errors. Ranking, chunk size, overlap, and tokenizer settings are selected against fixtures and recorded in TD-17.

## TD-10 Output schemas and citation validation

**Implementation before OCR expansion (2026-10-08):** Ajv 8.20.0 validates output contract v1. Answers have factual, inferred, or notice blocks and exact quotes; factual/inferred blocks require citations. One model repair turn is allowed. After a failed evaluation, repair gained exact location hints only when the existing quote occurs uniquely in the same selected passage. No quote is silently substituted, and repaired output must pass the original validator. Human semantic review remains required.

**Choice:** Version the application output contract. Answers contain status, typed blocks, citation records, and coverage warnings; artifacts add their kind and sections. Generate display citation labels in the application.

Resolve references through stored IDs, selected revisions, exact evidence spans, and supporting output blocks. Reject invalid references before completing an output. Allow one bounded citation repair attempt using the same source manifest; never repair by substituting unrelated evidence.

**Reason:** Structured validation prevents fabricated locations and separates citation integrity from semantic support. Exact evidence matches do not prove an answer's interpretation is correct.

**Alternatives and tradeoffs:** Free-form Markdown with model-written URLs is simpler to generate but weaker to validate. A semantic verifier may later supplement human evaluation; it must not be represented as a truth guarantee.

**Validation and revisit:** M1.5 proves the minimal schema and validator; M3 adds integration coverage. Human support and abstention targets remain those in the spec. Schema evolution requires version handling for saved outputs.

## TD-11 Context compatibility and source selection

**Implementation before OCR expansion (2026-10-08):** Always create a fresh ephemeral execution thread. Replay only the last eight completed message records from the same conversation with the same context key. The key includes selected revision IDs, notebook instructions, output contract v1, tool contract v3, and source-only mode; conversation/database scoping supplies the notebook boundary. Selection/refresh/removal/instruction changes invalidate the notebook generation and cancel active runs. Visible history remains, while incompatible history is excluded from new model requests. A live deselection test abstained correctly.

**Choice:** Product conversation history lives in SQLite. Codex execution context is replaceable. Compute a compatibility identity from the notebook, sorted selected revision IDs, notebook instruction version, grounding mode, and relevant prompt/tool contract version.

Only resume a compatible context. After a relevant change, start a fresh context without old generated answers or source excerpts. Keep old messages visible; ambiguous follow-ups require clarification. Notes become evidence only after explicit promotion with derivation links.

**Reason:** Retrieval filtering alone cannot remove excluded evidence already present in model context or a compacted history.

**Alternatives and tradeoffs:** Reusing context with a warning is cheaper but does not meet the selected-source requirement. Fresh contexts can lose conversational convenience and increase requests.

**Validation and revisit:** M3 tests selection, refresh, removal, instruction edits, context reconstruction, and source leakage. Version the compatibility rule and invalidate contexts when its meaning changes.

## TD-12 Run lifecycle, concurrency, and recovery

**Implementation before OCR expansion (2026-10-08):** Persist queued/running/validating/completed/failed/cancelled/interrupted states, idempotency keys, retry links, manifest, generation, actual model, runtime version/thread ID, and bounded tool statistics. Admission is immediate with a two-active-run cap; there is no backlog beyond admitted requests. One active run per conversation is enforced by a partial unique index. Default deadlines are 120 seconds for chat and 300 seconds for Studio, including connection setup. Cancellation closes the child and guards publication; restarts mark unresolved work interrupted and require explicit retry. Provider usage remains null/unknown.

**Choice:** Persist runs with explicit states: queued, running, validating, completed, failed, cancelled, or interrupted. Use a bounded local queue and one active run per conversation. Record an idempotency key and a context generation for every request.

Source or instruction mutation invalidates the active context generation and cancels affected runs. The completion transaction checks both run state and generation before saving an output. Cancellation wins once recorded, even if a late Codex event arrives.

For crashes or ambiguous transport failures, reconcile known execution state before retrying. Keep unresolved outcomes interrupted; do not automatically repeat model work. Retry attempts retain a link to the original and cannot overwrite a completed artifact.

**Reason:** Persistent state handles stop/completion races and browser reconnects without relying on exactly-once model execution.

**Alternatives and tradeoffs:** An external queue is deferred. Local processing still needs recovery and backpressure. Cancellation may not immediately stop provider work, but it must immediately prevent future output publication from that run.

**Validation and revisit:** M1.6 and M3 test races; M5 tests crashes and deadlines. Initial configurable targets follow the spec: 20 retrieval calls, 120 seconds per chat turn, and 5 minutes per artifact job. Select global queue capacity and context budgets in TD-17.

## TD-13 Local API, events, and browser transport

**Implementation before OCR expansion (2026-10-08):** Node HTTP serves a Vite build and JSON API on `127.0.0.1:4317`. A random per-boot HttpOnly SameSite=Strict cookie protects the API, with exact Host/Origin checks and cross-site fetch rejection. Mutations require the same Origin. SSE events have database sequence numbers and replay from Last-Event-ID; browser reload attaches to existing runs. Only generic progress/tool labels are streamed; draft answer text is not published before validation. Events remain until source purge or notebook deletion; no separate time-based expiration policy is implemented.

**Choice:** Serve a same-origin browser app and API on loopback. Require a local session credential, validate origins, and protect mutations against cross-site requests. Keep provider credentials server-side.

Use ordinary HTTP for application actions and server-sent events for progress. Persist application-assigned sequence numbers, event/run IDs, and sanitized event payloads. Reconnection replays from an event cursor or returns current state when replay data has expired.

**Reason:** The browser needs a stable product API and ordered recovery semantics independently of the Codex wire protocol.

**Alternatives and tradeoffs:** WebSockets may be useful for future bidirectional collaboration, but first-release actions do not require them. Native browser EventSource cannot send arbitrary authorization headers; choose a protected same-origin cookie flow or authenticated fetch streaming in M3.3. Never put a long-lived session secret in a stream URL.

**Validation and revisit:** M3 settles the HTTP framework, credential transport, streaming client, replay retention, and error contract. Test unauthorized requests, duplicates, out-of-order upstream notifications, reconnect, and expired cursors.

## TD-14 UI rendering and reusable artifacts

**Implementation before OCR expansion (2026-10-08):** React renders imported and generated content as plain text, with application-generated citation buttons and native modal dialogs. The narrow editor is a textarea. Editing marks the entire note user-authored and retains the prior immutable generated revision; it does not preserve automatic verification claims on edited text. Promotion is explicit and propagates derivation metadata to evidence tools. Summary, briefing, study guide, and FAQ use the same output validator. Markdown exports retain quote, title, immutable revision, locator, and revision-specific origin.

**Choice:** Present sources, conversation, and notes/Studio as three areas, with tabs at smaller sizes. Render typed answer blocks and sanitized document content. Never execute model-produced HTML or imported scripts.

Use one artifact model for manual notes, saved answers, and Studio documents, with immutable revisions, authorship, source manifest, and provenance. An edited block becomes user-authored and loses any implication of automatic support verification. Export Markdown with readable citation footnotes.

**Reason:** Shared provenance avoids implementing separate evidence behavior for each output type.

**Alternatives and tradeoffs:** A rich-text editor may improve later usability but complicates location and citation editing. The initial plain-text renderer and textarea editor are recorded in TD-17.

**Validation and revisit:** M2 and M4 verify safe rendering, citation focus return, edits, note promotion, exports, and restart. Add media-specific rendering only after its source/script contract is specified.

## TD-15 Deletion, retention, and backup

**Implementation before OCR expansion (2026-10-08):** Source removal excludes future runs while retaining citations. Purge clears managed passages/FTS, original blobs, generated message/answer copies, generated artifact revisions, and promoted descendants; edited notes remain. SQLite secure_delete plus a WAL checkpoint reduces retained logical database copies, without promising physical-media erasure. Ephemeral Codex threads avoid durable application-managed execution transcripts. Provider requests, user exports, backups, and independently managed Codex/account data are outside product deletion. The backup CLI requires a stopped service, checkpoints SQLite, hashes all files, and restores only into a new directory after schema/hash/integrity checks. Restore qualification passed.

**Choice:** Distinguish removal from purge. Removal excludes a source from future runs while retaining historical evidence. Purge deletes managed local source content and invalidates related execution contexts; affected historical references become unavailable.

Purge must account for copied evidence in tool transcripts, answer citation quotes, artifact revisions, caches, and replayable events. Remove managed verbatim evidence copies and mark affected outputs as needing review or unavailable. Preserve user-authored notes unless notebook deletion or explicit user deletion includes them; do not claim that arbitrary paraphrases or user copies have been erased.

Notebook deletion removes its managed records and blobs and cleans up managed Codex sessions. Report partial cleanup instead of declaring success. Exports, existing backups, and prior provider requests are outside automatic deletion; document those boundaries.

Back up a consistent database snapshot and referenced blobs with a versioned manifest. Restoration verifies schema compatibility and content hashes.

**Reason:** Deleting the original file alone leaves copies in other storage surfaces. Precise retention rules preserve honest citations and protect user-authored work.

**Alternatives and tradeoffs:** Complete erasure from external systems cannot be promised. Retaining historical evidence uses more storage; purging it reduces reproducibility.

**Validation and revisit:** M5.3 inventories every managed copy location and tests interrupted cleanup. M5.8 proves restoration. Revisit before introducing connectors, sharing, new caches, or hosting.

## TD-16 Tests, evaluations, and diagnostics

**Implementation before OCR expansion (2026-10-08):** Twenty-four deterministic tests cover storage, ingestion, boundaries, API, backup, transport failure, and repair behavior. Real harness/native sandbox/browser checks are recorded in `verification.md`. The fixed 40-question run completed 39 outputs with exact citations, including 10/10 abstentions; one citation failure was rejected, then passed a targeted rerun after repair hints were added. No human semantic-review pass is claimed. Routine runtime events omit raw sources and credentials; synthetic evaluation artifacts intentionally contain their redistributable fixture text.

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
| Authentication/model | Supported CLI sign-in; runtime model discovery | Live gpt-6.1-sol run; structured provider-code and controlled expiry/rate-limit fault tests |
| Storage | Node DatabaseSync + FTS5; schema v12; WAL and foreign keys | Restart, old citations, transactional publication, purge, duplicate offers, immutable note derivation, linked import retries, instruction snapshots, backup restore |
| PDF / OCR | pdfjs-dist 6.4.299 + @napi-rs/canvas 1.0.10 + tesseract.js-core 6.1.2 + bundled @tesseract.js-data/eng 1.0.0; extraction v4 | Bounded native/scanned/mixed/white-page fixtures; representative scan/photo/layout fidelity pending |
| Office / delimited | yauzl 3.4.0 + saxes 6.0.0; bounded in-memory package parts; CSV/TSV state parser; current extraction v4 (Office adapter introduced in v3) | Synthetic fidelity/hostile packages, isolated-worker and API lifecycle checks; representative authoring-tool/human fidelity review pending |
| HTML | @mozilla/readability 0.6.0 + jsdom 30.1.2 | Article extraction and script non-execution; fidelity corpus pending |
| Fetch | Node HTTP(S)/DNS + ipaddr.js 2.5.0 | Private address rejection, public fetch, pinning and controlled redirect/DNS-rebinding matrix; broad live-network qualification remains open |
| Output validation | Ajv 8.20.0; stored output contract v5, chat claim schema v1 and per-kind Studio schemas | Exact citation/Unicode rejection tests, source/section coverage and live structured artifacts |
| UI | React/react-dom 19.3.0; Vite 8.3.4; safe React output rendering and lazy-loaded local rich editor | Browser flow, focus return, mobile tabs and export |
| Rich editing | @tiptap/core/react/pm/starter-kit 3.31.4, exact lockfile; restricted JSON format v1 and application citation atom | Canonical schema/mark/link/span/budget checks, generated conversion, revision/restore/purge/backup and desktop/mobile interaction evidence; no cloud/AI extensions |
| Capacity | Two active runs; 20 reads; 200,000 evidence code points; 120/300-second deadlines; validated runtime context window with conservative byte charges and 20% reserve | Configurable hard budgets and tool-contract-4 context admission; deterministic cutoff/unknown-capacity and fresh live fixture evidence; sampled ingestion/RSS baseline |
| Backup | Stopped-service snapshot + hash manifest; new-directory restore | Tampered evidence and active writers rejected |

Do not mark a selection settled without its evidence. If an evaluation fails, update the relevant decision and dependent plan tasks rather than introducing an undocumented substitute.

## TD-18 Deferred architecture

**Choice:** Defer vector infrastructure, cross-notebook knowledge graphs, remaining import formats, speech/media providers, cloud deployment, multi-user identity, collaboration, and connector synchronization. Explicit web research was subsequently implemented under the separate query-only discovery policy at the top of this record; it does not enable live web grounding for ordinary answers.

**Reason:** Each adds a separate retrieval, provenance, permission, cost, or operational contract beyond the first-release scope.

**Validation and revisit:** Promote an area only after defining its product acceptance criteria and a technical decision covering those new boundaries. Hosting must revisit identity, tenancy, runtime support, authentication, network exposure, storage, and retention together.

## Decision history

| Date | Change | Evidence |
| --- | --- | --- |
| 2026-10-08 | Created the technical authority and recorded TD-01 through TD-18 | Existing specification and intent; original planning baseline |

| 2026-10-08 | Implemented TD-01–TD-17; recorded pinned dependencies, ephemeral contexts, admission cap, resource budgets, backup and quality results | [Verification evidence](verification.md); human review and broader release qualification pending |

When superseding a decision, keep its ID and rationale, mark it superseded, link the replacement, and record the migration and affected acceptance checks.

## Qualification changes, 2026-10-09

- **TD-06, TD-12, TD-13:** Schema v4 stores `error_category`. Restart recovery, source/instruction invalidation, explicit cancellation and generation failure save terminal state and durable event within one database transaction. Repeated cancellation leaves completed outputs intact. Unknown provider outcomes and deadlines remain interrupted; retry is explicit and linked to the prior attempt. Backup/restore accepts schemas 3 and 4 and verifies that the restored database matches its manifest before migration.
- **TD-08:** The public fetcher has an internal dependency seam for deterministic DNS/transport qualification; production uses Node DNS and HTTP(S). Every redirect revalidates destinations and keeps the original total deadline. Malformed Location rejects instead of escaping the response callback; declared oversize bodies fail before buffering. RPC framing also bounds unterminated messages and rejects non-object JSON protocol data.
- **TD-14:** Sending/stopping chat returns focus to its composer. Mobile view buttons expose pressed state and control their labeled panels; selected-source count and run progress stay visible in every mobile view.
- **TD-16, TD-17:** Forty deterministic tests, a fresh native isolation check, a 40/40 model evaluation, keyboard/live reconnect checks and the synthetic resource baseline are recorded in [verification](verification.md). Review packets are bound to a result hash; the checker requires a named, dated human review. No agent assessment is labeled a human semantic pass.

## Specification audit changes, 2026-10-09

- **TD-07, TD-08:** Schema 5 adds requested origins and retrieval timestamps to immutable revisions, and the current requested origin to sources. New URL refreshes start at the recorded requested URL and revalidate redirects. Sources track the final URL of their current revision. Legacy requested origins/timestamps remain null; their original request cannot be reconstructed. The source and citation viewers expose revision, original-byte hash, extraction version and URL/timestamp metadata.
- **TD-08, TD-12:** Admit at most two active imports across the service (configurable down to one), without keeping a background backlog of uploaded bytes. Downloads and workers accept cancellation; shutdown cancels both. An extraction worker exit without a result fails instead of leaving an unresolved import. PDF extraction enforces the character limit incrementally across pages. Terminal or foreign import jobs cannot publish revisions.
- **TD-09, TD-11:** Tool contract 3 charges every serialized response character, including metadata and source inventory, against the evidence budget. Failed budget reads do not mark passages read. Search callbacks return IDs that resolve to canonical manifest passages; callback-supplied text/metadata cannot replace stored evidence. New context hashes exclude history from earlier tool contracts.
- **TD-10, TD-12, TD-15:** Schema 6 stores bounded plain-text unverified drafts separately from completed outputs. One repair is still the limit; failed repair or provider failure during repair retains the latest available rejected text. Drafts have no verified citation controls, do not enter successful-history replay or artifacts, and are cleared by source purge. Backup/restore accepts schemas 3 through 6, verifies manifest/schema equality, and applies migrations only when opening restored data.
- **TD-16:** The tool-contract-3 40-question rerun, 54-test regression suite, refreshed resource baseline and browser provenance/draft checks are recorded in verification. Human semantic review remains a separate gate.
- **TD-07, TD-08:** Extraction version 2 bounds Markdown display locators at 256 Unicode characters with an explicit warning; full heading text remains unchanged in normalized evidence. Existing revision text/metadata is not rewritten. Duplicate reuse now requires matching derivation, input kind and recorded origins so an identical promoted note cannot lose its originating-artifact link, and distinct URL provenance cannot silently disappear. Originating notes are checked within the destination notebook.
- **TD-10, TD-14:** Stored output contract 2 adds application-computed source/section coverage, independently of model warnings. The model claim schema stays at version 1; all fifty allowed warnings remain intact. Actual successful evidence responses determine read counts; omitted headings and sources are persisted, rendered safely, and exported. New runs record contract 2 and cannot replay contract-1 contexts. Historical outputs without this field remain readable.
- **TD-12, TD-16:** Unknown provider error messages are mapped to fixed diagnostic text instead of persisting upstream text that may echo private evidence or credentials. Extraction-worker stdout/stderr is drained without forwarding or retention, preventing parser warnings from leaking document fragments into routine logs. Explicit failed drafts still use their separate, labeled inspection path.
- **TD-10, TD-14:** Contract 3 adds an explicit Studio kind and ordered sections whose indexes assign every cited content block exactly once. Each kind has the required layout from the specification. Final service/storage validation rejects missing sections, wrong kinds, duplicate/omitted/out-of-range indexes and invalid citations. The UI, edit text, promotion and Markdown export share the layout. Old flat documents remain readable. A saved artifact stays mounted while its citation viewer is open, so closing evidence returns focus to its originating citation.
- **TD-06, TD-08, TD-14, TD-15:** Schema 7 retains the candidate revision for duplicate-import offers. Compatible duplicates release their extraction slot without publishing new evidence or cancelling active generation. Reuse/dismiss is explicit, notebook scoped and idempotent; reuse checks the same current revision is still available. Pending offers survive restart. The browser returns focus to Add sources after resolution. Backups accept schemas 3–7 and preserve the pending offer.
- **TD-16:** Human review format 2 binds result/corpus hashes, exact question text/status, model/runtime and rubric version 1. Stale data under an unchanged version or question ID is rejected before review judgments. These machine checks still cannot replace named human semantic review.
- **TD-07, TD-14:** Source labels distinguish a generated origin from a manual user note. The originating run determines generated ancestry even after the note is edited; unknown legacy origins are labeled unknown. The note derivation link and independent-corroboration restrictions remain part of the evidence contract.

### Immutable note-promotion provenance, 2026-10-09

**TD-07, TD-12, TD-15:** Schema 8 adds a nullable note-revision reference on each source revision and historical titles on new note revisions. Promotion captures the revision before asynchronous extraction; a concurrent edit cannot redirect the source's ancestry. Reuse requires matching note revision as well as bytes and other provenance. Legacy promotion references remain unknown rather than being reconstructed from today's editable note. The scoped derivation API exposes the pinned content, authored state, originating run and manifest, with unavailable content withheld after purge. Source viewers display the original evidence quotes and locators; Markdown citation footnotes carry the parent note/revision and derived-evidence qualification. Agent evidence and output contracts remain at version 3: derivation inspection is an application API, and its new metadata is not added to model tool responses. Backups accept schemas 3–8 and retain these links. Verification covers concurrent edits, notebook boundaries, restart, backup and purge.

### Import-attempt recovery, 2026-10-10

**TD-06, TD-08, TD-13, TD-15:** Schema 9 records each import's operation type, input kind, descriptor, attempt count, parent attempt and lifecycle timestamps. Descriptors contain only the format and applicable URL/source/note-revision references. Failed file or pasted-text bytes are not persisted as retry payloads. One child attempt per failed parent and unique idempotency keys prevent repeated clicks from dispatching another import; a failed child is the next retry target. Corrected new-source input may change format or URL, while refresh/promotion retries retain their target and pinned revision. Completed retries replay their saved job even when the original source is later removed. Legacy descriptors and historical lifecycle times remain unknown.

A lifecycle trigger timestamps status transitions, including restart failure and duplicate-offer resolution. Service failure updates only a still-processing job, preventing a late error from replacing a completed status. The UI shows the latest unresolved attempt, retry actions and operation/time details; file/text re-entry is explicit. URL corrections can be entered through the same linked retry form. URL retries use the restricted fetcher again, and removed sources/unavailable note revisions cannot dispatch new work. Backups accept schemas 3–9. Current model-facing contracts remain at version 3.

### Instruction snapshots and context-generation boundaries, 2026-10-10

**TD-06, TD-11, TD-13–TD-15:** Schema 10 adds a recorded notebook instruction version/update time and immutable run instruction version/text plus explicit sources-only grounding mode. Real instruction edits increment the version; unchanged saves do not. New notebooks record creation/update together. Legacy current instructions become recorded version 1, while missing historical run snapshots and prior update times remain null.

A history query that used only the compatibility digest could replay old answers after instructions or selection changed away and back. History now requires the same notebook context generation as well as digest, conversation, grounding mode and completed status. Reverting values preserves the required fresh context. Within that generation, up to eight compatible messages remain available. The adapter receives the run's captured instruction text. Title/archive edits and unchanged instructions preserve an active run; actual instruction changes first invalidate stored work, then interrupt its execution controller. The UI keeps old messages visible, asks for a self-contained question after reset and exposes the original generation instructions on answers/saved generated notes. Backups accept schemas 3–10. Model output/tool contracts stay at version 3; no model-facing schema or base prompt changed.

### Reported usage and measured run diagnostics, 2026-10-10

**TD-03, TD-12, TD-14, TD-16:** Generate the token-usage notification and dependent types from the pinned executable. Validate six nonnegative safe-integer counters, strip unrelated fields, and accept cumulative thread totals only from the current thread and known run/repair turns. Reject regressing totals rather than adding duplicate notifications. An ephemeral thread belongs to one Codeboom run, so its cumulative totals include bounded repair work. Keep the handler across turn completion/repair and preserve observed counts on failure. Counts absent from the runtime remain null; do not infer monetary cost.

At atomic run creation record manifest source count and unknown measurements. During execution persist time to first active application progress and final execution duration using a monotonic clock, alongside evidence calls, full serialized-response characters and reached call/character/deadline budgets. Numeric diagnostics contain no source fragments or credentials, survive restart/backup and can finish recording after cancellation without publishing output. Legacy missing measurements remain unknown. No storage migration is required beyond existing schema 10's JSON stats column. The UI combines these diagnostics with original instruction details for answers, saved notes and terminal failures. Failure disclosures use a vertical readable layout on mobile.

Current tests, a real two-source service run and desktop/mobile inspection verify these behaviors. The full task/spec inventory is in [requirements-audit](requirements-audit.md). Hard evidence limits are enforced, but the spec's selected-model-capacity relationship is not yet implemented or measured: model-list metadata has no window field, and the nullable usage notification window is currently unused. This was the open requirement at the diagnostics audit; the subsequent selected-model admission entry below records its implementation and evidence. Named human semantic review remains separate from deterministic traceability. M5.5's named keyboard/focus/layout/label checks are recorded; a full live assistive-technology session remains unqualified.

**TD-08, TD-14:** Successfully published current sources explicitly display Ready beside their input/ancestry label, and extraction warnings have a clear inspection prompt. This makes the existing atomic readiness boundary visible; failed/processing imports still cannot enter the source list. Desktop/mobile keyboard and accessible-label inspection covers plain and warning-bearing fixture sources.

**TD-09, TD-12:** The context-capacity protocol probe records that first-batch dynamic-tool replies precede the usage window notification. Holding replies prevents the observed notification until release. The remaining budget design must handle unknown capacity without blocking that protocol dependency, and must not infer capacity from a model name or treat byte estimates as provider-reported token usage.

### Selected-model context admission, 2026-10-10

**TD-09–TD-12, TD-16:** Tool contract 4 adds context admission before evidence publication. Accept a positive safe-integer context window and validated current-turn breakdown only from the active runtime thread and known turns. Before usable metadata, return a fixed tool error that says evidence was withheld and requests retry after usage updates; do not hold replies waiting for the dependent notification. Missing capacity at turn completion fails explicitly. When a model ends without retrying any withheld evidence, the existing single validation-repair attempt can request an evidence read; no competing model loop or unbounded bootstrap retry is added.

`ContextBudget` retains the smallest observed window, largest reported current-turn token count and all charged UTF-8 bytes across normal/repair work. Admission includes full serialized evidence, request/tool/error text and a framing allowance; reserve 20% of the window for generation and uncounted runtime framing. Late reports may include previously charged text, so deliberate double counting keeps the bound conservative and never frees unreported evidence space. Byte admission is an upper allowance for nonempty byte-token pieces, not a claim about measured provider usage. Initial request processing still belongs to the runtime; the application never supplies evidence tool results before receiving usable capacity, and rejects a repair request that cannot fit the observed allowance.

A rejected evidence response consumes no published evidence characters and marks no passage read. A smaller response may still fit; reached capacity is recorded separately from call/character/deadline cutoffs, and computed source/section omissions remain authoritative. An unknown-capacity failure records its separate reason. Numeric context snapshots survive service persistence/backup and are inspectable with reported usage. Storage/output versions remain 10/3; tool version 4 changes history compatibility so earlier tool-3 contexts are not replayed. Reproducible harness/evaluation scripts now retain diagnostic snapshots. Deterministic and live qualification are recorded in verification; human semantic acceptance remains separate.

### Candidate study tools, 2026-10-10

**Proposed, not implemented — TD-10, TD-12, TD-14, TD-15:** The spec now defines provisional flashcard/quiz acceptance criteria. Current `ArtifactKind` and `Answer` support four ordered document layouts; interactive study items need a distinct typed contract rather than packing answer keys and options into display prose. Add explicit item identities and citation-bearing questions/answers/explanations, with deterministic structure/reference validation followed by the existing single bounded repair. Version changed output/history compatibility, retain legacy document readers, and reuse manifest-scoped run admission/publication. Do not create a separate unrestricted agent loop.

Quiz answer keys are stored in immutable generated revisions. Separate notebook-scoped attempt records pin that revision, validate item/option membership, and persist idempotent submission and locally computed scores. They need migration and stopped-backup/restore evidence before activation; no storage version is assigned until the actual migration is implemented. Attempts/learner selections cannot enter evidence tools, model replay, generated note promotion or routine diagnostics. Source purge removes affected attempt records with generated content; notebook deletion removes all notebook attempts. Existing authored-edit behavior creates a text revision without inherited interactive keys while retaining original history.

Rendering must separate candidate options from source assertions and expose reveal/navigation/selected/submitted states with ordinary keyboard controls. Export and promotion require typed traversal: export clearly labels distractors, whereas source promotion excludes distractors and learner choices and pins the original generated revision. Existing generic `documentText` grouping is insufficient for that contract and must not silently treat every option as evidence. Exact citations establish traceability; a human review of semantic support and quiz ambiguity remains a separate gate. Item count 5–20/default 10 is a provisional product limit, subject to sparse-evidence omissions and the existing context budget, not a model capability claim.

Implementation depends on M5 and next-priority selection. The design does not enable new runtime capabilities, providers or source formats, and does not claim any study-tool test or UI has passed.

### Study tools implementation, 2026-10-10

TD-10/TD-12/TD-14/TD-15 proposals above now have an implemented local prototype. Output contract 4 uses distinct study item identities and cited block references, including question-premise references. Each quiz key names exactly one candidate whose text equals its cited factual answer; separate explanation blocks may be marked inference. All supported blocks belong to one item. Requested counts are 5–20, default 10; fewer items require a count/evidence warning, and insufficient evidence has no playable items. Unknown/duplicate IDs/options, unassigned blocks and forged references are refused before publication; repair remains bounded once.

The selected provider rejects `uniqueItems` in its structured-output schema. The live probe recorded only safe schema/keyword/path indicators. Model schemas omit that keyword; deterministic validation retains uniqueness and exactly-once ownership. Six subsequent real-model cases pass. The original chat/document model schemas and base instructions are unchanged, while the stored output version invalidates previous history compatibility.

Schema 11 captures `runs.study_count` and scoped revision-pinned `quiz_attempts`. Attempts store chosen option IDs, submission time and local score/total; submission is immutable and repeated identical submission is idempotent. Foreign notebook/revision/item/option references and malformed route/submission shapes are rejected. Start/new-attempt/answer/submit operations call no model. Attempts survive restart/backups, remain pinned after an authored edit, and are removed when their generated evidence is purged or the notebook is deleted. Backups accept schemas 3–11 and the schema-3 migration fixture includes this transition.

The UI adds count selection, flashcard reveal/navigation, quiz selection/submission/feedback and historical attempts. Citations return focus to the study control. Markdown exports include correct answers/explanations and explicitly label candidate distractors; derived-source text omits distractors and learner choices. Actual browser promotion confirms the immutable note revision link and generated-origin label. No new provider, external tool or source permission is enabled. Local expansion development proceeds while named human release acceptance remains open; neither structural checks nor generated-key scores establish semantic truth.

### Study review tooling, 2026-10-10

**TD-16:** Versioned study corpus 1 preserves the exact six original case hashes and requested count. Evaluation and review load the same corpus. Study review format 1/rubric 1 binds corpus document/case hashes, result bytes, counts, contracts and model/runtime; each response carries immutable case/answer/passages. Component judgments cover title, questions, blocks, warnings and computed coverage. Factual answer/explanation blocks require atomic claims, and every quiz key has a separate ambiguity judgment. Review checks require ≥95% supported claims, both abstentions without unsupported claims, all sufficiency judgments and every quiz item having exactly its stored correct option. Source/context tampering, missed components, duplicate claims and altered keys are refused. Preparing a packet never overwrites existing judgments. Tests use synthetic verifier judgments only; the prepared artifact remains empty and fails named human acceptance.

### Mind maps and data tables, 2026-10-10

**TD-10/TD-12:** Output contract 5 adds separate typed `mind-map` and `data-table` outputs. A map has at most forty root-first nodes, one root, parent-before-child links, six levels, cited labels/relationships and detail-block references. Tables have at most eight columns/twenty rows, distinct IDs, exact column-order cells and cited values; empty cells explicitly mean missing evidence. Every supported block is assigned once. Foreign/mismatched references, cycles, orphan nodes and unsupported structural shapes are refused before publication and repair remains bounded once. The source manifest, context budget, instruction/version history, cancellation and atomic-publication paths are shared. Stored schema 11 needs no new migration. Existing model output schemas for chat/documents/study are unchanged; the stored/history version advances to 5. The study review checker binds recorded contract 4 or 5 rather than treating current code version as the result's version.

**TD-14/TD-15:** React renders SVG connections plus a collapsible keyboard outline, citation buttons and a semantic table. Canvas/table overflow stays inside labeled keyboard-focusable regions; full labels remain in the outline. First branches are arranged around the root and a size observer centers it once the native modal is visible, including responsive changes. Exports preserve the real hierarchy even when input nodes are breadth-first, escape table separators/markup, label inferences and retain label/relationship/cell citations. Derived text retains all typed content and missing-value qualifications; original revision inspection lists all these references. Edits remain authored flat notes. Retries involving maps/tables retain the originating type.

**TD-16:** Eight versioned synthetic runtime cases preserve supported, sparse, conflicting and insufficient outputs. The first evaluator's two sparse-warning failures were an extra harness predicate, not missing product requirements: the map exactly represented its one requested fact, and the table had explicit missing-budget cells and a notice. The original result is preserved; a separate checker-version-1 report binds the same bytes/corpus and recomputes every status/structure/reference/export/promotion check, passing eight without a provider rerun. This does not claim human entailment. Regression/HTTP/browser evidence and pending ≥95% semantic acceptance are recorded in verification.

### Office and delimited import design, 2026-10-10

**TD-08/TD-17:** The acceptance criteria are in spec §4. Use pinned yauzl 3.4.0 for central-directory ZIP access and saxes 6.0.0 for namespace-aware XML parsing inside the existing 256 MiB/30-second worker. Read package parts in memory; never extract member paths to disk or follow external relationships. Bound metadata, decoded XML, elements, depth and final text, and validate the CRC/size of every decoded part. Reject macro/encrypted/legacy binary Office and malformed required content atomically. Source archives retain the original bytes through the existing publication, revision, backup and purge boundaries.

DOCX locators describe paragraphs, tables and related structural parts rather than rendered pages. PPTX follows declared slide relationships and separates notes. XLSX preserves addresses, stored formulas and labeled cached snapshots without calculation; numeric values retain format metadata and date-system context rather than invented units. CSV/TSV cells remain text, including formula-looking content. Unsupported visual/embedded representations and hidden content need visible extraction warnings. Extraction version 3 distinguishes new import behavior; existing stored revisions are not rewritten. Office rendering fidelity still needs representative authoring-tool files and human review.

Parser references: [yauzl central-directory and size-validation API](https://github.com/thejoshwolfe/yauzl), [Microsoft spreadsheet cell representations](https://learn.microsoft.com/en-us/office/open-xml/spreadsheet/how-to-retrieve-the-values-of-cells-in-a-spreadsheet), [Microsoft slide text extraction](https://learn.microsoft.com/en-us/office/open-xml/presentation/how-to-get-all-the-text-in-a-slide-in-a-presentation).

**Office implementation evidence:** extraction v3 is wired through API/UI, type labels, file retries and the existing source storage/retrieval lifecycle. The 117-test suite and one five-source real runtime comparison cover the named synthetic boundaries; desktop/mobile chooser, warning, exact-citation and focus checks are recorded in verification. Source generation schemas remain output/tool 5/4 and storage stays 11. The human authoring-tool fidelity gate remains open.

### Notebook organization design, 2026-10-10

**TD-06/TD-09/TD-13/TD-14/TD-17:** Add storage migration 12 for notebook tags, template snapshots/starter questions, personal template records and a note FTS index. Template recipes use explicit fields and immutable instantiation snapshots; version checks reject a changed recipe before creation. Built-ins stay code-owned and read-only. Metadata-only tag edits do not invalidate generation. Personal template ownership is the local authenticated service; hosted tenancy remains a separate pending design.

Discovery stays a local authenticated read API and never becomes an agent tool. Join source search to current, nonremoved revisions and notebook archive/tag filters before pagination. Maintain note search atomically through SQLite triggers using the same typed text projection as saved notes; omit unavailable generated content and retain authored edits. Return escaped plain text excerpts, owning IDs and structural locators. Opening results switches the notebook before using its scoped viewer. No automatic evidence copying, source selection or model request occurs. Backup supports schema 12, while old backups migrate normally. Relevant APIs are documented in [SQLite FTS5](https://www.sqlite.org/fts5.html) and [Node SQLite](https://nodejs.org/api/sqlite.html). Implementation and verification follow these acceptance criteria; release acceptance remains open.


**Organization implementation evidence:** migration 12, authenticated metadata/template/library endpoints and scoped viewer opening are implemented. FTS triggers maintain saved-note search atomically, including study questions and explicitly labeled candidate options, without learner attempts. Six organization test groups plus HTTP coverage bring the suite to 123 passing tests. Genuine schema-11 migration and schema-3 backup restoration preserve legacy data. Desktop/mobile checks verify version-2 recipe edits leave the instantiated version-1 notebook intact, ordinary source/note focus return and bounded valid metadata containment. Library/template interactions produced zero model runs. Output/tool/extraction versions stay 5/4/3; release and human semantic gates remain open.


### Rich note editing design, 2026-10-10

**TD-06/TD-10/TD-12/TD-14/TD-15/TD-17:** Use a pinned local Tiptap/ProseMirror React editor with a restricted StarterKit and an application-owned inline citation atom. Its [React integration](https://tiptap.dev/docs/editor/getting-started/install/react), [node API](https://tiptap.dev/docs/editor/extensions/custom-extensions/create-new/node) and [StarterKit](https://tiptap.dev/docs/editor/extensions/functionality/starterkit) document the needed visual editing/JSON APIs. Do not connect cloud/AI/collaboration extensions. Store `format: rich-note`, version 1 and a canonical whitelisted document in existing artifact/revision content columns; output/tool/extraction/schema versions remain unchanged. Independently validate every accepted JSON node/mark/link/budget on the backend. React renders the same whitelist without raw HTML. Clipboard HTML is converted to plain text; links open only on explicit user action.

Share text/Markdown and original-output conversion projections across editor, history, discovery and promotion. Inline citation atoms retain the existing code-point quote coordinates. New attachments require exact notebook-scoped stored spans; absent inherited attachments are accepted only from the saved base note, remain unavailable and do not certify edited claims. API saves require the latest revision ID and restoration creates a new authored revision. History queries are notebook scoped; generated revisions erased by existing purge stay unavailable. No new storage column or model tool is needed. Acceptance criteria precede implementation and neither visual formatting nor structural span checks replace the human support gate.


**Rich editing implementation evidence:** the pinned local editor, backend validation, revision history, scoped restore and shared text/export projections are implemented. A ProseMirror append-transaction plugin strips formatting from citation atoms so broad selection formatting cannot corrupt their span records; hard-break marks follow the editor schema. Save conflicts keep the draft until explicit saved-revision reload. Editor styles are served in the local stylesheet with runtime CSS injection disabled, preserving the existing strict CSP. Lazy loading keeps the entry bundle at 293.91 kB and the editor chunk at 400.18 kB (89.41/126.57 kB gzip). The Vite build retains a module-level `use client` diagnostic for Tiptap in this client-only application; it succeeds and the resulting browser editor is verified.

The updated lockfile passes clean `npm ci`, strict typecheck, production build, diff checking and 131 tests. Eight new rich-note groups plus extended HTTP cover canonical structures/rendering/exports, formatting across citation atoms, hostile shape/link/span/budget refusals, every generated-kind conversion, quiz revision-pinned keys/attempts, stale saves, immutable history, restoration, FTS, scope, purge and stopped backup/restore. Browser checks add nested lists, exact Unicode references, selected links, safe paste, source focus return, history and conflict reload, 390px containment and actual unavailable-reference labels. Nine seeded completed fixture runs remain nine; no editing/history operation invokes generation. Output/tool/extraction/storage versions remain 5/4/3/12. Human semantic and release acceptance, publishing and other expansions remain pending.

### OCR design, 2026-10-10

**TD-08/TD-12/TD-15/TD-17:** Pin tesseract.js-core 6.1.2, @tesseract.js-data/eng 1.0.0 and @napi-rs/canvas 1.0.10. Invoke the core's TessBaseAPI directly inside the existing extraction Worker, avoiding a nested worker or operating-system subprocess. The official [worker implementation](https://github.com/naptha/tesseract.js/blob/master/src/worker-script/index.js) and [image adapter](https://github.com/naptha/tesseract.js/blob/master/src/worker-script/utils/setImage.js) describe initialization and recognition; local package code remains authoritative for this pinned integration. Read the bundled English LSTM model and WASM from fixed package paths, use memory-only engine files, and suppress engine diagnostics. No runtime language cache, external URL, arbitrary file path, child process or model call is introduced.

Check raster headers/animation/dimensions before native decode. Flatten supported uploaded rasters onto white and OCR the normalized local image. Render qualifying PDF pages at 144 dpi using PDF.js's local canvas path; inspect image operators so mixed pages do not silently lose scanned regions. Preserve native text separately on mixed pages and label duplicate possible content. The spec's page/pixel/output budgets and unchanged deadline apply before publication. Resource limits constrain JavaScript heap, not native/WASM memory; do not describe this Worker as an OS security sandbox. Extraction version 4 distinguishes the new policy without re-extracting old revisions. Warnings carry pinned engine/model/language and per-page confidence alongside exact OCR text; they qualify recognition rather than proving semantic accuracy. Implementation and acceptance evidence follow these criteria; human fidelity and release gates remain open.


**OCR implementation evidence:** direct local WASM recognition, pre-decode image validation, bounded canvas rendering, warning-bearing page/image text, unchanged atomic worker publication and authenticated original attachment downloads are implemented. The retained snapshot download verifies its SHA-256, serves bytes only as a download attachment instead of inline executable content, and refuses foreign, missing or purged revisions; it is not an agent tool. The prior blanket PDF-warning rejection is replaced by page-aware extraction. Entirely white pages can be skipped explicitly; nonblank pages without OCR text fail. PDF.js 6.4.299 strict mode can finish an empty operator list after an oversized image failure. The integration instead captures its recovery warnings with a temporary console.warn hook and fails the entire import. Async-context-aware collection uses a conservative fallback for message-port callbacks; production has one parser per Worker. A valid later page must not conceal the lost oversized image. The hook restores console.warn after success/failure, and engine/parser diagnostics do not enter routine application logs. Canvas/WASM RSS is not bounded by the JavaScript heap setting; page/pixel limits constrain input work without claiming an OS sandbox or a hard total-RSS cap.

Clean installation, typecheck/build/diff checks and 137 tests pass. Six OCR groups cover raster formats/noise/EXIF, mixed/native/white PDF pages, malformed/animated/size limits, cumulative/page/render limits and nonblank failures, offline workers with confirmed termination, and scoped publication/duplicates/retry/immutable spans/original integrity/restart/backup/purge. HTTP checks cover image/PDF ready warnings, idempotency/retry and exact original downloads with session/notebook/revision refusal. Two preserved synthetic Codex cases use runtime 0.161.0/gpt-6.1-sol: the comparison cites both OCR reports in four exact spans, and missing final-approval evidence abstains. Human semantic and OCR fidelity acceptance remain pending. Output/tool/storage versions remain 5/4/12; extraction is 4.

### Audio transcription design, 2026-10-10

**Native-memory correction:** The completed two-concurrent-Worker probe retained about 1.30 GB in the parent after eight terminated jobs and peaked at 1,549,424 KiB. Disabling ONNX CPU arenas/memory patterns only modestly improved the earlier sequential measurements. Revise audio isolation to one disposable Node process per extraction, using the same fixed local adapter and 256 MiB JavaScript heap limit. Deliver bytes/results through advanced-serialization IPC, drain diagnostics, kill the process on completion/cancellation/deadline and await its exit before the service releases admission. This replaces audio's thread boundary; ordinary parsers keep Workers. It adds no shell, external decoder, nested inference process or runtime network permission, and does not establish a hard OS resident-memory cap. Required evidence is actual offline recognition, cancellation after a generated token, completed process exit and stable parent RSS across repeated concurrent batches.

**TD-08/TD-12/TD-15/TD-17:** Pin @huggingface/transformers 4.3.1. The initial foundation used @audio/decode 3.11.1; the enabled adapter replaces its error-dropping normalizer with exact direct codecs: decode-aac 1.6.0, decode-mp3 1.3.1, decode-flac 1.3.5, decode-opus 1.3.3 and decode-vorbis 1.3.4. The [speech pipeline](https://huggingface.co/docs/transformers.js/api/pipelines#automaticspeechrecognitionpipeline) supplies segment timestamps and overlapping-window recognition; the [local-model configuration](https://huggingface.co/docs/transformers.js/custom_usage) disables remote loading. The [decoder API](https://github.com/audiojs/decode) supports in-process streaming/chunked decoding and local codecs. Inspect the pinned package code for actual format/stream behavior instead of assuming that later README capabilities exist in the installed release. The default is the public onnx-community/whisper-tiny.en model at commit 2575352d61be1bf7225cf8f8b268a4678025fc58 with quantized encoder/merged decoder; pin each consumed configuration/tokenizer/weight file by SHA-256. Keep downloaded assets in a configured ignored model directory outside notebook data, so backups do not become implicit model installers. Setup stages and verifies the fixed assets before publishing the model directory; ingestion permits no runtime fetch or arbitrary model selection.

Decode in the owning disposable audio process; do not spawn ffmpeg or a nested inference process. Stream PCM under explicit cumulative duration/channel/sample budgets, downmix stereo and resample to 16 kHz mono with a stated algorithm. Run CPU ONNX inference with bounded thread counts, fixed chunk/stride/generation limits and installed assets only; disable CPU arenas and memory patterns. Segment locators are engine-estimated intervals; preserve unknown ends and reject invalid/mismatched text rather than assigning fictional times. Recognition warnings are revision provenance and reach the existing viewer/evidence metadata. Only audio may use a five-minute extraction deadline; keep ordinary parser deadlines and the import admission limit unchanged. Cancellation kills the owning process, and extraction settlement awaits exit. Parent IPC disconnect also exits the process. The launcher uses fixed Node/tsx arguments instead of inheriting evaluation or test arguments; an actual regression checks that parent --eval code is not executed. The spec's fidelity, resource, lifecycle and UI criteria precede implementation. Transcription is separate from the planned cited-script/speech-generation media stage. Native memory and process termination need actual evidence; the existing JavaScript heap limit alone does not establish them.

**Foundation evidence and open integration:** `audio-assets.ts` fixes thirteen configuration/tokenizer/weight files to the immutable revision and SHA-256 catalog. Setup permits only HTTPS model/CDN redirect hosts, bounds download sizes and deadlines, stages in a fresh directory and verifies before rename. Existing invalid directories are refused without replacement; verification rejects symlinks, extra files and hash mismatches. A real explicit install and offline repeat succeed. CPU inference loads the fixed quantized files using `local_files_only`, no remote model access or caches, one intra/inter-op thread and sequential execution. Overlapping 30-second windows/5-second strides, greedy generation and a 448-token window refusal bound recognition; transcript publication validation checks full canonical Unicode text against every segment, preserves unknown boundaries and refuses invalid structures. A pre-model RMS gate rejects silent/very quiet input, without claiming voice-activity detection.

WAV parsing is owned code for RIFF PCM/IEEE float, including the supported extensible GUID. It validates declared chunk/byte/sample boundaries before allocating, averages stereo channels and records possible phase cancellation. Out-of-unit float PCM is explicitly peak-scaled. Resampling uses a Hann-windowed sinc with a rate-scaled cutoff/support, 256 coefficient phases and zero-padded boundaries; a deterministic frequency test checks passband preservation and anti-alias rejection. Audio has a separate 24-million channel-sample budget. Compressed preflight validates contiguous MP3/ADTS frames, FLAC metadata/CRC and Ogg page CRC/sequence/continuations/EOS for one stream. Unknown-total FLAC, AAC profiles other than LC, chained/multiplexed Ogg and unsupported channel mappings currently require an explicit refusal rather than guessed allocation or silent stream dropping.

The umbrella decoder normalizer discards codec error metadata; integration must inspect the underlying decoder results. Current synthetic probes find that MP3's underlying decoder emits two identical channels for a mono stream and trims Xing/LAME delay/padding; AAC-LC 16 kHz is decoded at 32 kHz, with its startup empty output counted as an error by aggregate calls. These behaviors need explicit contracts and malformed-input evidence before advertising formats. The upstream [LAME tag code](https://github.com/lameproject/lame/blob/master/libmp3lame/VbrTag.c) and [FFmpeg MP3 encoder](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/mp3enc.c) are primary references for gapless metadata, not grounds for accepting arbitrary missing frames. M4A demuxing and completed worker/native lifecycle remain pending. The pinned transitive AAC decoder is GPL-2.0; deployment/distribution packaging must account for its license or replace it. macOS `say` and FFmpeg were used only to create synthetic fixtures, not as application dependencies. Direct-helper peak RSS is recorded in verification and does not establish a worker limit or load qualification.

**Compressed decoding and provenance:** Owned preflight validates complete frames/pages and cumulative sample budgets. MP3 Xing/Info frame/byte counts and LAME/Lavc/Lavf delay/padding must match physical frames before accepting gapless trimming; untagged padding stays qualified. Decode AAC-LC through the pinned package's fixed embedded WASM C ABI, checking `_aac_error()` and complete consumed bytes even when no PCM is returned. Only a first error-free priming packet may yield zero samples. Validate the observed 1×/2× rate relationship, every later packet and complete decoded sample count. The [upstream C bridge](https://raw.githubusercontent.com/audiojs/decode/master/packages/decode-aac/src/aac_glue.c) exposes the error state omitted by its JavaScript empty-result wrapper. M4A demuxing is bounded owned code for one self-contained AAC-LC audio track: complete local sample/chunk/time tables and one simple edit, with no external references, video, fragmentation, encryption, HE-AAC or ALAC. Refuse missing/truncated/error-producing material instead of publishing partial speech.

Extraction version 5 enables the audio family without rewriting old revisions. Complete warnings and model/language/decoder metadata remain immutable evidence provenance; the viewer keeps detailed model/PCM/resampling metadata in its provenance disclosure and presents recognition/timestamp/stereo limitations directly. Original attachment extension detection includes all advertised audio families. No model setup or codec/inference code enters the browser bundle. The pinned AAC package declares GPL-2.0; its distribution licensing needs release review. This local prototype does not resolve that review or representative audio fidelity acceptance.

### Cited audio overviews and local speech design, 2026-10-10

**TD-10/TD-12/TD-14/TD-15/TD-17:** Add a distinct `audio-overview` document kind with opening, main ideas, differences and limitations sections, retaining the shared structured evidence validator and one bounded repair. Advance stored/history output contract to 6; chat and existing kind schemas remain structurally unchanged. Produce a supported script before the user chooses a separate renderer. A deterministic complete spoken-text builder retains source attribution, inference labels, gap/coverage qualifications and an audible generated-speech notice. It rejects speech-control delimiters and enforces 8,000 Unicode characters/700 words rather than truncating. Insufficient-evidence outputs remain inspectable scripts but cannot render speech.

Select a first local provider appropriate to the current macOS-only application: fixed `/usr/bin/say`, fixed Samantha/Daniel English voice IDs, 170 words/minute and mono 22.05 kHz 16-bit WAV. Discover only installed allowlisted voices. The local `man say` documents stdin, voice inventory and WAV/PCM configuration. Actual synthetic renders of both voices produce complete, positive-duration WAV files in that format. A Samantha render also succeeds under `/usr/bin/sandbox-exec` with network denial and writes restricted to the owned output directory. Apple's [speech synthesis documentation](https://developer.apple.com/documentation/avfoundation/speech-synthesis) describes voice configuration and on-device synthesis; this provider is separately selected and does not add speech tools or host permissions to grounded Codex runs. No source-derived executable/voice/path arguments, shell, voice install, arbitrary network destination or implicit remote-provider fallback is allowed. Engine diagnostics are drained with fixed public errors.

Schema 13 will add durable speech jobs and immutable assets linked to notebook/artifact/revision, a complete spoken-text hash, provider/voice/renderer metadata, original audio hash and duration. Use the existing staged managed blob directory, with independent WAV/hash validation before publication. Keep one active render per revision and two globally; await native exit before capacity release. New jobs are idempotent; interrupted/failed/cancelled attempts retry explicitly. Startup reconciliation must discard staging/orphan media and label interrupted jobs. Playback/download is session/scoped, with validated byte ranges and no user-selected file path. Purge/deletion and stopped backups must account for every asset reference. Existing historical scripts and current edited notes must never acquire each other's speech. Acceptance criteria are defined in spec before implementation; provider-specific human listening and the original semantic release gates remain required.

### Personal-note voice input and generated-audio deferral, 2026-10-10

Voice questions reuse the local capture/recognition component with a question destination, explicit review/insert and a captured textarea selection. No recognition result initiates a model run. Saved-note conversations use schema 14 ownership metadata to pin one derived source to one immutable artifact revision. A deterministic scoped operation reuses the revision's conversation/snapshot; normal imports skip these conversations, selection/refresh changes are refused, and snapshot creation does not invalidate existing research contexts. The authenticated endpoint renders the selected note revision to plain text and retains ancestry through the existing managed source/blob, retrieval, purge and backup lifecycle. This explicit derived snapshot is evidence about what the note says, not independent corroboration. It does not implement arbitrary spoken edit/delete commands or speech output.

The user clarified that the application is for personal notes and that voice input is needed while audio generation is not needed now. Disable experimental generated audio in the normal Studio/UI/API; retain the groundwork behind an explicit development flag. Output/storage contracts remain 6/13 so already-created snapshots remain readable. Generated-audio release gates are deferred with that feature, not silently passed.

Dictation uses explicit microphone permission and a fixed same-origin AudioWorklet, following the [W3C capture API](https://www.w3.org/TR/mediacapture-streams/#dom-mediadevices-getusermedia) and [Web Audio interface](https://www.w3.org/TR/webaudio/#AudioWorklet). Bound both PCM samples and wall time to two minutes, request mono input, keep the worklet output silent, retain the final partial PCM buffer on stop, and emit a complete WAV. Emit the worklet as a separate same-origin asset (`?no-inline`) because the application CSP disallows data/blob executable URLs. Cancellation before permission resolves must stop a subsequently granted stream before constructing an audio graph.

Recognize through the existing installed local English model and disposable process. Ephemeral authenticated, notebook-scoped requests share the two-slot recognition limit with imports; cancellation holds capacity until awaited process settlement. No dictation database table, source publication, original blob, routine text logging or backup entry is introduced. Results expire after five minutes and are discarded on insertion/close. Review recognized text before explicit insertion as plain editor-schema text, with no HTML interpretation or automatic save. Lock the note body while dictation/review is pending to retain the captured insertion position. Actual microphone hardware and end-to-end review/insertion qualification remain open; synthetic local recognition is separate evidence.

The native recognizer's timestamp sections are joined with spaces in dictation review, rather than promoting each sentence to a paragraph. Insert inline schema text at the captured position, with hard-break nodes for reviewed line breaks in ordinary blocks and literal newline text in code blocks. This retains surrounding block structure and does not parse HTML or apply paste/input rules. Convert existing raw newline text into hard-break nodes when opening non-code editor content, retaining marks/citations; native contenteditable input otherwise could remove those breaks. This is an in-memory editing representation until explicit Save. The native/editor integration exposed the prior paragraph-splitting behavior; corrected results are recorded separately from the earlier API probes.

Personal-note close protection compares serialized document content with its immutable editor-opening snapshot and compares the title with its initial value. Actual browser input/undo produced equivalent JSON whose ProseMirror identity-sensitive `eq()` comparison was false, so node identity is not the unsaved-change authority. Observe completed editor updates and report changed/voice-busy/saving state to a note-specific dialog before paint. Close/Escape uses an inline Keep editing/Discard draft decision, preserving the mounted editor until an explicit discard; pending saves disable close and refuse Escape. Editor-body Escape explicitly dispatches the dialog's guarded cancel path because the browser default did not consistently deliver it from contenteditable. A `beforeunload` listener exists only while one of those states needs protection, and is removed on reversion or unmount. Drafts remain in memory rather than localStorage or automatic database revisions. This closes an observed loss path without changing explicit Save, stale-save retention or transient dictation privacy.

Pending-upload cancellation now uses the client-generated recording key rather than waiting for the POST response's job ID. The same authenticated notebook dictation root accepts a DELETE JSON body capped at 1 KiB. A cancelled-key map retains only ownership and a ten-minute expiry; jobs plus markers are capped at 256, with admitted jobs reserving cancellation space. Excess unknown keys fail explicitly and cannot evict another marker. Duplicate cancellation is idempotent, foreign notebook keys are refused, and late POST/retry is rejected before decoding/recognition. Cancelling by the historical job-ID route uses the same protection. Native controllers retain their slot until extraction has settled after process exit. The client aborts pending uploads, sends cancellation without that aborted signal using keepalive, and cleans capture/review on pagehide or editor unmount. Pagehide delivery is best effort; browser/OS crash and lost network are not represented as guaranteed cancellation. No durable schema or output contract changes.

### Portable formatted export design, 2026-10-10

Extend the scoped artifact export GET with an explicit `format=html`, keeping default Markdown behavior. Resolve current export through the immutable current artifact revision just like historical export, and attach authored/generated status, creation time, revision identity and legacy-title qualification. Implement a small server-only renderer over the validated stored note/output structures rather than interpreting Markdown or arbitrary HTML. Escape all text/attributes, validate HTTP(S) links with the existing note-link policy, and resolve each footnote against a same-notebook immutable passage with exact Unicode quote/span verification. Missing/purged references become unavailable without exporting their old evidence quote. Refuse unavailable generated revisions. Reuse existing typed section/map/table/study contracts, retaining all inference/gap/coverage labels and excluding attempts.

The detached document has semantic HTML, fixed inline responsive/print CSS, no scripts or remote assets, and a meta CSP that denies all fetching/execution except its hash-allowlisted fixed stylesheet. No arbitrary CSS or DOM attributes originate in note data. Serve only as an attachment with a fixed filename, UTF-8 media type, no-store and nosniff, using existing session/notebook/revision checks. Reject outputs over five MiB. No new dependency, database/schema/output contract, provider permission, model request or automatic publication is needed. External publishing remains a distinct planned integration; acceptance follows the spec before implementation.

### Caption transcript files and deferred YouTube support, 2026-10-10

Use deterministic SRT/WebVTT parsing inside the existing bounded parser worker. Preserve declared timing, explicit cue labels, normalized Unicode wording and overlap; never repair/transcribe/translate with a model. Bound input lines, cue count, cue payload, timeline and extracted text, reject unsupported markup and malformed timing, and disclose omitted styles/positioning/karaoke timing. Extraction version 6 identifies the new file adapters without rewriting historical revisions.

The user subsequently deferred YouTube support. Remove the experimental retrieval adapter, service/API integration and development flag. A bounded anonymous probe returned an empty caption response and published no sources; preserve that failed observation as historical evidence without claiming working URL support. Caption file uploads remain independent.

### Voice questions only, 2026-10-10

The user specifies questions about existing notes only. Remove recording, insertion and recording-related close protection from the note editor. Render voice capture only for conversations pinned to saved note revisions; ordinary source conversations use typed questions. Preserve local transient recognition, review before question insertion, explicit Send, written answers and revision-scoped citations. Existing unsaved-change/save protection remains for typed note edits. Historical dictation qualification records describe an earlier interface and do not establish hardware acceptance of the current question flow. Generated audio and YouTube remain deferred.

### Google Drive retrieval design, 2026-10-10

Implement a server-only adapter over fixed Drive v3 `files.get` and `files.export` endpoints. Google documents binary downloads via `alt=media`, native export formats and download-capability checks ([download/export](https://developers.google.com/workspace/drive/api/guides/manage-downloads), [formats](https://developers.google.com/workspace/drive/api/guides/ref-export-formats)). Map Docs/Sheets/Slides to the existing DOCX/XLSX/PPTX worker; do not introduce a second text normalizer or resolve provider-returned download links. Provider versions are opaque decimal counters, kept separate from Codeboom revision IDs and immutable byte hashes.

Inject only a bounded access-token supplier and HTTP transport for deterministic tests; production creates endpoint URLs itself and refuses redirects before reading bodies. Apply one cancellation/deadline signal across token acquisition, metadata, content and post-download metadata, with incremental byte caps and fixed public errors. Validate identity, MIME/name, version/modified time, nontrashed state and `canDownload`; reject changes after retrieval and compare binary size/checksum. Do not export shortcuts/folders or acknowledge abusive files. Resource-key links may send the selected ID/key through Google's documented header, but keys and bearer credentials must not appear in returned provenance/logs. No connector credentials are imported from Codex tools.

The subsequent connection/API/UI stage must implement explicit external-browser OAuth consent, per-connection ownership, disconnect cancellation and credential storage outside notebook backups. Google requires a registered OAuth client and supports desktop loopback/PKCE ([desktop flow](https://developers.google.com/identity/protocols/oauth2/native-app)); authorization must not run in an embedded browser ([OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies)). Retrieval groundwork does not establish account connection, Drive refresh/sync, publishing or full expansion acceptance.

### Drive connection and secure credentials, 2026-10-10

Use explicit OAuth desktop consent in the external system browser with a random loopback callback, single-use state and S256 PKCE, requesting only Drive read-only scope. Tokens never enter notebook SQLite, source metadata, browser responses, logs or backups. Persist the connection in macOS Keychain through a fixed compiled Swift Security-framework helper, passing bounded requests/secrets only through stdin and draining diagnostics. Its service is fixed, its account key binds the absolute notebook data root and OS user, and returned credentials remain private server memory. Restoring into a new directory does not inherit the original connection. No plaintext credential fallback or Keychain-wide query is implemented.

`npm run drive:setup` compiles only the repository helper with Apple's local compiler. Existing Keychain access controls remain in force; OS denial fails visibly. OAuth/client configuration is separate from notebook data and loaded only from an explicitly configured Desktop client JSON file. The connection validates granted scope/token response shape, persists refreshes serially, cancels and awaits owned callbacks/exchanges on disconnect, and clears its Keychain entry. Local disconnect removes Codeboom access; revoking the provider-side grant remains available in the Google account. Explicit import routing and safe durable provenance follow this connection layer.


### Drive publication and refresh, 2026-10-10

Schema 15 adds revision-scoped provider metadata, reconstructed from a bounded allowlist and checked against the retained byte hash. Duplicate identity includes provider metadata so a changed Drive version with identical bytes still creates a new refresh revision. Credential and sharing resource keys never enter notebook jobs, sources, revisions, model passages or backups. The explicit import can use a sharing resource key in memory; refresh/retry use the canonical stored file link, so a key-dependent file may require the user to paste its sharing link again. This limitation is visible rather than persisting an access capability in the evidence archive.

Drive import reuses the existing slot, worker, cancellation, publication and notebook boundaries. Disconnect blocks new Drive jobs, aborts and awaits existing Drive imports, then disconnects the connection and clears its secure credentials; stored snapshots remain. A Drive source is routed by its recorded provider identity, never by an arbitrary credential-bearing URL. Original downloads for native Workspace files expose retained Office export bytes and the matching extension; immutable provider metadata is shown in current and historical evidence viewers.


The Desktop client reader also accepts Google’s documented historical `auth_uri`/`token_uri` spellings in downloaded JSON ([client-secret format](https://developers.google.com/api-client-library/dotnet/guide/aaa_client_secrets)). These values never select network destinations: authorization and exchange always use the fixed current endpoints. This avoids rejecting a standard downloaded Desktop credential while still refusing foreign endpoint configuration.


### Cited slides and PowerPoint export design, 2026-10-10

Output contract 7 adds a slide layout referencing existing fact/inference blocks, with all headline/body/speaker-note claims using the existing exact selected-passage citation validator. The model supplies no coordinates, markup, asset URL or executable presentation options. Concise structural bounds support a predictable local viewer and editable 16:9 text deck; empty/insufficient evidence stays a notice. Common immutable artifacts, cancellation/context keys, authored edits, exports and source promotion remain authoritative.

Evaluate/pin `pptxgenjs` 4.0.1 (official npm registry and [upstream](https://github.com/gitbrent/PptxGenJS/tree/v4.0.1), MIT). Use only native shapes/text and [speaker notes](https://gitbrent.github.io/PptxGenJS/docs/speaker-notes.html), serialize with [in-memory nodebuffer](https://gitbrent.github.io/PptxGenJS/docs/usage-saving/). Never invoke its file/image/HTML import paths. Dependency and archive inspections must establish no external asset relationships for this constrained writer. Full exact evidence goes into notes; concise visible reference numbers do not replace provenance. Refuse stale/purged/invalid generated material and overflow. Add bounded export admission and a final stored-revision availability check before HTTP delivery. Actual Office-viewer layout and semantic release review remain separate qualification requirements.


Dependency qualification found npm advisories GHSA-5p2g-fcmc-qvqq/GHSA-w3rx-r6r6-pgpr on the transitive `image-size` ≤2.0.2 parser. Pin PptxGenJS’s transitive parser to the official npm `image-size` 2.0.4 through a scoped override and rerun audit/export checks. This constrained writer never imports an image or calls parser APIs; expanding to image media must separately qualify the changed parser API. Do not downgrade or use a force-audit upgrade that changes unrelated dependencies.

### Recoverable note drafts, 2026-10-12

PN1 uses schema 17 and a separate `note_drafts` table in the existing local SQLite database. Draft titles and validated rich-note documents are scoped to a notebook and optional artifact/base revision. They are included in stopped backups and cascade with notebook deletion. Notebook views expose bounded recovery metadata; draft documents are absent from FTS discovery, source tools, exports and provider context. This supersedes the earlier in-memory-only draft decision. Voice recordings and question transcripts remain transient.

Each editor has an independent draft ID. A serial writer debounces updates by 400 ms, reports save status/failures and retries explicitly. Version checks reject divergent writes; a second editor recovering the same draft creates a separate copy on conflict. Identical retries after a lost response are idempotent. A recovered edit retains its original artifact revision as the publication base. Explicit note publication validates that base and the submitted draft version, then clears the draft in the same transaction as the note revision. Discard waits for the writer and clears its recovery record. Content-free tombstones reject delayed writes after Save/Discard. Reverting to the opening saved baseline clears that editor's recovery copy.

Use the existing same-origin session and notebook ownership checks for draft list/read/PUT/DELETE. Bound active drafts to 50 per notebook, title length to 200 Unicode characters, request bodies to two MiB and documents to the existing rich-note limits. Empty titles/content can be retained before publication. References must resolve exactly within the notebook or be inherited from that scoped saved revision/draft. Drafts are authored work: purging evidence retains their text and marks references unavailable, just as for authored notes; inherited missing references can be retained on explicit publication without admitting fabricated ones.

Page exit attempts to flush pending work, using keepalive only below 60,000 encoded request bytes. Recovery covers the last acknowledged database write; browser/OS termination or a lost connection can discard newer input. No unload transport guarantee, automatic publication, remote synchronization or new dependency is introduced.


### Individual note Trash and permanent deletion, 2026-10-13

PN2 uses schema 18: `artifacts.trashed_at` and an incrementing `trash_version`, plus content-free `deleted_notes` receipts scoped to the notebook. FTS triggers omit trashed notes and reindex on restore. The ordinary view hides trashed notes, their recovery drafts and quiz attempts; a separate metadata-only Trash list reports revision/draft/snapshot/conversation counts. Move/restore never create a note revision or a model request. History/reference reads remain exact; note editing, recovery publication, exports, new conversation creation and promotion require an active note. Existing snapshots and pinned conversations remain available while the note is trashed. Pending promotions fail and are aborted, preventing late extraction or duplicate acceptance; restoration requires explicit retry.

Permanent deletion requires a current trashed lifecycle version and explicit HTTP/UI confirmation. Invalidate active notebook runs and abort owned generation/import/recognition controllers. Recursively purge all sources with that note as their origin using the existing dependency policy, clear managed speech assets, then transactionally delete pinned conversations/runs/messages/events, promotion jobs, recovery drafts, quiz attempts, all revisions and the artifact. Detach purged revision foreign keys only after purge; retain minimal source tombstones and an unavailable deleted-origin explanation. Other authored notes keep their text with missing-reference labels. Original independent imports and the note's original chat/generation output remain; pre-existing backups/downloads cannot be revoked. Filesystem failure leaves the note in Trash for a safe retry. A matching deletion receipt makes a lost-response replay idempotent without retaining note text or titles.

Same-origin sessions and notebook ownership apply to every new endpoint. The note's displayed revision and Trash version reject stale moves; restore/delete reject stale lifecycles even after restore and another move. Image/PowerPoint export rechecks active-note state after asynchronous assembly. Current and genuine historical-schema backups preserve the lifecycle and migrate without rewriting history. No new package or provider capability is added. Bounded verification and unchanged human/release limits are recorded in verification.
