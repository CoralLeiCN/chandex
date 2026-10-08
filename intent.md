# Codeboom intent

Build a research notebook inspired by NotebookLM and Gemini Notebook, with Codex as the agent harness. Users should be able to collect sources, understand them through conversation, and turn their findings into useful research and study materials.

Codex is part of the product's runtime: it handles reasoning, tool use, and conversation execution. Codeboom owns the notebooks, source storage, retrieval, citations, and saved outputs.

## User outcome

A user can bring together documents about a topic, ask questions across selected sources, inspect the evidence behind an answer, and save the result for later use.

The core workflow is:

1. Create a notebook for a topic or project.
2. Add sources and inspect their import status.
3. Select the sources to use for a question.
4. Ask questions, compare accounts, and identify disagreements or missing evidence.
5. Open citations at the supporting passages.
6. Save notes and generate summaries, briefing documents, study guides, and FAQs.
7. Return later with the notebook, conversation, and evidence links preserved.

## Planned sources

The proposed first version accepts:

- PDFs with selectable text, uploaded locally or imported from a direct PDF URL.
- Markdown files (`.md`).
- Plain-text files (`.txt`).
- Pasted text.
- Public HTML web pages.

Later source support includes:

- Word documents.
- Slide decks.
- Spreadsheets.
- Images and scanned PDFs through OCR.
- Audio through transcription.
- YouTube transcripts.
- Google Drive imports.

The first-release source types are implemented in the local prototype; later formats remain planned. Unsupported or failed imports must be clearly identified, and incomplete extraction must not appear complete.

## Evidence principles

Answers should be grounded in the sources the user selected. Every substantive factual claim should have an inspectable citation. Where the evidence is insufficient or contradictory, the answer should say so and distinguish source statements from inference.

Preserve immutable source revisions so existing citations keep pointing to the evidence used when an answer was generated. Changing the selected sources must also change the model's usable context; excluded sources must not remain available through old conversation history.

Treat source content as data. Text inside a document must not grant access to unrelated files, change the application's instructions, or authorize external actions.

Generated notes and summaries are derived work. They should retain their provenance and should not automatically become independent evidence.

## Proposed first version

Start with a single-user local web app organized around sources, conversation, and notes or generated materials. Keep notebook data in local storage, while making clear that model inference sends selected context to the configured provider.

Use a narrow Codex integration that can retrieve source passages, produce structured answers, report progress, and cancel work. Validate citation references before saving completed outputs.

The local web app, exact technology stack, initial source limits, and feature sequencing are proposed defaults that can be revised. The established direction is a notebook experience powered by the Codex harness.

## Longer-term direction

Expand toward flashcards, quizzes, mind maps, richer document imports, audio overviews, slides, and other reusable outputs. Add web-assisted research as an explicit mode with clear evidence boundaries.

Sharing, collaboration, connector synchronization, and hosted deployment are later extensions. The first useful release should establish reliable source handling and cited answers.

## First proof of the idea

Import two text sources, ask Codex a question that requires evidence from them, and open each answer citation at its supporting passage. Save the answer as a note and recover it after restarting the application.

This small working flow should validate the harness integration and source boundaries before expanding the interface and feature set.

See the [product and technical specification](docs/spec.md) for architecture, contracts, milestones, and acceptance criteria.
