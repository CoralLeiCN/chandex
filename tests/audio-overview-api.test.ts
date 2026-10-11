import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { Store } from "../src/storage/store.ts";
import { SPEECH_PROVIDER_ID } from "../src/domain/audio-overview.ts";
import { seedOverview, speechResult } from "./fixtures/audio-overview.ts";

test("HTTP speech assets enforce session/owner scope, immutable requests, revision history, ranges and purge", async () => {
  const root = mkdtempSync(join(tmpdir(), "codeboom-overview-api-")),
    seed = new Store(root);
  const one = await seedOverview(seed),
    other = seed.createNotebook("Foreign").id;
  const request = {
    revisionId: one.revision,
    provider: SPEECH_PROVIDER_ID,
    voiceId: "samantha",
    idempotency: "completed",
  };
  const job = seed.speech.begin(
      one.n,
      one.a,
      request.revisionId,
      request.provider,
      request.voiceId,
      request.idempotency,
    ),
    result = speechResult(),
    asset = seed.speech.publish(one.n, one.a, job.id, result)!;
  seed.editArtifact(one.n, one.a, "My annotation", "Authored text");
  const edited = seed
    .view(one.n)
    .artifacts.find((a: any) => a.id === one.a).revision_id;
  const pending = seed.speech.begin(
    one.n,
    one.a,
    one.revision,
    SPEECH_PROVIDER_ID,
    "daniel",
    "interrupted",
  );
  const gap = seed.createRun(
    one.n,
    one.c,
    "Unknown approval date",
    "audio-overview",
    "fixture",
    "gap",
  );
  seed.completeRun(gap.id, {
    status: "insufficient_evidence",
    kind: "audio-overview",
    title: "No date",
    blocks: [
      { kind: "notice", text: "No approval date is supported.", citations: [] },
    ],
    sections: one.answer.sections!.map((section, i) => ({
      ...section,
      blockIndexes: i === 3 ? [0] : [],
    })),
    coverageWarnings: [],
  });
  const gapArtifact = seed
    .view(one.n)
    .artifacts.find((a: any) => a.run_id === gap.id);
  seed.close();
  const reserve = net.createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = (reserve.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const base = "http://127.0.0.1:" + port,
    child = spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
      env: {
        ...process.env,
        CODEBOOM_DATA_DIR: root,
        CODEBOOM_PORT: String(port),
        CODEBOOM_ENABLE_AUDIO_OVERVIEWS: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  const exited = once(child, "exit");
  let diagnostics = "";
  child.stdout.on("data", (value) => {
    diagnostics += value;
  });
  child.stderr.on("data", (value) => {
    diagnostics += value;
  });
  try {
    await Promise.race([
      once(child.stdout, "data"),
      exited.then(() => {
        throw Error("Speech API exited during startup");
      }),
      new Promise((_, reject) => {
        const timeout = setTimeout(
          () => reject(Error("Speech API startup timeout")),
          10000,
        );
        timeout.unref();
      }),
    ]);
    const session = await fetch(base + "/api/session"),
      cookie = session.headers.get("set-cookie")!.split(";")[0],
      headers = {
        Cookie: cookie,
        Origin: base,
        "Content-Type": "application/json",
      };
    const route = `/api/notebooks/${one.n}/artifacts/${one.a}/audio`,
      media = route + "/assets/" + asset;
    const post = (url: string, value: unknown) =>
      fetch(base + url, {
        method: "POST",
        headers,
        body: JSON.stringify(value),
      });
    assert.equal((await fetch(base + media)).status, 401);
    assert.equal(
      (
        await fetch(base + media, {
          headers: { ...headers, Origin: "https://foreign.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(base + media.replace(one.n, other), { headers })).status,
      400,
    );
    const full = await fetch(base + media + "?download=true", { headers });
    assert.equal(full.status, 200);
    assert.equal(full.headers.get("content-type"), "audio/wav");
    assert.equal(full.headers.get("cache-control"), "no-store");
    assert.equal(full.headers.get("x-content-type-options"), "nosniff");
    assert.match(
      full.headers.get("content-disposition")!,
      /^attachment; filename="codeboom-audio-overview\.wav"$/,
    );
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), result.bytes);
    for (const [range, start, end] of [
      ["bytes=0-43", 0, 43],
      ["bytes=44-", 44, result.bytes.length - 1],
      ["bytes=-16", result.bytes.length - 16, result.bytes.length - 1],
      ["bytes=0-9999999", 0, result.bytes.length - 1],
    ] as const) {
      const response = await fetch(base + media, {
        headers: { ...headers, Range: range },
      });
      assert.equal(response.status, 206);
      assert.equal(
        response.headers.get("content-range"),
        `bytes ${start}-${end}/${result.bytes.length}`,
      );
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        result.bytes.subarray(start, end + 1),
      );
    }
    for (const range of [
      "bytes=",
      "bytes=-0",
      "bytes=2-1",
      "bytes=9999999-",
      "bytes=0-1,4-5",
      "items=0-1",
      "bytes=9007199254740993-",
    ]) {
      const response = await fetch(base + media, {
        headers: { ...headers, Range: range },
      });
      assert.equal(response.status, 416);
      assert.equal(
        response.headers.get("content-range"),
        "bytes */" + result.bytes.length,
      );
    }
    const replay = await post(route, request);
    assert.equal(replay.status, 202);
    assert.equal((await replay.json()).id, job.id);
    for (const patch of [
      { voiceId: "daniel" },
      { provider: "remote" },
      { voiceId: "[[command]]" },
      { revisionId: edited },
      { revisionId: "foreign-revision" },
    ]) {
      assert.equal((await post(route, { ...request, ...patch })).status, 400);
    }
    assert.equal(
      (
        await post(route, {
          ...request,
          revisionId: edited,
          idempotency: "authored",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post(route.replace(one.a, gapArtifact.id), {
          ...request,
          revisionId: gapArtifact.revision_id,
          idempotency: "gap",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post(route + "/jobs/" + job.id + "/retry", {
          idempotency: "completed-retry",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post(
          route.replace(one.n, other) + "/jobs/" + pending.id + "/cancel",
          {},
        )
      ).status,
      400,
    );
    const listing = await (
      await fetch(base + route + "?catalog=false", { headers })
    ).json();
    assert.equal(
      listing.jobs.find((j: any) => j.id === pending.id).status,
      "interrupted",
    );
    assert.equal(listing.assets[0].revision_id, one.revision);
    assert.equal(listing.provider, undefined);
    assert.equal(
      (await post(route + "/jobs/" + pending.id + "/cancel", {})).status,
      200,
    );
    assert.equal(
      (
        await fetch(
          base +
            `/api/notebooks/${one.n}/sources/${one.passage.sourceId}?purge=true`,
          { method: "DELETE", headers },
        )
      ).status,
      200,
    );
    assert.equal((await fetch(base + media, { headers })).status, 400);
    const purged = await (
      await fetch(base + route + "?catalog=false", { headers })
    ).json();
    assert.equal(purged.assets[0].available, 0);
    assert.equal(purged.jobs[0].status, "unavailable");
    assert.doesNotMatch(diagnostics, /Authored text|three hundred units/);
  } finally {
    child.kill("SIGTERM");
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
});
