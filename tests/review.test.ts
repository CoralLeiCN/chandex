import { groundingReviewResult } from "./fixtures/evaluation-results.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
test("human review binds the exact corpus, questions, rubric and results before accepting judgments", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-review-"));
  const resultPath = path.join(root, "result.json");
  const packetPath = path.join(root, "packet.json");
  const result = groundingReviewResult();
  const run = (mode: string, packet = packetPath) =>
    execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/review.ts", mode, resultPath, packet],
      { encoding: "utf8", stdio: "pipe" },
    );
  const failure = (fn: () => unknown, message: RegExp) =>
    assert.throws(fn, (error: any) => message.test(String(error.stderr)));
  try {
    writeFileSync(resultPath, JSON.stringify(result));
    run("prepare");
    const packet = JSON.parse(readFileSync(packetPath, "utf8"));
    assert.equal(packet.format, 2);
    assert.equal(packet.rubricVersion, 1);
    assert.equal(packet.corpusHash, result.corpusHash);
    failure(() => run("check"), /named, dated human review/);
    packet.rubricVersion = 0;
    writeFileSync(packetPath, JSON.stringify(packet));
    failure(() => run("check"), /rubric version/);
    result.corpusHash = "stale-corpus";
    writeFileSync(resultPath, JSON.stringify(result));
    failure(
      () => run("prepare", path.join(root, "stale.json")),
      /content hash/,
    );
    result.corpusHash = packet.corpusHash;
    result.results[0].question =
      "Different question under the same version and ID";
    writeFileSync(resultPath, JSON.stringify(result));
    failure(
      () => run("prepare", path.join(root, "changed.json")),
      /Missing or failed answer/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review rejects altered copied evidence, question metadata and impossible dates without editing a real human packet", () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "codeboom-review-integrity-"),
  );
  const resultPath = path.join(root, "result.json");
  const packetPath = path.join(root, "packet.json");
  const run = (mode: string) =>
    execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/review.ts", mode, resultPath, packetPath],
      { encoding: "utf8", stdio: "pipe" },
    );
  try {
    writeFileSync(resultPath, JSON.stringify(groundingReviewResult()));
    run("prepare");
    const fixture = JSON.parse(readFileSync(packetPath, "utf8"));
    // Test doubles exercise checker behavior, never supply actual human judgments.
    fixture.reviewer = {
      name: "Synthetic CLI test fixture",
      kind: "human",
      date: "2026-10-10",
    };
    for (const row of fixture.responses) {
      row.complete = true;
      row.claims =
        row.expectedStatus === "answered"
          ? [
              {
                text: "Synthetic judgment for checker behavior only",
                supported: true,
                qualifiersPreserved: true,
                inferenceLabeled: true,
                rationale: "Test double, not semantic qualification",
              },
            ]
          : [];
    }
    const save = (packet: any) =>
      writeFileSync(packetPath, JSON.stringify(packet));
    save(fixture);
    assert.equal(JSON.parse(run("check")).passed, true);
    const mutations: [string, (packet: any) => void, RegExp][] = [
      [
        "rubric instructions",
        (p) => {
          p.instructions = "Skip qualifiers and notices.";
        },
        /does not match/,
      ],
      [
        "corpus version",
        (p) => {
          p.corpusVersion++;
        },
        /does not match/,
      ],
      [
        "question",
        (p) => {
          p.responses[0].question = "Different question";
        },
        /question or evidence was changed/,
      ],
      [
        "expected status",
        (p) => {
          p.responses[0].expectedStatus = "insufficient_evidence";
        },
        /question or evidence was changed/,
      ],
      [
        "expected aid",
        (p) => {
          p.responses[0].expected = "Invented reviewer aid";
        },
        /question or evidence was changed/,
      ],
      [
        "quote",
        (p) => {
          p.responses[0].evidence[0].quote = "Invented quote";
        },
        /question or evidence was changed/,
      ],
      [
        "full passage",
        (p) => {
          p.responses[0].evidence[0].passage.text +=
            " Invented supporting fact.";
        },
        /question or evidence was changed/,
      ],
      [
        "passage provenance",
        (p) => {
          p.responses[0].evidence[0].passage.sourceId = "other";
        },
        /question or evidence was changed/,
      ],
      [
        "missing evidence",
        (p) => {
          p.responses[0].evidence = [];
        },
        /question or evidence was changed/,
      ],
      [
        "nonleap date",
        (p) => {
          p.reviewer.date = "2026-02-29";
        },
        /named, dated human review/,
      ],
      [
        "invalid day",
        (p) => {
          p.reviewer.date = "2026-04-31";
        },
        /named, dated human review/,
      ],
      [
        "invalid month",
        (p) => {
          p.reviewer.date = "2026-13-01";
        },
        /named, dated human review/,
      ],
    ];
    for (const [label, mutate, expected] of mutations) {
      const packet = structuredClone(fixture);
      mutate(packet);
      save(packet);
      assert.throws(
        () => run("check"),
        (error: any) => expected.test(String(error.stderr)),
        label,
      );
    }
    const reordered = structuredClone(fixture);
    reordered.reviewer.date = "2024-02-29";
    const evidence = reordered.responses[0].evidence[0];
    reordered.responses[0].evidence[0] = Object.fromEntries(
      Object.entries(evidence).reverse(),
    );
    save(reordered);
    assert.equal(JSON.parse(run("check")).passed, true);
    fixture.responses[0].claims[0].supported = false;
    save(fixture);
    const report = JSON.parse(run("check"));
    assert.equal(report.supportedClaims, report.totalClaims - 1);
    fixture.responses[1].claims[0].supported = false;
    save(fixture);
    assert.throws(
      () => run("check"),
      (error: any) => {
        const failed = JSON.parse(String(error.stdout));
        return failed.passed === false && failed.supportFraction < 0.95;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
