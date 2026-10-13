import { randomUUID } from "node:crypto";
import {
  writeFileSync,
  renameSync,
  unlinkSync,
  readFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import type { Store } from "./store.ts";
import { digest, validateAnswer } from "../domain/evidence.ts";
import {
  overviewSpeechText,
  speechVoice,
  SPEECH_PROVIDER_ID,
  SPEECH_RENDERER_VERSION,
  SPEECH_SCRIPT_VERSION,
} from "../domain/audio-overview.ts";
import { validateSpeechAudio } from "../media/speech-audio.ts";
import type { RenderedSpeech } from "../media/macos-speech.ts";
const now = () => new Date().toISOString();
const blobPath = (store: Store, name: string) => {
  if (!/^[0-9a-f-]+\.bin$/.test(name))
    throw new Error("Invalid managed speech blob.");
  return path.join(store.blobs, name);
};
export class SpeechStore {
  // Cancelled jobs still occupy their native boundary until its awaited exit.
  readonly rendering = new Set<string>();
  constructor(readonly store: Store) {}
  importedAudio(n: string, hash: string) {
    const asset = this.store.one(
      "SELECT * FROM speech_assets WHERE notebook_id=? AND hash=? ORDER BY available DESC,created DESC LIMIT 1",
      n,
      hash,
    );
    if (!asset) return null;
    if (!asset.available)
      throw new Error(
        "This generated recording's script evidence is unavailable.",
      );
    this.script(n, asset.artifact_id, asset.revision_id);
    return { artifactId: asset.artifact_id, revisionId: asset.revision_id };
  }
  script(n: string, a: string, revision: string) {
    this.store.activeArtifact(n, a);
    const snapshot = this.store.artifactRevision(n, a, revision);
    const run = this.store.one(
      "SELECT * FROM runs WHERE id=? AND notebook_id=? AND status='completed' AND kind='audio-overview'",
      snapshot.run_id,
      n,
    );
    if (
      snapshot.authored ||
      !snapshot.available ||
      !run?.output ||
      run.output !== JSON.stringify(snapshot.content)
    )
      throw new Error(
        "Speech requires an available, supported generated audio overview revision.",
      );
    const manifest = JSON.parse(run.manifest) as string[];
    overviewSpeechText(snapshot.content);
    const ids = [
      ...new Set<string>(
        snapshot.content.blocks.flatMap((block: any) =>
          block.citations.map((c: any) => c.passageId),
        ),
      ),
    ];
    if (ids.length > 1600)
      throw new Error("Audio overview has too many references.");
    const passages = ids.length
      ? this.store
          .all(
            `SELECT p.*,s.derived_from,r.origin,r.requested_origin,r.retrieved_at,r.hash,r.extractor,r.warnings FROM passages p JOIN sources s ON s.id=p.source_id JOIN revisions r ON r.id=p.revision_id WHERE s.notebook_id=? AND p.id IN (${ids.map(() => "?").join(",")}) ORDER BY p.rowid`,
            n,
            ...ids,
          )
          .filter((p) => manifest.includes(p.revision_id))
          .map((p) => this.store.toPassage(p))
      : [];
    const answer = validateAnswer(snapshot.content, passages, "audio-overview");
    const text = overviewSpeechText(answer);
    return { text, hash: digest(text), revision: snapshot, manifest };
  }
  job(n: string, a: string, id: string) {
    const job = this.store.one(
      "SELECT * FROM speech_jobs WHERE id=? AND notebook_id=? AND artifact_id=?",
      id,
      n,
      a,
    );
    if (!job) throw new Error("Speech job not found.");
    return job;
  }
  begin(
    n: string,
    a: string,
    revision: string,
    provider: string,
    voiceId: string,
    key: string,
    retryOf: string | null = null,
  ) {
    return this.store.tx(() => {
      this.store.artifactRevision(n, a, revision);
      if (provider !== SPEECH_PROVIDER_ID)
        throw new Error("Choose a supported speech provider.");
      speechVoice(voiceId);
      const existing = this.store.one(
        "SELECT * FROM speech_jobs WHERE idempotency=?",
        key,
      );
      if (existing) {
        if (
          existing.notebook_id !== n ||
          existing.artifact_id !== a ||
          existing.revision_id !== revision ||
          existing.provider !== provider ||
          existing.voice_id !== voiceId ||
          existing.retry_of !== retryOf
        )
          throw new Error("Idempotency key belongs to another speech request.");
        return existing;
      }
      const script = this.script(n, a, revision);
      if (retryOf) {
        const previous = this.job(n, a, retryOf);
        if (
          !["failed", "cancelled", "interrupted"].includes(previous.status) ||
          previous.revision_id !== revision ||
          previous.provider !== provider ||
          previous.voice_id !== voiceId
        )
          throw new Error(
            "This speech attempt cannot be retried with these settings.",
          );
        if (
          this.store.one("SELECT id FROM speech_jobs WHERE retry_of=?", retryOf)
        )
          throw new Error("This speech attempt already has a retry.");
      }
      const active = this.store.all(
        "SELECT id,revision_id FROM speech_jobs WHERE status='processing'",
      );
      for (const id of this.rendering) {
        if (!active.some((job) => job.id === id)) {
          const job = this.store.one(
            "SELECT id,revision_id FROM speech_jobs WHERE id=?",
            id,
          );
          if (job) active.push(job);
        }
      }
      if (active.length >= 2)
        throw new Error(
          "Speech capacity is full. Wait for another render, then retry.",
        );
      if (active.some((job) => job.revision_id === revision))
        throw new Error("This script revision is already rendering speech.");
      const id = randomUUID(),
        timestamp = now();
      this.store.run(
        "INSERT INTO speech_jobs(id,notebook_id,artifact_id,revision_id,status,provider,voice_id,script_hash,script_version,idempotency,retry_of,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        id,
        n,
        a,
        revision,
        "processing",
        provider,
        voiceId,
        script.hash,
        SPEECH_SCRIPT_VERSION,
        key,
        retryOf,
        timestamp,
      );
      return this.job(n, a, id);
    });
  }
  retry(n: string, a: string, id: string, key: string) {
    const previous = this.job(n, a, id);
    return this.begin(
      n,
      a,
      previous.revision_id,
      previous.provider,
      previous.voice_id,
      key,
      id,
    );
  }
  cancel(n: string, a: string, id: string) {
    this.job(n, a, id);
    this.store.run(
      "UPDATE speech_jobs SET status='cancelled',error='Speech rendering was cancelled.',ended=? WHERE id=? AND status='processing'",
      now(),
      id,
    );
    return this.job(n, a, id);
  }
  publish(n: string, a: string, id: string, result: RenderedSpeech) {
    const job = this.job(n, a, id);
    if (job.status !== "processing") return null;
    const script = this.script(n, a, job.revision_id);
    if (
      script.hash !== job.script_hash ||
      result.provider !== job.provider ||
      result.voiceId !== job.voice_id ||
      result.rendererVersion !== SPEECH_RENDERER_VERSION ||
      typeof result.osVersion !== "string" ||
      result.osVersion.length > 100
    )
      throw new Error("Speech result does not match its immutable request.");
    const audio = validateSpeechAudio(result.bytes),
      hash = digest(result.bytes),
      blob = randomUUID() + ".bin",
      filename = blobPath(this.store, blob);
    try {
      writeFileSync(filename + ".tmp", result.bytes, { mode: 0o600 });
      renameSync(filename + ".tmp", filename);
      return this.store.tx(() => {
        if (this.job(n, a, id).status !== "processing")
          throw new Error("Speech request is no longer active.");
        if (this.script(n, a, job.revision_id).hash !== job.script_hash)
          throw new Error("Speech script is unavailable or changed.");
        const asset = randomUUID();
        this.store.run(
          "INSERT INTO speech_assets(id,notebook_id,artifact_id,revision_id,job_id,blob,hash,size,duration,provider,voice_id,renderer_version,os_version,script_hash,script_version,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          asset,
          n,
          a,
          job.revision_id,
          id,
          blob,
          hash,
          result.bytes.length,
          audio.duration,
          result.provider,
          result.voiceId,
          result.rendererVersion,
          result.osVersion,
          script.hash,
          SPEECH_SCRIPT_VERSION,
          now(),
        );
        this.store.run(
          "UPDATE speech_jobs SET status='completed',ended=? WHERE id=?",
          now(),
          id,
        );
        return asset;
      });
    } catch (error) {
      for (const file of [filename, filename + ".tmp"])
        if (existsSync(file)) unlinkSync(file);
      throw error;
    }
  }
  list(n: string, a: string) {
    this.store.artifactHistory(n, a, 0, 1);
    return {
      jobs: this.store.all(
        "SELECT * FROM speech_jobs WHERE notebook_id=? AND artifact_id=? ORDER BY created,rowid",
        n,
        a,
      ),
      assets: this.store.all(
        "SELECT id,revision_id,job_id,hash,size,duration,provider,voice_id,renderer_version,os_version,script_hash,script_version,available,created FROM speech_assets WHERE notebook_id=? AND artifact_id=? ORDER BY created,rowid",
        n,
        a,
      ),
    };
  }
  asset(n: string, a: string, id: string) {
    const asset = this.store.one(
      "SELECT * FROM speech_assets WHERE id=? AND notebook_id=? AND artifact_id=?",
      id,
      n,
      a,
    );
    if (!asset?.available || !asset.blob)
      throw new Error("This speech asset is unavailable.");
    if (this.script(n, a, asset.revision_id).hash !== asset.script_hash)
      throw new Error("The originating speech script is unavailable.");
    let bytes: Buffer;
    try {
      bytes = readFileSync(blobPath(this.store, asset.blob));
    } catch {
      throw new Error("The speech snapshot is missing.");
    }
    if (bytes.length !== asset.size || digest(bytes) !== asset.hash)
      throw new Error("The speech snapshot failed its integrity check.");
    return { asset, bytes };
  }
  invalidate(n: string, a: string) {
    this.store.run(
      "UPDATE speech_jobs SET status='unavailable',error='The script evidence is unavailable.',ended=COALESCE(ended,?) WHERE notebook_id=? AND artifact_id=?",
      now(),
      n,
      a,
    );
    this.store.run(
      "UPDATE speech_assets SET available=0 WHERE notebook_id=? AND artifact_id=?",
      n,
      a,
    );
  }
  cleanup(n: string, a?: string) {
    const assets = a
      ? this.store.all(
          "SELECT id,blob FROM speech_assets WHERE notebook_id=? AND artifact_id=? AND available=0 AND blob IS NOT NULL",
          n,
          a,
        )
      : this.store.all(
          "SELECT id,blob FROM speech_assets WHERE notebook_id=? AND available=0 AND blob IS NOT NULL",
          n,
        );
    for (const asset of assets) {
      const file = blobPath(this.store, asset.blob);
      if (existsSync(file)) unlinkSync(file);
      this.store.run("UPDATE speech_assets SET blob=NULL WHERE id=?", asset.id);
    }
  }
}
