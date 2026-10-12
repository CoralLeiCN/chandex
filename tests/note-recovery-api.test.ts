import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import net from "node:net";
import { Store } from "../src/storage/store.ts";
import { editableNote } from "../src/domain/notes.ts";

test("draft HTTP lifecycle enforces session, origin, scope, size, stale Save and atomic publication cleanup", async () => {
  const root = mkdtempSync(os.tmpdir() + "/codeboom-draft-api-");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const store = new Store(root),
      n = store.createNotebook("Personal").id,
      other = store.createNotebook("Other").id;
    store.close();
    const reserve = net.createServer();
    reserve.listen(0, "127.0.0.1");
    await once(reserve, "listening");
    const port = (reserve.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
      env: {
        ...process.env,
        CODEBOOM_DATA_DIR: root,
        CODEBOOM_PORT: String(port),
        CODEBOOM_GOOGLE_DESKTOP_CLIENT: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exit = once(child, "exit");
    await Promise.race([
      once(child.stdout!, "data"),
      exit.then(() => {
        throw Error("Server exited");
      }),
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(Error("Startup timed out")),
          10000,
        );
        timer.unref();
      }),
    ]);
    const cookie = (await fetch(origin + "/api/session")).headers
      .get("set-cookie")!
      .split(";")[0];
    const headers = {
      Cookie: cookie,
      Origin: origin,
      "Content-Type": "application/json",
    };
    const request = (
      route: string,
      method = "GET",
      body?: unknown,
      custom = headers,
    ) =>
      fetch(origin + "/api/notebooks/" + route, {
        method,
        headers: custom,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const draft = {
      artifactId: null,
      baseRevisionId: null,
      version: 1,
      title: "",
      document: editableNote({ text: "Unfinished" }),
    };
    assert.equal(
      (await request(`${n}/drafts/d1`, "PUT", draft, {} as any)).status,
      401,
    );
    assert.equal(
      (
        await request(`${n}/drafts/d1`, "PUT", draft, {
          ...headers,
          Origin: "https://evil.invalid",
        })
      ).status,
      403,
    );
    assert.equal((await request(`${n}/drafts/d1`, "PUT", draft)).status, 200);
    assert.equal((await request(`${other}/drafts/d1`)).status, 400);
    assert.equal(
      (await request(`${other}/drafts/d1`, "DELETE", { version: 1 })).status,
      400,
    );
    assert.equal(
      (
        await request(`${n}/drafts/large`, "PUT", {
          ...draft,
          title: "x".repeat(2 * 1024 * 1024),
        })
      ).status,
      400,
    );
    const list = await (await request(`${n}/drafts`)).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].document, undefined);
    const initial = await (await request(n)).json();
    assert.equal(initial.artifacts.length, 0);
    assert.equal(initial.runs.length, 0);
    // Invalid publication preserves the draft; valid publication clears it in the same transaction.
    assert.equal(
      (
        await request(`${n}/artifacts`, "POST", {
          title: "",
          document: draft.document,
          draft: { id: "d1", version: 1 },
        })
      ).status,
      400,
    );
    assert.equal((await request(`${n}/drafts/d1`)).status, 200);
    const save = await request(`${n}/artifacts`, "POST", {
      title: "Saved",
      document: draft.document,
      draft: { id: "d1", version: 1 },
    });
    assert.equal(save.status, 201);
    const { id } = await save.json();
    assert.equal((await request(`${n}/drafts/d1`)).status, 400);
    assert.equal(
      (await request(`${n}/drafts/d1`, "PUT", { ...draft, version: 2 })).status,
      400,
    );
    const current = (await (await request(n)).json()).artifacts[0];
    const edit = {
      ...draft,
      artifactId: id,
      baseRevisionId: current.revision_id,
      title: "Recovered edit",
    };
    assert.equal((await request(`${n}/drafts/edit`, "PUT", edit)).status, 200);
    assert.equal(
      (await request(`${other}/drafts/foreign`, "PUT", edit)).status,
      400,
    );
    assert.equal(
      (
        await request(`${n}/artifacts/${id}`, "PATCH", {
          title: "Other window",
          document: editableNote({ text: "Newer" }),
          baseRevisionId: current.revision_id,
        })
      ).status,
      200,
    );
    const stale = await request(`${n}/artifacts/${id}`, "PATCH", {
      title: edit.title,
      document: edit.document,
      baseRevisionId: edit.baseRevisionId,
      draft: { id: "edit", version: 1 },
    });
    assert.equal(stale.status, 400);
    assert.match((await stale.json()).error, /Note changed/);
    assert.equal((await request(`${n}/drafts/edit`)).status, 200);
    const latest = (await (await request(n)).json()).artifacts[0];
    assert.equal(latest.title, "Other window");
    assert.equal(
      (
        await request(`${n}/drafts/current`, "PUT", {
          ...edit,
          baseRevisionId: latest.revision_id,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`${n}/artifacts/${id}`, "PATCH", {
          title: "Final",
          document: edit.document,
          baseRevisionId: latest.revision_id,
          draft: { id: "current", version: 1 },
        })
      ).status,
      200,
    );
    assert.equal((await request(`${n}/drafts/current`)).status, 400);
    assert.equal(
      (await request(`${n}/drafts/edit`, "DELETE", { version: 1 })).status,
      200,
    );
    assert.equal(
      (await (await request(`${n}/drafts?artifactId=${id}`)).json()).length,
      0,
    );
    child.kill("SIGTERM");
    await exit;
    child = undefined;
  } finally {
    if (child) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      await exit;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
