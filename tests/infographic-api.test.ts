import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/storage/store.ts";
import { extract } from "../src/ingestion/extract.ts";
import { imageDimensions } from "../src/ingestion/ocr.ts";
import { JSDOM } from "jsdom";
import {
  infographicAnswer,
  infographicSourceText,
} from "./fixtures/infographic.ts";

test("authenticated PNG and SVG exports pin revisions across edits and refuse foreign or purged evidence", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-infographic-api-"));
  const store = new Store(root);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const n = store.createNotebook("Image export").id,
      c = store.view(n).conversations[0].id;
    const job = store.beginImport(n, "Proposal", "seed"),
      bytes = Buffer.from(infographicSourceText);
    store.publishImport(
      n,
      job.id,
      "Proposal",
      "text",
      null,
      bytes,
      await extract(bytes, "text"),
    );
    const p = store.selectedPassages(n, c)[0],
      run = store.createRun(
        n,
        c,
        "Infographic",
        "infographic",
        "fixture",
        "seed-run",
      );
    store.completeRun(run.id, infographicAnswer(p));
    const saved = store.view(n).artifacts[0],
      original = saved.revision_id;
    const foreignNotebook = store.createNotebook("Foreign").id;
    const foreignId = store.saveArtifact(
      foreignNotebook,
      "Foreign",
      "note",
      JSON.stringify({ text: "Foreign note" }),
      true,
    );
    const foreign = store
      .view(foreignNotebook)
      .artifacts.find((artifact: any) => artifact.id === foreignId);
    store.close();
    const reserve = net.createServer();
    reserve.listen(0, "127.0.0.1");
    await once(reserve, "listening");
    const port = (reserve.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
      env: {
        ...process.env,
        CODEBOOM_DATA_DIR: root,
        CODEBOOM_PORT: String(port),
        CODEBOOM_GOOGLE_DESKTOP_CLIENT: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(child, "exit");
    let diagnostics = "";
    child.stderr!.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-2000);
    });
    const startup = once(child.stdout!, "data");
    await Promise.race([
      startup,
      exited.then(() => {
        throw Error("Image API exited: " + diagnostics);
      }),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(Error("Image API startup timed out")),
          10000,
        );
        timer.unref();
      }),
    ]);
    const cookie = (await fetch(base + "/api/session")).headers
      .get("set-cookie")!
      .split(";")[0];
    const route = `/api/notebooks/${n}/artifacts/${saved.id}`;
    const get = (suffix: string) =>
      fetch(base + route + suffix, { headers: { Cookie: cookie } });
    const mutate = (url: string, method: string, body?: unknown) =>
      fetch(base + url, {
        method,
        headers: {
          Cookie: cookie,
          Origin: base,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    assert.equal(
      (await fetch(base + route + "/export?format=svg")).status,
      401,
    );
    const download = await get(`/export?format=svg&revision=${original}`);
    assert.equal(download.status, 200);
    assert.equal(
      download.headers.get("content-type"),
      "image/svg+xml; charset=utf-8",
    );
    assert.equal(download.headers.get("cache-control"), "no-store");
    assert.match(
      download.headers.get("content-disposition")!,
      /codeboom-infographic\.svg/,
    );
    const svg = await download.text();
    const dom = new JSDOM(svg, { contentType: "image/svg+xml" });
    assert.equal(
      dom.window.document.querySelector("script, image, foreignObject"),
      null,
    );
    const initial = JSON.parse(
      dom.window.document.querySelector("metadata")!.textContent!,
    );
    assert.equal(initial.content.kind, "infographic");
    assert.equal(initial.revision.revisionId, original);
    dom.window.close();
    const png = await get(`/export?format=png&revision=${original}`);
    assert.equal(png.status, 200);
    assert.equal(png.headers.get("content-type"), "image/png");
    assert.equal(png.headers.get("cache-control"), "no-store");
    assert.equal(
      imageDimensions(Buffer.from(await png.arrayBuffer())).width,
      1200,
    );
    for (const format of ["markdown", "html"]) {
      const response = await get(
        `/export?format=${format}&revision=${original}`,
      );
      assert.equal(response.status, 200);
      assert.match(await response.text(), /conditional on reviewer approval/);
    }
    const edit = await mutate(route, "PATCH", {
      title: "Edited",
      text: "User annotation",
      baseRevisionId: original,
    });
    assert.equal(edit.status, 200);
    await edit.json();
    assert.equal(
      (await get("/export?format=svg")).status,
      400,
      "authored current version is not relabeled as an infographic",
    );
    const historic = await get(`/export?format=svg&revision=${original}`);
    assert.equal(historic.status, 200);
    const historicDom = new JSDOM(await historic.text(), {
      contentType: "image/svg+xml",
    });
    const historicMetadata = JSON.parse(
      historicDom.window.document.querySelector("metadata")!.textContent!,
    );
    assert.equal(historicMetadata.revision.historical, true);
    assert.equal(historicMetadata.revision.revisionId, original);
    assert.ok(
      !historicDom.window.document.documentElement.textContent!.includes(
        "User annotation",
      ),
    );
    historicDom.window.close();
    assert.equal(
      (await get(`/export?format=svg&revision=${foreign.revision_id}`)).status,
      400,
    );
    assert.equal(
      (
        await fetch(
          base +
            `/api/notebooks/${foreignNotebook}/artifacts/${saved.id}/export?format=svg&revision=${original}`,
          { headers: { Cookie: cookie } },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await mutate(
          `/api/notebooks/${n}/sources/${p.sourceId}?purge=true`,
          "DELETE",
        )
      ).status,
      200,
    );
    const purged = await get(`/export?format=svg&revision=${original}`);
    assert.equal(purged.status, 400);
    assert.match(purged.headers.get("content-type")!, /application\/json/);
    child.kill("SIGTERM");
    await exited;
    child = undefined;
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    try {
      store.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
