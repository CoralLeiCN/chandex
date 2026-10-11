import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import net from "node:net";
import { Store } from "../src/storage/store.ts";
test("web discovery API enforces session/origin/notebook/input checks and cancel-before-start without importing", async () => {
  const root = mkdtempSync(os.tmpdir() + "/codeboom-web-api-");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const store = new Store(root),
      n = store.createNotebook("Web review").id;
    store.close();
    const reserve = net.createServer();
    reserve.listen(0, "127.0.0.1");
    await once(reserve, "listening");
    const port = (reserve.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const origin = "http://127.0.0.1:" + port;
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
    const route = "/api/notebooks/" + n + "/web-research",
      key = randomUUID();
    const post = (
      path: string,
      method: string,
      body: unknown,
      headers = { Cookie: cookie, Origin: origin },
    ) =>
      fetch(origin + path, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    assert.equal(
      (await post(route, "POST", { key, query: "PNG" }, {} as any)).status,
      401,
    );
    assert.equal(
      (
        await post(
          route,
          "POST",
          { key, query: "PNG" },
          { Cookie: cookie, Origin: "https://evil.invalid" },
        )
      ).status,
      403,
    );
    assert.equal((await post(route, "DELETE", { key })).status, 200);
    const cancelled = await post(route, "POST", { key, query: "PNG" });
    assert.equal(cancelled.status, 400);
    assert.match((await cancelled.json()).error, /cancelled/);
    assert.equal(
      (
        await post(route, "POST", {
          key: randomUUID(),
          query: "x".repeat(1001),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await post(route.replace(n, "foreign"), "POST", {
          key: randomUUID(),
          query: "PNG",
        })
      ).status,
      400,
    );
    const notebook = await (
      await fetch(origin + "/api/notebooks/" + n, {
        headers: { Cookie: cookie },
      })
    ).json();
    assert.equal(notebook.sources.length, 0);
    assert.equal(notebook.jobs.length, 0);
    assert.equal(notebook.runs.length, 0);
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
