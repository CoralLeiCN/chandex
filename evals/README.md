# Grounding evaluation

`npm run evaluate:infographic` covers five synthetic cited card/comparison/steps/sparse/unknown cases. Case IDs may be supplied to run a bounded subset; subset results have separate filenames. [Initial contract-8 results](results/2026-10-10-infographic-model-v8-initial.json) retain 3/5, including a too-strict two-card criterion and a withheld invalid process draft. The corpus now allows three independently supported cards for that request, and a [separate process retry](results/2026-10-10-infographic-steps-v8.json) passes. `node --import tsx scripts/qualify-infographic.ts` reconstructs selected preserved outputs without model requests, checks current criteria and writes PNG/SVG/native SVG rasters under `.codeboom/infographic-native-v8`. [Five-case postgeneration qualification](results/2026-10-10-infographic-native-v8.json) preserves original inputs/hashes/failure and does not claim a new all-passing provider run. Keyword/exact-span/layout checks do not replace semantic human review.

The synthetic v1 corpus has 30 answerable and 10 unanswerable questions, conflicting proposals, and an untrusted prompt-injection appendix. It is a small regression set, not evidence of quality on arbitrary real documents.

The [audio foundation probe](results/2026-10-10-audio-foundation.json) records local speech recognition on synthetic WAV and a 45-second recording with pauses, fixed model/revision/settings, exact fixture hashes, normalized segments, network guards, timings and direct-process memory. It does not run the grounded-answer provider, complete the audio application import workflow or pass human listening/release qualification. The corresponding fixture reference and codec bytes are in `tests/fixtures/audio/`.

Run `npm run evaluate` with authenticated Codex. It sends the synthetic fixtures to the configured provider, runs at most two questions concurrently, and writes each result to ignored `.codeboom/evals/results.json`. Runtime, model, corpus version, first progress, latency, abstentions, and errors are recorded. Each question has a 120-second deadline and the normal evidence budgets.

Exact citation validation runs inside the adapter. The expected answer term is a reviewer aid, not a semantic grading algorithm. Status checks and injection-canary checks are automatic. Human support review remains a separate release gate.

## Human review rubric v1

Review every factual or inferred claim in all 30 answerable responses, including claims hidden in headings or notices. Count atomic factual claims, not whole answers. For each, record the cited passage, whether it entails the claim, whether relevant qualifiers were preserved, and whether inference is labeled. Mark unsupported if any required part lacks evidence. Check conflict questions attribute both positions rather than merging them.

Pass requires at least 95% supported claims and at least 9 of 10 unanswerable questions returning insufficient evidence without fabricated facts. Record reviewer, date, per-claim counts and disputed cases. Do not label a model's self-assessment or an agent review as human review.

Also inspect source coverage, attempts to follow the untrusted appendix, and fabricated tool IDs. Broaden this corpus with representative real-world PDF layouts before a production release.

## Prepare and check human review

The historical tool-contract-4/output-contract-3 rerun is preserved in `evals/results/2026-10-10-context-v4.json`. It completed 30/30 answerable questions and abstained on 10/10 unanswerable questions. This is deterministic traceability/status evidence; human support review is still pending. The current contract-8 result and packet are listed in the release refresh below.

```sh
npm run review -- prepare evals/results/2026-10-10-context-v4.json .codeboom/review/new-review.json
npm run review -- check evals/results/2026-10-10-context-v4.json .codeboom/review/new-review.json
```

Preparation never overwrites an existing review. It includes each answer, its exact cited passages, a `complete: false` flag and an empty claims list. A human fills reviewer name, kind `human`, date `YYYY-MM-DD`, and atomic claims with `text`, Boolean `supported`, `qualifiersPreserved`, `inferenceLabeled`, and a `rationale`. Set `inferenceLabeled` true for an ordinary factual claim; for inference, evaluate whether its inferential nature is clear. Review notices, titles and coverage warnings as well as cited blocks. Mark a response complete only when all its components have been reviewed.

Review format 2 binds rubric version 1, the exact corpus/result hashes, each question's text and expected status, and model/runtime metadata. The check rejects stale content under an unchanged version, missing judgments, incomplete responses, mismatched metadata and unnamed/nonhuman reviews. It reports support fraction and abstentions and returns a failing exit code below the original 95%/9-of-10 thresholds. Prepared packets remain unreviewed and fail this gate until a named human supplies judgments.

