import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { digest } from "../domain/evidence.ts";
function stopped(root: string) {
  const lock = path.join(root, "server.lock");
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error("Invalid data-directory lock.");
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {}
    if (alive) throw new Error("Stop Codeboom before backup or restore.");
  }
}
function destination(source: string, target: string) {
  if (existsSync(target))
    throw new Error("Choose a new destination directory.");
  if (target === source || target.startsWith(source + path.sep))
    throw new Error("Destination must be outside the source directory.");
}
export function backup(source: string, target: string) {
  source = path.resolve(source);
  target = path.resolve(target);
  stopped(source);
  destination(source, target);
  const db = new DatabaseSync(path.join(source, "codeboom.sqlite"));
  const stage = target + ".tmp-" + randomUUID();
  mkdirSync(path.join(stage, "blobs"), { recursive: true, mode: 0o700 });
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const check = db.prepare("PRAGMA integrity_check").get() as any;
    if (check.integrity_check !== "ok")
      throw new Error("Database integrity check failed.");
    const version = (
      db.prepare("SELECT max(version) AS version FROM migrations").get() as any
    ).version;
    if (![3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].includes(version))
      throw new Error("Unsupported database schema.");
    const refs = db
      .prepare(
        "SELECT blob,hash FROM revisions WHERE blob IS NOT NULL" +
          (version >= 13
            ? " UNION ALL SELECT blob,hash FROM speech_assets WHERE blob IS NOT NULL"
            : ""),
      )
      .all() as any[];
    const hashes: Record<string, string> = {};
    for (const r of refs) {
      if (!/^[0-9a-f-]+\.bin$/.test(r.blob))
        throw new Error("Invalid blob name.");
      const bytes = readFileSync(path.join(source, "blobs", r.blob));
      if (digest(bytes) !== r.hash) throw new Error("Source hash mismatch.");
      copyFileSync(
        path.join(source, "blobs", r.blob),
        path.join(stage, "blobs", r.blob),
      );
      hashes["blobs/" + r.blob] = r.hash;
    }
    copyFileSync(
      path.join(source, "codeboom.sqlite"),
      path.join(stage, "codeboom.sqlite"),
    );
    hashes["codeboom.sqlite"] = digest(
      readFileSync(path.join(stage, "codeboom.sqlite")),
    );
    writeFileSync(
      path.join(stage, "manifest.json"),
      JSON.stringify(
        {
          format: 1,
          schema: version,
          created: new Date().toISOString(),
          hashes,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    renameSync(stage, target);
  } catch (e) {
    rmSync(stage, { recursive: true, force: true });
    throw e;
  } finally {
    db.close();
  }
}
export function restore(source: string, target: string) {
  source = path.resolve(source);
  target = path.resolve(target);
  destination(source, target);
  const manifest = JSON.parse(
    readFileSync(path.join(source, "manifest.json"), "utf8"),
  );
  if (
    manifest.format !== 1 ||
    ![3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16].includes(
      manifest.schema,
    ) ||
    !manifest.hashes?.["codeboom.sqlite"]
  )
    throw new Error("Unsupported backup manifest.");
  for (const [file, hash] of Object.entries(manifest.hashes)) {
    if (file !== "codeboom.sqlite" && !/^blobs\/[0-9a-f-]+\.bin$/.test(file))
      throw new Error("Invalid backup entry.");
    if (digest(readFileSync(path.join(source, file))) !== hash)
      throw new Error("Backup hash mismatch: " + file);
  }
  const stage = target + ".tmp-" + randomUUID();
  mkdirSync(path.join(stage, "blobs"), { recursive: true, mode: 0o700 });
  try {
    for (const file of Object.keys(manifest.hashes))
      copyFileSync(path.join(source, file), path.join(stage, file));
    const db = new DatabaseSync(path.join(stage, "codeboom.sqlite"));
    try {
      if (
        (db.prepare("PRAGMA integrity_check").get() as any).integrity_check !==
        "ok"
      )
        throw new Error("Restored database is invalid.");
      if (
        (
          db
            .prepare("SELECT max(version) AS version FROM migrations")
            .get() as any
        ).version !== manifest.schema
      )
        throw new Error("Database schema mismatch.");
      for (const r of db
        .prepare(
          "SELECT blob,hash FROM revisions WHERE blob IS NOT NULL" +
            (manifest.schema >= 13
              ? " UNION ALL SELECT blob,hash FROM speech_assets WHERE blob IS NOT NULL"
              : ""),
        )
        .all() as any[]) {
        if (manifest.hashes["blobs/" + r.blob] !== r.hash)
          throw new Error("Backup is missing source evidence.");
      }
    } finally {
      db.close();
    }
    renameSync(stage, target);
  } catch (e) {
    rmSync(stage, { recursive: true, force: true });
    throw e;
  }
}
