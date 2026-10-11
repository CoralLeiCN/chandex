import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadStudyCorpus } from "./study-corpus.ts";
import { prepareStudyReview, checkStudyReview } from "./study-review.ts";

const [mode, resultPath, reviewPath] = process.argv.slice(2);
if (!["prepare", "check"].includes(mode) || !resultPath || !reviewPath)
  throw new Error(
    "Usage: npm run review:study -- prepare|check results.json review.json",
  );
const corpus = loadStudyCorpus(),
  raw = readFileSync(resultPath);
if (mode === "prepare") {
  const packet = prepareStudyReview(raw, corpus);
  mkdirSync(path.dirname(path.resolve(reviewPath)), { recursive: true });
  writeFileSync(reviewPath, JSON.stringify(packet, null, 2), { flag: "wx" });
  console.log("Prepared unreviewed study packet: " + reviewPath);
} else {
  const report = checkStudyReview(
    raw,
    corpus,
    JSON.parse(readFileSync(reviewPath, "utf8")),
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
