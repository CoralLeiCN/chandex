import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import net from "node:net";
import { Store } from "../src/storage/store.ts";
import { editableNote } from "../src/domain/notes.ts";

test("Trash HTTP lifecycle requires session/origin, scopes IDs, rejects stale deletion and preserves restored content", async () => {
  const root = mkdtempSync(os.tmpdir() + "/codeboom-trash-api-");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const store = new Store(root),
      n = store.createNotebook("Personal").id,
      other = store.createNotebook("Other").id;
    const document = editableNote({ text: "Personal research 🦉" });
    const a = store.createRichArtifact(n, "Research", document);
    const revision = store.artifactHistory(n, a).results[0].id;
    store.drafts.save(n, "draft", {
      artifactId: a,
      baseRevisionId: revision,
      title: "Unfinished research",
      document,
      version: 1,
    });
    const pinned = store.openNoteConversation(n, a, revision);
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
    const move = { baseRevisionId: revision, trashVersion: 0 };
    assert.equal(
      (await request(`${n}/artifacts/${a}/trash`, "POST", move, {} as any))
        .status,
      401,
    );
    assert.equal(
      (
        await request(`${n}/artifacts/${a}/trash`, "POST", move, {
          ...headers,
          Origin: "https://evil.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (await request(`${other}/artifacts/${a}/trash`, "POST", move)).status,
      400,
    );
    assert.equal(
      (
        await request(`${n}/artifacts/${a}/trash`, "POST", {
          ...move,
          baseRevisionId: "stale",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`${n}/artifacts/${a}`, "DELETE", {
          confirm: true,
          trashVersion: 0,
        })
      ).status,
      400,
    );
    assert.equal(
      (await request(`${n}/artifacts/${a}/trash`, "POST", move)).status,
      200,
    );
    const view = await (await request(n)).json();
    assert.equal(view.artifacts.length, 0);
    assert.equal(view.drafts.length, 0);
    assert.equal(view.trashCount, 1);
    assert.ok(view.conversations.some((c: any) => c.id === pinned.id));
    const trash = await (await request(`${n}/trash`)).json();
    assert.equal(trash.length, 1);
    assert.equal(trash[0].content, undefined);
    assert.equal((await (await request(`${other}/trash`)).json()).length, 0);
    assert.equal(
      (await request(`${n}/artifacts/${a}/revisions/${revision}`)).status,
      200,
    );
    for (const [route, method, body] of [
      [
        `${n}/artifacts/${a}`,
        "PATCH",
        { title: "Late", text: "changed", baseRevisionId: revision },
      ],
      [`${n}/artifacts/${a}/promote`, "POST", {}],
      [`${n}/artifacts/${a}/conversation`, "POST", { revisionId: revision }],
      [`${n}/artifacts/${a}/export`, "GET", undefined],
      [`${n}/drafts/draft`, "GET", undefined],
    ] as const)
      assert.equal((await request(route, method, body)).status, 400);
    assert.equal(
      (
        await request(`${other}/artifacts/${a}/trash/restore`, "POST", {
          trashVersion: 1,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`${n}/artifacts/${a}/trash/restore`, "POST", {
          trashVersion: 1,
        })
      ).status,
      200,
    );
    const restored = await (await request(n)).json();
    assert.equal(restored.artifacts[0].revision_id, revision);
    assert.deepEqual(restored.artifacts[0].content, document);
    assert.equal(restored.drafts.length, 1);
    assert.equal(
      (
        await request(`${n}/artifacts/${a}`, "DELETE", {
          confirm: true,
          trashVersion: 1,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`${n}/artifacts/${a}/trash`, "POST", {
          ...move,
          trashVersion: 2,
        })
      ).status,
      200,
    );
    assert.equal(
      (await request(`${n}/artifacts/${a}`, "DELETE", { trashVersion: 3 }))
        .status,
      400,
    );
    assert.equal(
      (
        await request(`${n}/artifacts/${a}`, "DELETE", {
          confirm: true,
          trashVersion: 1,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(`${other}/artifacts/${a}`, "DELETE", {
          confirm: true,
          trashVersion: 3,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request(
          `${n}/artifacts/${a}`,
          "DELETE",
          { confirm: true, trashVersion: 3 },
          {} as any,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await request(
          `${n}/artifacts/${a}`,
          "DELETE",
          { confirm: true, trashVersion: 3 },
          { ...headers, Origin: "https://evil.invalid" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(`${n}/artifacts/${a}`, "DELETE", {
          confirm: true,
          trashVersion: 3,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`${n}/artifacts/${a}`, "DELETE", {
          confirm: true,
          trashVersion: 3,
        })
      ).status,
      200,
    );
    const deleted = await (await request(n)).json();
    assert.equal(deleted.trashCount, 0);
    assert.equal(deleted.artifacts.length, 0);
    assert.equal(
      deleted.conversations.some((c: any) => c.id === pinned.id),
      false,
    );
    assert.equal(deleted.runs.length, 0);
    assert.equal(
      deleted.sources.every((s: any) => s.removed),
      true,
    );
    assert.equal(
      (await request(`${n}/artifacts/${a}/export?revision=${revision}`)).status,
      400,
    );
    assert.equal(
      (await request(`${n}/artifacts/${a}/revisions/${revision}`)).status,
      400,
    );
    assert.equal(
      (
        await request(`${n}/artifacts/${a}/trash/restore`, "POST", {
          trashVersion: 3,
        })
      ).status,
      400,
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
