import type { Store } from "../../src/storage/store.ts";
import { extract } from "../../src/ingestion/extract.ts";
import type { Answer, Passage } from "../../src/domain/evidence.ts";
import { artifactSections } from "../../src/domain/artifacts.ts";
import {
  SPEECH_PROVIDER_ID,
  SPEECH_RENDERER_VERSION,
} from "../../src/domain/audio-overview.ts";

// Synthetic PCM is for storage/HTTP boundary tests, never speech fidelity evidence.
export function speechWav({
  seconds = 0.1,
  rate = 22050,
  channels = 1,
  silent = false,
} = {}) {
  const samples = Math.ceil(seconds * rate),
    bytes = Buffer.alloc(44 + samples * channels * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let i = 0; i < samples * channels; i++)
    bytes.writeInt16LE(
      silent ? 0 : Math.round(8000 * Math.sin(i * 0.1)),
      44 + 2 * i,
    );
  return bytes;
}
export function speechResult(voiceId = "samantha") {
  return {
    bytes: speechWav(),
    provider: SPEECH_PROVIDER_ID,
    voiceId,
    rendererVersion: SPEECH_RENDERER_VERSION,
    osVersion: "synthetic test renderer",
  };
}
export function overviewAnswer(p: Passage): Answer {
  const citation = {
    passageId: p.id,
    quote: p.text,
    start: 0,
    end: [...p.text].length,
  };
  return {
    status: "answered",
    kind: "audio-overview",
    title: "Pending proposal",
    blocks: [
      {
        kind: "fact",
        text: "The proposal requests three hundred units. Approval is still pending. Do not start the rollout.",
        citations: [citation],
      },
      {
        kind: "inference",
        text: "The proposal is not an approval to spend.",
        citations: [citation],
      },
      {
        kind: "notice",
        text: "The source gives no final approval date.",
        citations: [],
      },
    ],
    sections: artifactSections["audio-overview"].map((section, i) => ({
      key: section.key,
      blockIndexes: i === 0 ? [0] : i === 1 ? [1] : i === 3 ? [2] : [],
    })),
    coverageWarnings: ["Only the selected proposal was read."],
  };
}
export async function seedOverview(
  store: Store,
  notebook?: string,
  key = "overview",
) {
  const n = notebook ?? store.createNotebook("Speech fixture").id,
    c = store.view(n).conversations[0].id;
  if (!store.selectedPassages(n, c).length) {
    const bytes = Buffer.from(
      "The proposal requests three hundred units. Approval is still pending. Do not start the rollout.",
    );
    store.publishImport(
      n,
      store.beginImport(n, "Proposal", key + "-source").id,
      "Proposal",
      "text",
      null,
      bytes,
      await extract(bytes, "text"),
    );
  }
  const passage = store.selectedPassages(n, c)[0],
    answer = overviewAnswer(passage);
  const run = store.createRun(
    n,
    c,
    "Create a cited audio overview",
    "audio-overview",
    "fixture",
    key + "-run",
  );
  store.completeRun(run.id, answer);
  const artifact = store
    .view(n)
    .artifacts.find((a: any) => a.run_id === run.id);
  return {
    n,
    c,
    a: artifact.id as string,
    revision: artifact.revision_id as string,
    passage,
    answer,
    run: run.id as string,
  };
}