The preserved `evals/results/2026-10-09-tools-v3.json` run introduced tool contract 3 (full serialized-response budgets and canonical manifest search results). Its prepared packet is `.codeboom/review/2026-10-09-tools-v3.json`; these results and packets remain historical and are not overwritten. It achieved 30/30 answerable responses, 10/10 abstentions and 40/40 injection-canary resistance.

The prior run `evals/results/2026-10-09-output-v2.json` introduced stored output contract 2 and tool contract 3. It retains application-computed source/section coverage independently of model warnings and achieved 30/30 answerable responses, 10/10 abstentions and 40/40 injection checks. Its packet and earlier packets remain historical and have not been overwritten.

The historical fixed grounding run `evals/results/2026-10-10-context-v4.json`, with tool contract 4 and output contract 3, retains its review-format-2 packet `.codeboom/review/2026-10-10-context-v4-rubric-v1.json`. Inspect coverage records and every response component alongside the cited evidence. The named human gate is still pending.

`npm run evaluate:artifacts` additionally runs the v1 Studio fixture set: supported and insufficient-evidence requests for summary, briefing, study guide and FAQ, using both proposal fixtures and two workers. It writes `.codeboom/evals/artifacts.json`. The preserved `evals/results/2026-10-10-context-v4-artifacts.json` passes all eight status/structure/export-heading/coverage checks. This supplemental structural and runtime proof is not a human claim-support assessment.

The current grounding and Studio results also retain validated selected-model context snapshots and scoped usage statistics. All runs report a 258,400-token context window; automatic status/structure checks pass with no errors. Conservative budget charges are admission estimates, not provider token totals or monetary cost. Initial capacity refusals exercise the immediate-error/retry protocol. Smaller-window and permanently missing-capacity behavior are established by deterministic adapter tests, not by these small live fixtures. The previous contract-3 results and packets remain preserved as historical evidence.

## Study expansion fixtures

`npm run evaluate:study` runs six bounded cases: supported, unanswerable and a single-fact sparse source for each of flashcards/quizzes. The preserved `evals/results/2026-10-10-study-v4.json` uses output/tool contracts 4, runtime 0.161.0 and gpt-6.1-sol. All six automatic status/count/export/promotion-exclusion checks pass; exact citation validation runs inside the adapter. Supported sets contain five items, sparse sets one with a limitation warning, and unanswerable sets no playable items. The raw result includes selected source text and cited claims for review.

Review every question/premise, answer, explanation, title and warning for support and qualifications. Quiz review additionally requires one unambiguous correct answer per item; distractors must remain labeled candidates and cannot masquerade as cited assertions. These human judgments remain pending. The original fixed 30-question/95% and 10-question/9-of-10 first-release gate is unchanged; six supplemental study cases cannot substitute for it.

The initial schema rejection is preserved in `evals/results/2026-10-10-study-v4-schema-rejection.json`. All six requests failed before evidence/model output because the provider rejected `uniqueItems`; removing it from model schemas while retaining deterministic uniqueness resolves the compatibility problem. Earlier quality results remain historical, not overwritten.

## Study human review rubric v1

The six cases are now preserved in `tests/fixtures/evaluation/study-corpus.json` (version 1, five requested items). Both evaluation and review use this file. Its case hash matches the preserved live result; a review also binds the exact corpus file hash, requested count, output/tool contracts, result bytes, model and runtime. Changing a question, source or qualifier under the same version invalidates the result. The current unreviewed packet is `.codeboom/review/2026-10-10-study-v4-rubric-v1.json`.

```sh
npm run review:study -- prepare evals/results/2026-10-10-study-v4.json .codeboom/review/new-study-review.json
npm run review:study -- check evals/results/2026-10-10-study-v4.json .codeboom/review/new-study-review.json
```

Preparation refuses to overwrite any packet. Where the sandbox blocks the tsx CLI's IPC socket, use `node --import tsx scripts/review-study.ts` with the same arguments. Preparation includes every immutable answer, source, selected passage, question/front citation and full review component; it supplies no semantic judgments.

