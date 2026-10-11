import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extract } from "../src/ingestion/extract.ts";
import { EXTRACTION_VERSION } from "../src/ingestion/version.ts";
import { extractIsolated } from "../src/ingestion/service.ts";
import { captionTime } from "../src/ingestion/captions.ts";
import { Store } from "../src/storage/store.ts";
import { backup, restore } from "../src/storage/backup.ts";
import { srtCaptions, vttCaptions } from "./fixtures/captions.ts";

test("SRT and WebVTT preserve timing, Unicode, negation, declared labels, overlaps and literal escaped markup", async () => {
  const srt = await extract(Buffer.from(srtCaptions), "srt");
  assert.deepEqual(srt.sections, [
    {
      locator: "Cue 1 · 00:00:01.250–00:00:03.500",
      text: "Do not approve the budget of £40.",
    },
    { locator: "Cue 2 · 00:00:03.000–00:00:05.000", text: "Café 🦉 & review." },
  ]);
  assert.match(srt.warnings.join(" "), /Overlapping/);
  const vtt = await extract(Buffer.from(vttCaptions), "vtt");
  assert.equal(
    vtt.sections[0].text,
    "[Speaker label: Morgan] Do not approve the budget of £40.",
  );
  assert.match(vtt.warnings.join(" "), /styles.*omitted/);
  const literal = await extract(
    Buffer.from(
      "WEBVTT\n\n00:00.000 --> 00:01.000\n&lt;script&gt;literal&lt;/script&gt; &#x1f989; &amp;lt;\n",
    ),
    "vtt",
  );
  assert.equal(literal.sections[0].text, "<script>literal</script> 🦉 &lt;");
  const karaoke = await extract(
    Buffer.from(
      "WEBVTT\n\n00:00.000 --> 00:02.000\nWords <00:01.000>continue\n",
    ),
    "vtt",
  );
  assert.equal(karaoke.sections[0].text, "Words continue");
  assert.match(karaoke.warnings.join(" "), /karaoke/);
  assert.equal(captionTime("24:00:00.000", "vtt"), 86400000);
});
test("caption parser refuses invalid encoding, binary data, malformed/empty/out-of-order cues and budgets atomically", async () => {
  for (const [kind, text] of [
    ["vtt", ""],
    ["vtt", "WEBVTT\n00:00.000 --> 00:01.000\nNo separator"],
    ["vtt", "WEBVTT\n\n00:60.000 --> 01:02.000\nInvalid time"],
    ["vtt", "WEBVTT\n\n00:02.000 --> 00:01.000\nBackwards"],
    ["vtt", "WEBVTT\n\n00:00.000 --> 00:01.000\n<script>unsafe</script>"],
    ["vtt", "WEBVTT\n\n00:00.000 --> 00:01.000\n<b></b>"],
    ["vtt", "WEBVTT\n\n25:00:00.000 --> 25:00:01.000\nToo long"],
    ["srt", "one\n00:00:00,000 --> 00:00:01,000\nBad identifier"],
    ["srt", "1\n00:00:00.000 --> 00:00:01.000\nWrong timestamp format"],
  ])
    await assert.rejects(extract(Buffer.from(text), kind));
  await assert.rejects(extract(Buffer.from([0xff, 0xfe]), "srt"), /UTF-8/);
  await assert.rejects(
    extract(Buffer.from(srtCaptions + "\0"), "srt"),
    /binary/,
  );
  await assert.rejects(
    extract(Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\n&#0;"), "vtt"),
    /character reference/,
  );
  await assert.rejects(
    extract(
      Buffer.from(
        "WEBVTT\n\n00:02.000 --> 00:03.000\nSecond\n\n00:01.000 --> 00:02.000\nFirst",
      ),
      "vtt",
    ),
    /ordered/,
  );
  await assert.rejects(
    extract(Buffer.from("WEBVTT\n" + "\n".repeat(100001)), "vtt"),
    /too many lines/,
  );
  await assert.rejects(
    extract(
      Buffer.from("WEBVTT\n\n00:00.000 --> 00:01.000\n" + "x".repeat(32001)),
      "vtt",
    ),
    /too long/,
  );
  const many =
    "WEBVTT\n\n" +
    Array.from({ length: 20001 }, () => "00:00.000 --> 00:01.000\nx").join(
      "\n\n",
    );
  await assert.rejects(extract(Buffer.from(many), "vtt"), /cue\/text budget/);
});
test("isolated caption extraction returns identical snapshots and completed cancellation", async () => {
  assert.deepEqual(
    await extractIsolated(Buffer.from(vttCaptions), "vtt"),
    await extract(Buffer.from(vttCaptions), "vtt"),
  );
  const controller = new AbortController();
  const pending = extractIsolated(Buffer.from(srtCaptions), "srt", {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(extractIsolated(Buffer.from("bad"), "srt"));
});
test("caption sources retain originals, exact citation spans, duplicate offers, history, backup and purge", async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "codeboom-captions-"));
  let store = new Store(path.join(base, "data"));
  try {
    const n = store.createNotebook("Captions").id,
      c = store.view(n).conversations[0].id;
    const bytes = Buffer.from(srtCaptions),
      result = await extract(bytes, "srt");
    const job = store.beginImport(n, "Captions", "original", { kind: "srt" });
    const source = store.publishImport(
      n,
      job.id,
      "Captions",
      "srt",
      null,
      bytes,
      result,
    );
    const p = store.selectedPassages(n, c)[0];
    assert.equal(p.extractionVersion, EXTRACTION_VERSION);
    assert.deepEqual(store.sourceOriginal(n, source, p.revisionId), bytes);
    const run = store.createRun(
      n,
      c,
      "What is the budget instruction?",
      "answer",
      "fixture",
      "answer",
    );
    store.completeRun(run.id, {
      status: "answered",
      title: "Instruction",
      blocks: [
        {
          kind: "fact",
          text: p.text,
          citations: [
            {
              passageId: p.id,
              quote: p.text,
              start: 0,
              end: Array.from(p.text).length,
            },
          ],
        },
      ],
      coverageWarnings: [],
    });
    const repeat = store.beginImport(n, "Repeat", "repeat", { kind: "srt" });
    store.publishImport(
      n,
      repeat.id,
      "Repeat",
      "srt",
      null,
      bytes,
      result,
      undefined,
      undefined,
      undefined,
      true,
    );
    assert.equal(store.importJob(n, repeat.id).status, "duplicate");
    assert.equal(
      store.resolveDuplicate(n, repeat.id, "reuse").source_id,
      source,
    );
    const updatedBytes = Buffer.from(srtCaptions.replace("£40", "£50")),
      update = store.beginImport(n, "Updated", "update", {
        kind: "srt",
        sourceId: source,
      });
    store.publishImport(
      n,
      update.id,
      "Updated",
      "srt",
      null,
      updatedBytes,
      await extract(updatedBytes, "srt"),
      source,
    );
    assert.equal(store.passage(n, p.id).text, p.text);
    store.close();
    backup(path.join(base, "data"), path.join(base, "backup"));
    restore(path.join(base, "backup"), path.join(base, "restored"));
    store = new Store(path.join(base, "restored"));
    assert.deepEqual(store.sourceOriginal(n, source, p.revisionId), bytes);
    store.purgeSource(n, source);
    assert.throws(() => store.passage(n, p.id), /unavailable/);
    assert.equal(readdirSync(store.blobs).length, 0);
  } finally {
    store.close();
    rmSync(base, { recursive: true, force: true });
  }
});
