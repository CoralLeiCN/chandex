import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/storage/store.ts";
import { backup, restore } from "../src/storage/backup.ts";
import { extract } from "../src/ingestion/extract.ts";
test("backup restores notebook evidence and rejects modified bytes and active writers", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-backup-"));
  const data = path.join(root, "data");
  let store = new Store(data);
  try {
    const n = store.createNotebook("Research").id,
      j = store.beginImport(n, "Fixture", "i"),
      bytes = Buffer.from("Backup evidence 🦉");
    store.publishImport(
      n,
      j.id,
      "Fixture",
      "text",
      null,
      bytes,
      await extract(bytes, "text"),
    );
    const p = store.selectedPassages(n, store.view(n).conversations[0].id)[0];
    store.close();
    backup(data, path.join(root, "backup"));
    restore(path.join(root, "backup"), path.join(root, "restored"));
    store = new Store(path.join(root, "restored"));
    assert.equal(store.passage(n, p.id).text, "Backup evidence 🦉");
    store.close();
    const manifest = JSON.parse(
      readFileSync(path.join(root, "backup", "manifest.json"), "utf8"),
    );
    const blob = Object.keys(manifest.hashes).find((x) =>
      x.startsWith("blobs/"),
    )!;
    writeFileSync(path.join(root, "backup", blob), "tampered");
    assert.throws(
      () => restore(path.join(root, "backup"), path.join(root, "invalid")),
      /hash/,
    );
    writeFileSync(path.join(data, "server.lock"), String(process.pid));
    assert.throws(
      () => backup(data, path.join(root, "blocked")),
      /Stop Codeboom/,
    );
  } finally {
    if (store.db.isOpen) store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