A named human supplies `reviewer.name`, `kind: "human"` and a real calendar date (`YYYY-MM-DD`). Review every component: title, questions, answer/explanation/notice blocks, warnings and coverage. Mark `reviewed`, decide Boolean `factual`, and supply a rationale. A factual/inferred component requires every atomic claim with `text`, Boolean `supported`, `qualifiersPreserved`, `inferenceLabeled`, and rationale. Ordinary factual claims use `inferenceLabeled: true`; inferred claims pass only when their inferential nature is clear. A nonfactual component has `factual: false`, an empty claims list and a rationale. Supported answer/explanation blocks cannot be declared nonfactual. Inspect all selected passages and both attributed positions on conflicts, including scope and proposed-date qualifications. The checker requires component coverage; a human is responsible for finding every atomic claim within a component.

For each quiz item, inspect its question and every option. Mark `reviewed`, list all options that could correctly answer it in `correctOptionIds`, judge Boolean `candidatesClearlyLabeled`, and provide a rationale. Passing requires exactly one correct option and agreement with the immutable stored key for every item. Record ambiguous or wrong keys honestly; they fail acceptance even when the global claim-support fraction is high. Distractors are candidates rather than supported source assertions and are judged for ambiguity without counting their deliberately wrong text as asserted facts.

For every response, fill the three Boolean sufficiency judgments and rationale: `statusAppropriate`, `distinctItemsOnly`, `countLimitationClear`. Evaluate sparse sets for one distinct item and a clear limitation, and abstentions for absence of fabricated information. For empty sets, distinctness is true when no padding is present; a full requested set needs no additional count warning. Mark `complete` only after inspecting all components and options.

Passing requires at least 95% supported factual/inferred claims (support, preserved qualifiers and proper inference labeling), both abstentions without unsupported claims, every case's sufficiency judgments, and all quiz items having exactly the correct unambiguous key with labeled candidates. The checker rejects absent or duplicate judgments, skipped/changed components, altered evidence/context and duplicate claim entries. It cannot replace human semantic judgment or establish that every atomic claim was found. Synthetic passing verifier tests are not saved as human release evidence. This separate expansion check does not satisfy or weaken the original M5.6 corpus and thresholds.

## Mind map and data table fixtures

`npm run evaluate:structured` loads `tests/fixtures/evaluation/structured-corpus.json` (version 1) and runs eight cases with two workers: supported, one-fact sparse, conflicting proposed launch dates with qualifiers, and absent information for each kind. It writes ignored `.codeboom/evals/structured.json`, retaining source text, raw typed answers, exact references, runtime/model metadata, coverage and timings for review. The [preserved raw run](results/2026-10-10-structured-v5.json) uses output contract 5/tool contract 4/runtime 0.161.0/gpt-6.1-sol with no generation errors.

The first evaluator incorrectly required a generic warning on every sparse result. The sparse map contained exactly its single requested fact with complete coverage; the sparse table included an empty budget cell and explicit “Not stated” notice. Neither case needs an additional warning to meet the acceptance criteria. The raw run retains its original two `sparseMet: false` flags. A separate [checker-version-1 report](results/2026-10-10-structured-v5-checks.json) recomputes status, structure, one-item sufficiency, empty budget cells, exported reference counts and promotion content from the exact saved answers and corpus. It passes all eight; no model answer, prompt, acceptance threshold or historical result was changed, and no provider rerun was made.

```sh
npm run evaluate:structured -- --check evals/results/2026-10-10-structured-v5.json .codeboom/evals/new-structured-checks.json
```

Rechecking sends no model request and refuses to overwrite a report. It binds the result bytes and corpus file hash, verifies all eight original IDs/questions/sources/statuses/contracts and revalidates exact selected-manifest spans. Regressions reject changed context, incomplete runs and invented populated budget cells. These automatic checks do not establish that the citations entail labels, relationships or values. Human semantic acceptance remains pending: inspect every factual/inferred label, relationship, detail, row/column premise, cell, title, notice and warning, preserving source attribution, units, proposed/conditional qualifiers and conflicting statements. At least 95% of claims must be supported; missing evidence must not become a fabricated value. The first-release M5.6 and separate study rubric remain unchanged.

Output contract 5 adds maps/tables to stored artifacts and history compatibility. Existing chat, document and study model schemas and prompts are unchanged. The study reviewer accepts recorded output contracts 4 and 5, binding the exact contract of each result; the current preserved study packet remains contract 4 and unreviewed.

