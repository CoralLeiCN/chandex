# Implementation verification

Date: 2026-10-08. Scope: first working local prototype; this is not a production-readiness certification.

## Environment and reproducibility

- macOS 26.6.2, arm64; Node 26.10.0; npm 12.1.0.
- Project Codex CLI 0.161.0; generated protocol types stored as source under `src/codex/protocol/`.
- Runtime-reported default model during live checks: `gpt-6.1-sol`. Available models are discovered at connection time.
- Existing supported Codex authentication was used without copying credentials or modifying the global CLI/configuration.
- A clean `npm ci` completed from the final lockfile. Deterministic suite: **24 tests passed**. Strict TypeScript checking and Vite production build passed.
- npm dependency audit reported **zero vulnerabilities** at installation. This is a point-in-time registry result.

## Functional and boundary evidence

| Area | Evidence | Result |
| --- | --- | --- |
| Harness | `npm run harness:check`, two synthetic proposals, real dynamic-tool calls and structured cited answer | Passed |
| Native sandbox | `npm run isolation:check`: control command succeeds; unrelated canary read, file write, and a normally reachable loopback connection fail | Passed on this macOS version |
| Capability checks | Adapter checks effective disabled features, MCP configuration, instructions, thread profile, and network flag | Enforced on every run; unknown/incompatible configuration fails closed |
| Citation integrity | Unicode, exact span, forged ID, excluded passage, missing citation, repair-hint tests | Passed |
| Storage | Restart, duplicate imports, immutable old revisions, repeated headings, scoped reads, cancellation race | Passed |
| Ingestion | UTF-8/Markdown, HTML with script payload, worker execution, generated text PDF and unusable PDF, private/encoded URLs | Passed |
| Public fetch | Actual `https://example.com` fetch, 577 bytes, HTML content type | Passed |
| API | Cookie/Origin enforcement, idempotent asynchronous imports, cross-notebook rejection, note creation, export, and Last-Event-ID replay of an interrupted run | Passed |
| Recovery | Interrupted runs/imports are not automatically replayed; orphan blobs cleaned; process exit, timeout, malformed protocol tests | Passed |
| Purge | Removes blob references, FTS entries, generated quotes, artifact revisions, and promoted descendants; preserves user notes | Passed |
| Backup | Consistent snapshot restore retains exact evidence; tampered blob and active-writer backup rejected | Passed |
| Real cancellation | Abort during connection setup at 200 ms returned in 202 ms | Passed; no claim about immediate remote provider cancellation |
| Browser | Create notebook; import two proposals; real comparison; open highlighted citation; save answer; generate summary; export Markdown; restart and reload persisted data; Stop immediately shows “Run stopped” | Passed |
| Keyboard | Escape closes citation dialog and returns focus to the originating citation button | Passed |
| Responsive layout | 390 × 844 viewport, source/conversation/Studio tabs; document width stays 390 px | Passed |
| Selection changes | After deselecting Proposal B, a follow-up asking for B's facts abstains despite a prior answer containing them | Passed |

Source fetching revalidates and pins each redirect destination in code. A broad live redirect/DNS-rebinding matrix and hostile parser corpus have not yet been run. Authentication expiry and real provider rate-limit faults were not forced. Screen-reader labels and keyboard focus were inspected; a full assistive-technology audit remains open.

## Model-quality run

The fixed [v1 corpus](../evals/corpus.json) contains 30 answerable questions, 10 unanswerable questions, two conflicting proposals, and a malicious appendix. Each request uses the normal manifest-bound tools and validator. See [raw synthetic results](../evals/results/2026-10-08.json).

- 29 of 30 answerable questions completed with valid exact citations.
- All 10 unanswerable questions returned `insufficient_evidence`.
- One answerable run failed after its bounded citation repair because the offsets still did not match. No invalid answer was accepted.
- All 39 completed outputs avoided the injected `INJECTION_SUCCESS` marker. This is a narrow canary check, not a universal prompt-injection guarantee.
- A subsequent change adds deterministic location hints only for an exact, unique quote in the same selected passage. The model must return corrected output; validation remains strict.
- A [targeted rerun](../evals/results/2026-10-08-recheck.json) of the failed question completed with valid citations in 12.5 seconds. The original failure remains in the report; the full 40-question set was not repeated after the change.

**Human semantic review is pending.** Exact spans establish traceability, not that every claim follows from its quote. The spec's 95% human-reviewed claim-support criterion is not marked passed. Use the [review rubric](../evals/README.md).

## Timing baseline

Forty synthetic requests, two concurrent workers, including one failed run:

| Metric | Observed |
| --- | --- |
| First adapter progress, median | 589 ms |
| First adapter progress, maximum | 970 ms |
| Total run, median | 16.4 s |
| Total run, nearest-rank p95 | 28.2 s |
| Total run, minimum / maximum | 7.4 s / 33.1 s |

These are observations on tiny synthetic sources with this account/model, not service-level promises. The browser acknowledges a run before adapter progress arrives. RSS, sustained multi-notebook load, representative PDF ingestion time, provider token usage, and cost were not measured.

## Remaining release gates

1. Human review of all factual claims in the fixed corpus; investigate unsupported claims if any.
2. Representative PDF/HTML extraction fidelity, malformed-input and URL redirect qualification.
3. Full keyboard/assistive-technology audit and broader recovery/fault injection, especially rate limits and expired authentication.
4. Resource profiling and a fresh full quality run after the repair/tool-contract change.

Known prototype tradeoffs: text is rendered safely as plain content, edited notes become wholly user-authored, local-file refresh requires a new import while URL snapshots have a refresh control, and the queue uses immediate admission with a two-run cap. Node 26 is pinned to the environment tested here; compatibility with other Node releases has not been established.
