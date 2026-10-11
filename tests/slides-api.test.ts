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
import { officePackage } from "../src/ingestion/office-package.ts";
import { slideAnswer, slideSourceText } from "./fixtures/slides.ts";

test("authenticated PowerPoint exports pin revisions across edits and refuse foreign or purged evidence", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codeboom-slide-api-"));
  const store = new Store(root);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const n = store.createNotebook("Slide export").id,
      c = store.view(n).conversations[0].id;
    const job = store.beginImport(n, "Proposal", "seed"),
      bytes = Buffer.from(slideSourceText);
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
      run = store.createRun(n, c, "Slides", "slides", "fixture", "seed-run");
    store.completeRun(run.id, slideAnswer(p));
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
        throw Error("Slide API exited: " + diagnostics);
      }),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(Error("Slide API startup timed out")),
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
      (await fetch(base + route + "/export?format=pptx")).status,
      401,
    );
    const download = await get(`/export?format=pptx&revision=${original}`);
    assert.equal(download.status, 200);
    assert.equal(
      download.headers.get("content-type"),
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    assert.equal(download.headers.get("cache-control"), "no-store");
    assert.match(
      download.headers.get("content-disposition")!,
      /codeboom-slides\.pptx/,
    );
    const initialPackage = await officePackage(
      Buffer.from(await download.arrayBuffer()),
    );
    assert.equal(
      [...initialPackage.names].filter((name) =>
        /^ppt\/slides\/slide\d+\.xml$/.test(name),
      ).length,
      3,
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
      (await get("/export?format=pptx")).status,
      400,
      "authored current version is not relabeled as slides",
    );
    const historic = await get(`/export?format=pptx&revision=${original}`);
    assert.equal(historic.status, 200);
    const pkg = await officePackage(Buffer.from(await historic.arrayBuffer()));
    const notes = [...pkg.parts]
      .filter(([name]) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))
      .map(([, bytes]) => bytes.toString())
      .join("\n");
    assert.match(notes, /Historical saved revision/);
    assert.ok(notes.includes(original));
    assert.ok(!notes.includes("User annotation"));
    assert.equal(
      (await get(`/export?format=pptx&revision=${foreign.revision_id}`)).status,
      400,
    );
    assert.equal(
      (
        await fetch(
          base +
            `/api/notebooks/${foreignNotebook}/artifacts/${saved.id}/export?format=pptx&revision=${original}`,
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
    const purged = await get(`/export?format=pptx&revision=${original}`);
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