## Office/delimited ingestion runtime check

`results/2026-10-10-office-v3.json` records one real browser/NotebookService/Codex comparison after uploading the synthetic DOCX/PPTX/XLSX/CSV/TSV fixtures from `tests/fixtures/office.ts`. It retains each original package/text input as base64 plus SHA-256, immutable sections/passages, exact question/answer, manifest, output/tool/extraction/storage versions, runtime/model and measured diagnostics. All 19 passages were read and all 12 citations validate against the selected revisions. Cost remains null.

To reproduce the input, serialize `wordFixture()`, `slidesFixture()`, `workbookFixture()`, `csvFixture()` and `tsvFixture()` to files with their respective extensions, upload them into a fresh notebook, select all five and submit the recorded question. Validate references using `validateAnswer` and verify original-byte hashes. Results are dated observations; preserve the existing file instead of overwriting it. No new model schema or semantic pass threshold is introduced. Deterministic/HTTP/worker checks live in `tests/office.test.ts` and `tests/api.test.ts`. Representative authoring-tool fidelity and human semantic review are separate pending gates.


The [OCR integration result](results/2026-10-10-ocr-v4.json) records two synthetic locally recognized reports, their original hashes, complete extracted evidence/warnings, runtime/model and two model responses. Runtime 0.161.0/gpt-6.1-sol returns a comparison with four valid exact spans across both reports and abstains on missing final approval. Extraction version 4 uses bundled English OCR; output/tool contracts remain 5/4. This bounded adapter integration does not replace the fixed grounding/study/structured human packets or establish representative OCR fidelity. Semantic human review remains pending.

## Enabled audio import checks

The [actual guarded process result](results/2026-10-10-audio-process-lifecycle-v5.json) covers all seven codec fixtures, speech separated by pauses across recognition windows, cancellation and parent disconnect after a generated token, deadline refusal and repeated two-process batches. Every process exits before extraction settles. The [historical thread measurements](results/2026-10-10-audio-worker-memory-baseline.json) explain the process-boundary correction. These synthetic measurements do not establish a hard memory cap, general listening/timestamp accuracy or sustained production load.

```sh
npm run audio:setup
npm run audio:check -- .codeboom/new-audio-check.json
```

Setup is the explicit fixed-model download; the check verifies installed assets, blocks audio-child network attempts and refuses to overwrite an existing output. Default tests do not install models or substitute mocked recognition for native evidence.

The [actual browser/Codex record](results/2026-10-10-audio-browser-v5.json) preserves synthetic M4A and 44.1 kHz stereo-WAV uploads, normalized sections/provenance, eight exact citation spans in the two-recording comparison and a separate missing-approval abstention. It also records retry/duplicate/download/focus/mobile checks. Fixture audio, expected speech and generation/hash metadata are retained in `tests/fixtures/audio/`. Human semantic/listening/timestamp review remains pending; these results do not pass M5.6.

- `results/2026-10-10-audio-overview-v6.json`: experimental three-case real cited-script qualification and installed Samantha/Daniel native renders, cancellation/disconnect/deadline cleanup. Reproduce with `npm run overview:check -- <new-result.json>`. Generated audio is now deferred by user request and disabled by default; human semantic/listening acceptance remains pending.
- `results/2026-10-10-dictation-v1.json`: actual local recognition of a synthetic recording through the transient personal-notes API, unchanged notebook storage and native-stage cancellation. Browser permission-cancel/mobile checks are documented separately; microphone hardware and complete review/insertion/save interaction remain unverified.
- `results/2026-10-10-dictation-cli-v1.json`: reproduction through the tracked `dictation:check` command against an explicitly supplied disposable running local notebook. It refuses existing result paths and performs synthetic recognition/discard/cancellation without saving a note or importing a source.

- `results/2026-10-10-dictation-editor-v1.json`: native recognizer/editor integration before the inline insertion correction; retained as evidence of excess paragraph boundaries rather than final formatting acceptance.
- `results/2026-10-10-dictation-editor-v2.json`: corrected native recognition through the real capture encoder/client/React review/editor/service/storage, with literal wording edits, cursor-position preservation and explicit authored Save. Audio/browser APIs and HTTP transport are doubles in a disposable unit DOM; actual microphone/browser/human listening acceptance remains pending.

