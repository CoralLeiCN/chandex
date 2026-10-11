import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import http from "node:http";
import { Store } from "../src/storage/store.ts";
import { normalizeAudioTranscript } from "../src/ingestion/audio-transcript.ts";

test("HTTP audio imports fail honestly without installed models and retained originals stay scoped and downloadable", async () => {
  const root = mkdtempSync(join(tmpdir(), "codeboom-audio-api-")),
    seed = new Store(root);
  const n = seed.createNotebook("Audio API").id,
    other = seed.createNotebook("Other").id;
  const transcript = normalizeAudioTranscript(
    {
      text: "Approval is still pending.",
      chunks: [{ text: "Approval is still pending.", timestamp: [5.36, 7.08] }],
    },
    8.62325,
  );
  const originals: {
    source: string;
    revision: string;
    extension: string;
    bytes: Buffer;
  }[] = [];
  for (const extension of ["wav", "mp3", "aac", "flac", "ogg", "opus", "m4a"]) {
    const bytes = readFileSync(
      new URL(`./fixtures/audio/speech.${extension}`, import.meta.url),
    );
    const job = seed.beginImport(
      n,
      "Speech." + extension,
      "audio-api-seed-" + extension,
      { kind: "audio" },
    );
    seed.publishImport(
      n,
      job.id,
      "Speech." + extension,
      "audio",
      null,
      bytes,
      transcript,
    );
    const source = seed.importJob(n, job.id).source_id,
      revision = seed.one(
        "SELECT current_revision FROM sources WHERE id=?",
        source,
      ).current_revision;
    originals.push({ source, revision, extension, bytes });
  }
  seed.close();
  const reserve = net.createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = (reserve.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const base = "http://127.0.0.1:" + port;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/server/main.ts"],
    {
      env: {
        ...process.env,
        CODEBOOM_DATA_DIR: root,
        CODEBOOM_PORT: String(port),
        CODEBOOM_AUDIO_MODEL_DIR: join(root, "missing-models"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  let diagnostics = "";
  child.stdout.on("data", (value) => (diagnostics += value));
  child.stderr.on("data", (value) => (diagnostics += value));
  try {
    await Promise.race([
      once(child.stdout, "data"),
      exited.then(() => {
        throw Error("Audio API process exited");
      }),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(Error("API startup timeout")),
          10000,
        );
        timer.unref();
      }),
    ]);
    const response = await fetch(base + "/api/session"),
      cookie = response.headers.get("set-cookie")!.split(";")[0];
    const headers = {
      Cookie: cookie,
      Origin: base,
      "Content-Type": "application/json",
    };
    const call = async (route: string, method = "GET", body?: unknown) => {
      const response = await fetch(base + "/api" + route, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, data: await response.json() };
    };
    for (const original of originals) {
      const route = `/notebooks/${n}/sources/${original.source}/original?revision=${original.revision}`;
      const downloaded = await fetch(base + "/api" + route, { headers });
      assert.equal(downloaded.status, 200);
      assert.match(
        downloaded.headers.get("content-disposition")!,
        new RegExp("\\." + original.extension + '"$'),
      );
      assert.equal(
        downloaded.headers.get("content-type"),
        "application/octet-stream",
      );
      assert.deepEqual(
        Buffer.from(await downloaded.arrayBuffer()),
        original.bytes,
      );
      assert.equal((await fetch(base + "/api" + route)).status, 401);
      assert.equal((await call(route.replace(n, other))).status, 400);
      const detail = (await call(`/notebooks/${n}/sources/${original.source}`))
        .data;
      assert.equal(detail.kind, "audio");
      assert.match(detail.passages[0].locator, /estimated/);
      assert.ok(
        JSON.parse(detail.revisions[0].warnings).some((value: string) =>
          value.includes("can invent"),
        ),
      );
    }
    const finish = async (id: string) => {
      for (let i = 0; i < 400; i++) {
        const state = (await call(`/notebooks/${n}`)).data,
          job = state.jobs.find((job: any) => job.id === id);
        if (job?.status !== "processing") return job;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw Error("Audio import did not settle");
    };
    const invalid = await call(`/notebooks/${n}/import`, "POST", {
      title: "Bad.wav",
      kind: "audio",
      base64: Buffer.from("SOURCE_PRIVATE_CANARY").toString("base64"),
      idempotency: "audio-api-bad",
    });
    assert.equal(invalid.status, 202);
    const failed = await finish(invalid.data.id);
    assert.equal(failed.status, "failed");
    assert.doesNotMatch(failed.error, /SOURCE_PRIVATE_CANARY/);
    const payload = {
      title: "Speech.wav",
      kind: "audio",
      base64: originals[0].bytes.toString("base64"),
      idempotency: "audio-api-retry",
      retryOf: failed.id,
    };
    const retried = await call(`/notebooks/${n}/import`, "POST", payload);
    assert.equal(retried.status, 202);
    const missing = await finish(retried.data.id);
    assert.equal(missing.status, "failed");
    assert.equal(missing.retry_of, failed.id);
    assert.match(missing.error, /npm run audio:setup/);
    assert.equal(
      (await call(`/notebooks/${n}/import`, "POST", payload)).data.id,
      missing.id,
    );
    assert.equal((await call(`/notebooks/${n}`)).data.sources.length, 7);
    assert.doesNotMatch(
      diagnostics,
      /SOURCE_PRIVATE_CANARY|Approval is still pending/,
    );
    const dictationRoute = `/notebooks/${n}/dictation`;
    const cancelBody = { idempotency: "cancel-before-http-upload" };
    assert.equal(
      (
        await fetch(base + "/api" + dictationRoute, {
          method: "DELETE",
          headers: { "Content-Type": "application/json", Origin: base },
          body: JSON.stringify(cancelBody),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(base + "/api" + dictationRoute, {
          method: "DELETE",
          headers: { ...headers, Origin: "https://untrusted.example" },
          body: JSON.stringify(cancelBody),
        })
      ).status,
      403,
    );
    assert.equal(
      (await call(dictationRoute, "DELETE", cancelBody)).status,
      200,
    );
    assert.equal(
      (await call(dictationRoute, "DELETE", cancelBody)).status,
      200,
    );
    assert.equal(
      (await call(dictationRoute.replace(n, other), "DELETE", cancelBody))
        .status,
      400,
    );
    assert.equal(
      (await call(dictationRoute, "DELETE", { idempotency: "a".repeat(201) }))
        .status,
      400,
    );
    assert.equal(
      (
        await call(dictationRoute, "DELETE", {
          idempotency: "small",
          padding: "a".repeat(1024),
        })
      ).status,
      400,
    );
    const delayed = await call(dictationRoute, "POST", {
      ...cancelBody,
      base64: originals[0].bytes.toString("base64"),
    });
    assert.equal(delayed.status, 400);
    assert.match(delayed.data.error, /cancelled/);
    // Hold a real HTTP upload body open while a separate, small cancellation
    // request completes. No job ID or recognition response exists yet.
    const pendingKey = "partial-http-upload",
      pendingBody = JSON.stringify({
        idempotency: pendingKey,
        base64: originals[0].bytes.toString("base64"),
      });
    let pending!: http.ClientRequest;
    const partialResponse = new Promise<{ status: number; data: any }>(
      (resolve, reject) => {
        pending = http.request(
          base + "/api" + dictationRoute,
          {
            method: "POST",
            headers: {
              ...headers,
              "Content-Length": Buffer.byteLength(pendingBody),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("error", reject);
            response.on("end", () => {
              try {
                resolve({
                  status: response.statusCode!,
                  data: JSON.parse(Buffer.concat(chunks).toString()),
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        pending.on("error", reject);
        pending.flushHeaders();
        pending.write(pendingBody.slice(0, 64));
      },
    );
    try {
      assert.equal(
        (await call(dictationRoute, "DELETE", { idempotency: pendingKey }))
          .status,
        200,
      );
      pending.end(pendingBody.slice(64));
      const response = await partialResponse;
      assert.equal(response.status, 400);
      assert.match(response.data.error, /cancelled/);
    } finally {
      pending.destroy();
    }
    assert.equal(
      (
        await fetch(base + "/api" + dictationRoute, {
          method: "POST",
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await call(dictationRoute, "POST", {
          base64: Buffer.from("PRIVATE_CANARY").toString("base64"),
          idempotency: "invalid-dictation",
        })
      ).status,
      400,
    );
    const voice = await call(dictationRoute, "POST", {
      base64: originals[0].bytes.toString("base64"),
      idempotency: "voice-model-missing",
    });
    assert.equal(voice.status, 202);
    assert.equal(
      (await call(dictationRoute.replace(n, other) + "/" + voice.data.id))
        .status,
      400,
    );
    let recognized: any;
    for (let i = 0; i < 400; i++) {
      recognized = (await call(dictationRoute + "/" + voice.data.id)).data;
      if (recognized.status !== "processing") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(recognized.status, "failed");
    assert.match(recognized.error, /audio:setup/);
    assert.equal(
      (
        await call(dictationRoute, "POST", {
          base64: originals[0].bytes.toString("base64"),
          idempotency: "voice-model-missing",
        })
      ).data.id,
      voice.data.id,
    );
    assert.equal((await call(`/notebooks/${n}`)).data.sources.length, 7);
    assert.equal(
      (await call(dictationRoute + "/" + voice.data.id, "DELETE")).status,
      200,
    );
    assert.equal(
      (await call(dictationRoute + "/" + voice.data.id)).status,
      400,
    );
    assert.doesNotMatch(diagnostics, /PRIVATE_CANARY/);
    const removed = originals[0];
    assert.equal(
      (
        await call(
          `/notebooks/${n}/sources/${removed.source}?purge=true`,
          "DELETE",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          `/notebooks/${n}/sources/${removed.source}/original?revision=${removed.revision}`,
        )
      ).status,
      400,
    );
  } finally {
    child.kill("SIGTERM");
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
});
