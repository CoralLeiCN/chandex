import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import net from "node:net";
import { Store } from "../src/storage/store.ts";
import { extract } from "../src/ingestion/extract.ts";
test("HTTP sessions, scoped imports, duplicate retry, stored notes and exports work end to end", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-api-"));
  const seed = new Store(root),
    seedNotebook = seed.createNotebook("Replay fixture").id;
  const seedJob = seed.beginImport(seedNotebook, "Evidence", "seed-import");
  const bytes = Buffer.from("Replay evidence");
  seed.publishImport(
    seedNotebook,
    seedJob.id,
    "Evidence",
    "text",
    null,
    bytes,
    await extract(bytes, "text"),
  );
  const seedRun = seed.createRun(
    seedNotebook,
    seed.view(seedNotebook).conversations[0].id,
    "A question",
    "answer",
    "",
    "seed-run",
  );
  seed.event(seedRun.id, { type: "progress", text: "before-cursor" });
  const cursor = seed.one("SELECT max(seq) AS seq FROM events").seq;
  seed.event(seedRun.id, { type: "progress", text: "after-cursor" });
  seed.close();
  const reserve = net.createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = (reserve.address() as net.AddressInfo).port;
  await new Promise<void>((r) => reserve.close(() => r()));
  const base = "http://127.0.0.1:" + port;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/server/main.ts"],
    {
      env: {
        ...process.env,
        CODEBOOM_DATA_DIR: root,
        CODEBOOM_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = once(child, "exit");
  try {
    await Promise.race([
      once(child.stdout, "data"),
      exited.then(() => {
        throw new Error("API process exited");
      }),
      new Promise((_, reject) => {
        const t = setTimeout(
          () => reject(new Error("API startup timeout")),
          10000,
        );
        t.unref();
      }),
    ]);
    assert.equal((await fetch(base + "/api/notebooks")).status, 401);
    assert.equal(
      (
        await fetch(base + "/api/session", {
          headers: { Origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
    const session = await fetch(base + "/api/session"),
      cookie = session.headers.get("set-cookie")!.split(";")[0];
    const stream = await fetch(
      base +
        "/api/notebooks/" +
        seedNotebook +
        "/runs/" +
        seedRun.id +
        "/events",
      { headers: { Cookie: cookie, "Last-Event-ID": String(cursor) } },
    );
    const replay = await stream.text();
    assert.ok(!replay.includes("before-cursor"));
    assert.ok(replay.includes("after-cursor"));
    assert.ok(replay.includes("interrupted"));
    const call = async (route: string, method = "GET", body?: unknown) => {
      const r = await fetch(base + "/api" + route, {
        method,
        headers: {
          Cookie: cookie,
          Origin: base,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: r.status, data: await r.json() };
    };
    assert.equal(
      (
        await fetch(base + "/api/notebooks", {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: '{"title":"Forbidden"}',
        })
      ).status,
      403,
    );
    const n = (await call("/notebooks", "POST", { title: "API fixture" })).data
      .id;
    const payload = {
      title: "Evidence",
      kind: "paste",
      text: "The release uses SQLite.",
      idempotency: "same-import",
    };
    const job = await call("/notebooks/" + n + "/import", "POST", payload);
    assert.equal(
      (await call("/notebooks/" + n + "/import", "POST", payload)).data.id,
      job.data.id,
    );
    let view: any;
    for (let i = 0; i < 80; i++) {
      view = (await call("/notebooks/" + n)).data;
      if (view.jobs[0].status !== "processing") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(view.jobs[0].status, "completed");
    assert.equal(view.sources.length, 1);
    const other = (await call("/notebooks", "POST", { title: "Other" })).data
      .id;
    assert.equal(
      (await call("/notebooks/" + other + "/sources/" + view.sources[0].id))
        .status,
      400,
    );
    const note = (
      await call("/notebooks/" + n + "/artifacts", "POST", {
        title: "My note",
        text: "Local notes persist.",
      })
    ).data.id;
    const exported = await fetch(
      base + "/api/notebooks/" + n + "/artifacts/" + note + "/export",
      { headers: { Cookie: cookie } },
    );
    assert.match(await exported.text(), /# My note\n\nLocal notes persist/);
    const invalid = await call("/notebooks/" + n + "/import", "POST", {
      ...payload,
      kind: "exe",
      idempotency: "invalid",
    });
    assert.equal(invalid.status, 400);
    assert.equal((await call("/notebooks/" + n)).data.jobs.length, 1);
  } finally {
    child.kill("SIGTERM");
    await exited;
    rmSync(root, { recursive: true, force: true });
  }
});