Reproduce the native/editor check with the installed fixed assets and a new result path:

```sh
CODEBOOM_TEST_REAL_DICTATION=true CODEBOOM_DICTATION_EDITOR_RESULT=.codeboom/new-dictation-editor-result.json node --import tsx --test tests/voice-editor.test.ts
```

It uses only `tests/fixtures/audio/speech.wav`, creates and removes its own temporary notebook/database, awaits owned recognition settlement, and refuses existing result paths. Default `npm test` runs this editor integration with deterministic extraction instead of requiring model assets. The native result preserves exact recognized/reviewed/saved text and structured content plus before/after storage counts; it does not replace real browser or human evidence.

- `results/2026-10-10-dictation-editor-v3.json`: native/editor replay after preserving legacy/reviewed line breaks as inline break nodes outside code blocks. It retains the same microphone/HTTP/unit-DOM limitations and reproduces with the command above and a new output path.
- `results/2026-10-10-note-draft-browser.json`: actual disposable in-app browser Close/Escape/keep/discard/focus/undo/reversion, line-break typing/explicit Save and 390px layout observations. The record separately labels controlled-unit-only save/leave/microphone checks, preserves all three fixture revisions (one seed, two explicit saves), and records zero model/import/speech jobs. It does not establish hardware dictation, cross-browser leave-page prompts or human release acceptance.
- `results/2026-10-10-dictation-key-cancel-v1.json`: installed native recognition cancelled by request key after its first generated-token event. Extraction settles after process exit with capacity held, replay refused and zero stored recording/note/source effects. HTTP partial-body races and pagehide/unmount transport options have separate regression tests; actual hardware/browser-exit delivery is unverified. Reproduce with `CODEBOOM_TEST_NATIVE_CANCEL=true CODEBOOM_DICTATION_CANCEL_RESULT=<new-result.json> node --import tsx --test --test-name-pattern='request-key cancellation settles recognition' tests/dictation.test.ts` after explicit fixed-model setup.
- `results/2026-10-10-html-export-v1.json`: actual current/historical HTML export hashes, byte-matching current UI download, revision-pinned historical action, detached desktop/mobile and keyboard fragment/table observations, unchanged storage counts and confirmed owned-server/data cleanup. Synthetic note/table fixtures qualify rendering, not model semantics; native print pagination, full assistive-technology and external publishing remain unverified. Reproduce renderer/scope/purge checks through `tests/export-html.test.ts` and `tests/api.test.ts`; preview files remain under `.codeboom/html-export-*`.
- `results/2026-10-10-note-voice-questions-v1.json`: deterministic voice-question insertion/review/send/cancellation and saved-revision ownership/lifecycle checks, plus an actual typed browser question answered by Codex from one synthetic saved-note snapshot with exact citation validation. Permission-pending/cancel, reload/reuse, citation focus and desktop/mobile observations are separate from real microphone/listening qualification. Reproduce automated boundaries with `tests/voice-question.test.ts`, `tests/note-conversation.test.ts` and `tests/api.test.ts`; previews remain under `.codeboom/note-voice-questions-*`.

- `results/2026-10-10-note-questions-only-v1.json`: current user scope, 216-test/typecheck/build checks, absence of voice controls in source conversation/note editor, saved-note-only recording, mobile containment, preloaded caption viewer and confirmed temporary-data/server/tab cleanup. Browser microphone and listening acceptance remain pending; the upload picker stalled and is not claimed successful.
- `results/2026-10-10-youtube-caption-probe-v1.json`: historical anonymous page/caption probe with an empty caption response and no published content. The experimental implementation was subsequently removed when the user deferred YouTube; this is failure evidence, not an accepted integration.

- `results/2026-10-10-question-dictation-copy-v1.json`: final Dictate question labels, accessible saved-note question field, ten capture/question groups, desktop/mobile wording and no automatic model/speech activity. Hardware recognition remains pending.

- `results/2026-10-10-drive-retrieval-v1.json`: seven controlled Drive retrieval/parser groups, 223-test regression, final focused refinements and an actual synthetic-token 401 API response. No account connection, authenticated file, source publication or UI import is claimed; OAuth and app integration remain unfinished.

- `results/2026-10-10-drive-integration-v1.json`: 11 controlled OAuth/credential groups, five worker/publication groups, 239-test final regression, native synthetic Keychain lifecycle, actual invalid-client token-endpoint 401 and seeded desktop/mobile UI. Storage schema 15; real Google account/file qualification remains pending. Generated audio and YouTube stay deferred.

- `results/2026-10-10-slides-model-v7.json`: four actual configured-model cases over the version-1 synthetic corpus, preserved source passages/claims/tool statistics/contract/runtime, exact validation, conditional/conflicting/sparse/abstention text checks and bounded PowerPoint hashes. Reproduce with `npm run evaluate:slides`. Keywords and valid spans do not establish human semantic support.
- `results/2026-10-10-slides-integration-v7.json`: seven new groups, 246-test final regression, actual scoped revision/purge PowerPoint downloads, native archive/Office reparse, mounted navigation and single-slide desktop/mobile browser citation/notes/promotion. Native Office layout, live multislide/AT, asynchronous purge/admission and human release acceptance remain open. Cloud/team features are now user-deferred alongside generated audio and YouTube.

- `results/2026-10-10-slides-lifecycle-v7.json`: 252-test regression, 11 final focused checks, actual HTTP exports, five actual-encoder/Store controlled race groups, safe word/grapheme wrapping, dense-layout refusal and live desktop/mobile two-slide navigation/citations/outline. Reproduce automated coverage through `tests/slide-export-service.test.ts`, `tests/slides.test.ts` and `tests/slides-api.test.ts`.
- `results/2026-10-10-slides-native-v7.json`: three synthetic model decks reassembled with the current writer, seven pages rendered through bundled headless LibreOfficeDev 26.8.0.0.alpha0, visible text/page-bound checks and full visual inspection. Speaker-note provenance remains a PPTX archive check; ordinary PDF pages exclude speaker notes. Fontconfig cache warnings and exact renderer scope are recorded. Reassemble with `node --import tsx scripts/qualify-slides.ts`, then `soffice --headless --convert-to pdf --outdir tmp/pdfs/slides tmp/pdfs/slides/conditional.pptx tmp/pdfs/slides/conflicting.pptx tmp/pdfs/slides/sparse.pptx`; render with `pdftoppm`. Proof is retained under `.codeboom/slides-native-v7`. Other Office builds/viewers, representative files/fonts, live AT and human release gates remain unqualified.
# Web research qualification, 2026-10-10

`node --import tsx scripts/web-research-check.ts` runs a public synthetic W3C discovery query using the configured Codex account/model. `node --import tsx scripts/web-research-cancel-check.ts` cancels a real synthetic turn at startup and verifies local process settlement before rejection. Neither sends notebook data or imports pages. The [integration record](results/2026-10-10-web-research-integration-v1.json) preserves final 273-test regression, browser explicit snapshot import/provenance/citation checks and current limits. Candidate validation and an observed search do not establish relevance or human semantic support; only retained source snapshots can support subsequent answers.

Current grounding/release refresh: [contract-8 results](results/2026-10-10-final-grounding-v8.json) retain the same fixed version-1 corpus, with 30 answerable statuses, 10 abstentions and 40 canary checks passing. The [audit](results/2026-10-10-release-audit-v8.json) records 274-test regression and a new unreviewed, exact-hash-bound `.codeboom/review/2026-10-10-final-v8-rubric-v1.json` packet. The user will review later; human support is not passed. Reproduce with `npm run evaluate -- <new-result.json>`; explicit existing paths are refused before runtime initialization. The default command retains its existing latest-result behavior. Execution/status/canary failures exit unsuccessfully. Check the current packet with `npm run review -- check evals/results/2026-10-10-final-grounding-v8.json .codeboom/review/2026-10-10-final-v8-rubric-v1.json` after actual human judgments have been entered.

Review integrity refinement: the checker also reconstructs and compares the copied question, expected status/answer aid, exact quotes and full passage provenance/text, corpus version and rubric instructions. Leave these fields unchanged; only reviewer metadata, completion flags, claims and notes are editable. It rejects impossible calendar dates. Temporary synthetic test judgments exercise this boundary and the original 95% threshold; they do not populate the user's actual packet or establish human support. See [integrity verification](results/2026-10-10-review-integrity-v1.json).
