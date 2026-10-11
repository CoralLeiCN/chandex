import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  DriveConnection,
  DRIVE_SCOPE,
  loadDriveDesktopClient,
} from "../src/connectors/drive-connection.ts";
import {
  KeychainDriveVault,
  type DriveVault,
} from "../src/connectors/drive-vault.ts";

const client = {
  clientId: "123-synthetic.apps.googleusercontent.com",
  clientSecret: "synthetic-client-secret",
};
const now = 1791662400000;
const base = {
  schema: 1,
  clientId: client.clientId,
  connectionId: "7d50ac66-e2f3-4737-914b-746242e5b965",
  scope: DRIVE_SCOPE,
  accessToken: "synthetic-access-token",
  refreshToken: "synthetic-refresh-token",
  expiresAt: now + 3600000,
  connectedAt: new Date(now).toISOString(),
};
const token = (changes = {}) =>
  Response.json({
    access_token: "synthetic-new-access",
    refresh_token: "synthetic-new-refresh",
    token_type: "Bearer",
    scope: DRIVE_SCOPE,
    expires_in: 3600,
    ...changes,
  });
class MemoryVault implements DriveVault {
  value: any;
  writes = 0;
  clears = 0;
  constructor(value: unknown = null) {
    this.value = value;
  }
  async read() {
    return structuredClone(this.value);
  }
  async write(v: unknown) {
    this.writes++;
    this.value = structuredClone(v);
  }
  async clear() {
    this.clears++;
    this.value = null;
  }
}
function fixture(
  options: ConstructorParameters<typeof DriveConnection>[2] = {},
  vault = new MemoryVault(),
) {
  let authorization: URL | undefined;
  const calls: { url: string; options: RequestInit }[] = [];
  const connection = new DriveConnection(client, vault, {
    now: () => now,
    consentTimeoutMs: 2000,
    tokenTimeoutMs: 1000,
    openBrowser: async (url) => {
      authorization = new URL(url);
    },
    transport: async (url, init) => {
      calls.push({ url: String(url), options: init! });
      return token();
    },
    ...options,
  });
  return {
    connection,
    vault,
    calls,
    get authorization() {
      assert.ok(authorization);
      return authorization;
    },
  };
}
async function statusWhen(connection: DriveConnection, state: string) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const result = await connection.status();
    if (result.state === state) return result;
    await setImmediate();
  }
  assert.fail("Connection did not reach " + state);
}
async function callback(
  f: ReturnType<typeof fixture>,
  query: Record<string, string> = { code: "synthetic-code" },
) {
  const url = new URL(f.authorization.searchParams.get("redirect_uri")!);
  url.search = new URLSearchParams({
    state: f.authorization.searchParams.get("state")!,
    ...query,
  }).toString();
  return fetch(url);
}

test("Drive Desktop client configuration is explicit, bounded, fixed-endpoint and outside backed-up notebook data", async () => {
  const root = await mkdtemp(join(tmpdir(), "drive-client-test-"));
  const data = join(root, "data");
  await mkdir(data);
  const file = join(root, "client.json");
  const write = async (value: unknown) =>
    writeFile(file, JSON.stringify(value));
  try {
    await write({
      installed: {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        auth_uri: "https://accounts.google.com/o/oauth2/v2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
      },
    });
    assert.deepEqual(await loadDriveDesktopClient(file, data), client);
    // Google's downloadable client-secret format can contain its historical
    // endpoint spellings. They never select the actual network destinations.
    await write({
      installed: {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://accounts.google.com/o/oauth2/token",
        redirect_uris: ["http://localhost"],
      },
    });
    assert.deepEqual(await loadDriveDesktopClient(file, data), client);
    await writeFile(
      join(data, "client.json"),
      await import("node:fs/promises").then((fs) => fs.readFile(file)),
    );
    await assert.rejects(
      loadDriveDesktopClient(join(data, "client.json"), data),
      /outside/,
    );
    await symlink(join(data, "client.json"), join(root, "alias.json"));
    await assert.rejects(
      loadDriveDesktopClient(join(root, "alias.json"), data),
      /outside/,
    );
    for (const value of [
      { web: { client_id: client.clientId } },
      { installed: { client_id: "bad" } },
      {
        installed: {
          client_id: client.clientId,
          token_uri: "https://foreign.example/token",
        },
      },
      {
        installed: { client_id: client.clientId, client_secret: "bad\nsecret" },
      },
    ]) {
      await write(value);
      await assert.rejects(
        loadDriveDesktopClient(file, data),
        /valid Google Desktop/,
      );
    }
    await writeFile(file, " ".repeat(65537));
    await assert.rejects(
      loadDriveDesktopClient(file, data),
      /valid Google Desktop/,
    );
    await assert.rejects(
      loadDriveDesktopClient(join(root, "missing"), data),
      /valid Google Desktop/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Drive consent uses external-browser URL, random loopback/state/S256, one code exchange and private durable credentials", async () => {
  const f = fixture();
  try {
    assert.equal((await f.connection.status()).state, "disconnected");
    assert.equal((await f.connection.connect()).state, "connecting");
    assert.equal(
      f.authorization.origin + f.authorization.pathname,
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    const params = f.authorization.searchParams;
    assert.equal(params.get("scope"), DRIVE_SCOPE);
    assert.equal(params.get("code_challenge_method"), "S256");
    assert.equal(params.get("access_type"), "offline");
    assert.equal(params.get("include_granted_scopes"), "false");
    assert.equal(params.get("prompt"), "consent select_account");
    assert.match(params.get("state")!, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(params.has("client_secret"), false);
    const callbackURL = new URL(params.get("redirect_uri")!);
    assert.equal(callbackURL.hostname, "127.0.0.1");
    assert.ok(Number(callbackURL.port) > 0);
    const response = await callback(f);
    const page = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.doesNotMatch(page, /synthetic-code|synthetic-new|synthetic-client/);
    const status = await statusWhen(f.connection, "connected");
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, "https://oauth2.googleapis.com/token");
    const request = f.calls[0].options,
      body = request.body as URLSearchParams;
    assert.equal(request.redirect, "error");
    assert.equal(request.method, "POST");
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "synthetic-code");
    assert.equal(body.get("redirect_uri"), callbackURL.href);
    assert.equal(
      createHash("sha256")
        .update(body.get("code_verifier")!)
        .digest("base64url"),
      params.get("code_challenge"),
    );
    assert.equal(f.vault.value.scope, DRIVE_SCOPE);
    assert.equal(f.vault.writes, 1);
    assert.equal(await f.connection.accessToken(), "synthetic-new-access");
    assert.doesNotMatch(
      JSON.stringify(status),
      /token|secret|code|connectionId/,
    );
    await assert.rejects(f.connection.connect(), /Disconnect/);
    assert.equal((await f.connection.disconnect()).state, "disconnected");
    assert.equal(f.vault.value, null);
    await assert.rejects(f.connection.accessToken(), /Connect/);
  } finally {
    await f.connection.shutdown();
  }
});

test("Wrong state/path, ambiguous code and replay do not exchange tokens or consume a valid Drive consent", async () => {
  let resolve!: (response: Response) => void;
  const f = fixture({
    transport: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  try {
    await f.connection.connect();
    const url = new URL(f.authorization.searchParams.get("redirect_uri")!);
    for (const query of [
      "state=wrong&code=synthetic-code",
      "state=" + f.authorization.searchParams.get("state") + "&code=a&code=b",
      "state=" +
        f.authorization.searchParams.get("state") +
        "&error=denied&code=a",
    ]) {
      url.search = query;
      assert.equal((await fetch(url)).status, 400);
    }
    url.pathname = "/foreign";
    assert.equal((await fetch(url)).status, 400);
    assert.equal((await f.connection.status()).state, "connecting");
    assert.equal((await callback(f)).status, 200);
    assert.equal((await callback(f)).status, 400);
    resolve(token());
    await statusWhen(f.connection, "connected");
  } finally {
    await f.connection.disconnect();
    await f.connection.shutdown();
  }
});

test("Consent denial, browser failure and consent deadline return safe visible errors and close owned callbacks", async () => {
  const denied = fixture(),
    failed = fixture({
      openBrowser: async () => {
        throw Error("synthetic-provider-secret");
      },
    }),
    expired = fixture({ consentTimeoutMs: 20 });
  try {
    await denied.connection.connect();
    const response = await callback(denied, {
      error: "synthetic-provider-secret",
    });
    assert.doesNotMatch(await response.text(), /synthetic-provider-secret/);
    assert.match(
      (await statusWhen(denied.connection, "disconnected")).error!,
      /not granted/,
    );
    assert.equal(denied.calls.length, 0);
    assert.equal(denied.vault.writes, 0);
    assert.match(
      (await failed.connection.connect()).error!,
      /external browser/,
    );
    await expired.connection.connect();
    assert.match(
      (await statusWhen(expired.connection, "disconnected")).error!,
      /timed out/,
    );
    await assert.rejects(callback(expired));
  } finally {
    await Promise.all([
      denied.connection.shutdown(),
      failed.connection.shutdown(),
      expired.connection.shutdown(),
    ]);
  }
});

test("Token exchange rejects grants, shape, encoding, redirects, status, length and oversized bodies without persisting or echoing", async () => {
  const bad = [
    () =>
      token({ scope: DRIVE_SCOPE + " https://www.googleapis.com/auth/drive" }),
    () => token({ scope: undefined }),
    () => token({ token_type: "bad" }),
    () => token({ expires_in: 0 }),
    () => token({ expires_in: 86401 }),
    () => token({ expires_in: "3600" }),
    () => token({ access_token: "bad\nsecret" }),
    () => token({ refresh_token: undefined }),
    () => new Response("synthetic-provider-secret", { status: 401 }),
    () =>
      new Response("{}", {
        status: 302,
        headers: { location: "https://foreign.example/token" },
      }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
      }),
    () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": "65537",
        },
      }),
    () =>
      new Response("{}", {
        headers: { "content-type": "application/json", "content-length": "5" },
      }),
    () =>
      new Response(" ".repeat(65537), {
        headers: { "content-type": "application/json" },
      }),
    () => {
      throw Error("synthetic-provider-secret");
    },
  ];
  for (const make of bad) {
    const f = fixture({ transport: async () => make() });
    try {
      await f.connection.connect();
      await callback(f);
      const status = await statusWhen(f.connection, "disconnected");
      assert.doesNotMatch(
        JSON.stringify(status),
        /synthetic-provider-secret|synthetic-new|synthetic-client/,
      );
      assert.equal(f.vault.writes, 0);
    } finally {
      await f.connection.shutdown();
    }
  }
});

test("Restart binds stored credentials to the configured client/scope, and Keychain owner binds notebook root", async () => {
  assert.equal(
    new KeychainDriveVault("/tmp/one").owner,
    new KeychainDriveVault("/tmp/one").owner,
  );
  assert.notEqual(
    new KeychainDriveVault("/tmp/one").owner,
    new KeychainDriveVault("/tmp/two").owner,
  );
  for (const raw of [
    { ...base, clientId: "other.apps.googleusercontent.com" },
    { ...base, scope: "other" },
    { ...base, accessToken: "bad\nsecret" },
    { ...base, connectedAt: "2026-02-30T12:00:00.000Z" },
    { ...base, expiresAt: "bad" },
  ]) {
    const f = fixture({}, new MemoryVault(raw));
    try {
      assert.equal((await f.connection.status()).state, "error");
      await assert.rejects(f.connection.connect(), /Disconnect/);
      await f.connection.disconnect();
      assert.equal((await f.connection.status()).state, "disconnected");
    } finally {
      await f.connection.shutdown();
    }
  }
  const f = fixture({}, new MemoryVault(base));
  try {
    assert.equal((await f.connection.status()).state, "connected");
    assert.equal(await f.connection.accessToken(), base.accessToken);
    assert.equal(f.calls.length, 0);
    await f.connection.shutdown();
    assert.deepEqual(f.vault.value, base);
  } finally {
    await f.connection.shutdown();
  }
  const disabled = new DriveConnection(undefined, {
    read: async () => assert.fail(),
    write: async () => assert.fail(),
    clear: async () => {},
  });
  assert.equal((await disabled.status()).state, "unavailable");
  await assert.rejects(disabled.connect(), /unavailable/);
  await disabled.shutdown();
});

test("Expired access tokens refresh once for concurrent readers, retain the refresh token when omitted, and persist before use", async () => {
  let release!: (response: Response) => void,
    count = 0;
  const vault = new MemoryVault({ ...base, expiresAt: now });
  const f = fixture(
    {
      transport: async (_url, options) => {
        count++;
        const body = options!.body as URLSearchParams;
        assert.equal(body.get("grant_type"), "refresh_token");
        assert.equal(body.get("refresh_token"), base.refreshToken);
        assert.equal(body.has("code_verifier"), false);
        return new Promise((r) => {
          release = r;
        });
      },
    },
    vault,
  );
  try {
    const first = f.connection.accessToken(),
      second = f.connection.accessToken();
    while (!release) await setImmediate();
    assert.equal(count, 1);
    release(token({ refresh_token: undefined }));
    assert.deepEqual(await Promise.all([first, second]), [
      "synthetic-new-access",
      "synthetic-new-access",
    ]);
    assert.equal(vault.writes, 1);
    assert.equal(vault.value.refreshToken, base.refreshToken);
    assert.equal(await f.connection.accessToken(), "synthetic-new-access");
    assert.equal(count, 1);
  } finally {
    await f.connection.shutdown();
  }
});

test("Disconnect cancels pending exchanges/refreshes and late bodies, prevents reconnect writes, and is retryable after vault denial", async () => {
  for (const refreshing of [false, true]) {
    let release!: (r: Response) => void,
      requested = false,
      cancelled = false;
    const f = fixture(
      {
        transport: async () => {
          requested = true;
          return new Promise((r) => {
            release = r;
          });
        },
      },
      new MemoryVault(refreshing ? { ...base, expiresAt: now } : null),
    );
    let refresh: Promise<unknown> | undefined;
    try {
      if (refreshing) refresh = f.connection.accessToken().catch((e) => e);
      else {
        await f.connection.connect();
        await callback(f);
      }
      while (!requested) await setImmediate();
      assert.equal((await f.connection.disconnect()).state, "disconnected");
      release(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
      await setImmediate();
      assert.equal(cancelled, true);
      assert.equal(f.vault.value, null);
      assert.equal(f.vault.writes, 0);
      if (refresh) assert.ok((await refresh) instanceof Error);
      await assert.rejects(f.connection.accessToken(), /Connect/);
    } finally {
      await f.connection.shutdown();
    }
  }
  const vault = new MemoryVault(base);
  let deny = true;
  vault.clear = async () => {
    if (deny) throw Error("synthetic-secret");
    vault.value = null;
  };
  const f = fixture({}, vault);
  try {
    await f.connection.initialize();
    await assert.rejects(f.connection.disconnect(), /could not be removed/);
    await assert.rejects(f.connection.accessToken(), /Connect/);
    assert.equal((await f.connection.status()).state, "error");
    deny = false;
    await f.connection.disconnect();
    assert.equal(vault.value, null);
  } finally {
    await f.connection.shutdown();
  }
});

test("Disconnect during a durable connection write waits for cleanup; shutdown during setup cannot leave a callback", async () => {
  let release!: () => void,
    writing = false;
  const vault = new MemoryVault();
  vault.write = async (value) => {
    writing = true;
    await new Promise<void>((r) => {
      release = r;
    });
    vault.value = structuredClone(value);
  };
  const f = fixture({}, vault);
  try {
    await f.connection.connect();
    await callback(f);
    while (!writing) await setImmediate();
    let settled = false;
    const disconnected = f.connection.disconnect().then(() => {
      settled = true;
    });
    await setImmediate();
    assert.equal(settled, false);
    release();
    await disconnected;
    assert.equal(vault.value, null);
    assert.equal((await f.connection.status()).state, "disconnected");
    const next = f.connection.connect();
    await f.connection.shutdown();
    await next;
    await assert.rejects(callback(f));
  } finally {
    await f.connection.shutdown();
  }
});

test("Token body cancellation and deadline settle without leaking provider errors; caller cancellation preserves shared refresh", async () => {
  let cancelled = false;
  const f = fixture({
    tokenTimeoutMs: 20,
    transport: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  try {
    await f.connection.connect();
    await callback(f);
    await statusWhen(f.connection, "disconnected");
    assert.equal(cancelled, true);
  } finally {
    await f.connection.shutdown();
  }
  let release!: (r: Response) => void;
  const refreshing = fixture(
    {
      transport: async () =>
        new Promise((r) => {
          release = r;
        }),
    },
    new MemoryVault({ ...base, expiresAt: now }),
  );
  try {
    const controller = new AbortController(),
      cancelledRead = refreshing.connection
        .accessToken(controller.signal)
        .catch((e) => e),
      other = refreshing.connection.accessToken();
    while (!release) await setImmediate();
    controller.abort();
    assert.ok((await cancelledRead) instanceof Error);
    release(token());
    assert.equal(await other, "synthetic-new-access");
    assert.equal(refreshing.vault.writes, 1);
  } finally {
    await refreshing.connection.shutdown();
  }
});

test("An incomplete credential write is cleared; failed cleanup requires an explicit disconnect before reconnect", async () => {
  for (const denyCleanup of [false, true]) {
    const vault = new MemoryVault();
    vault.write = async (value) => {
      vault.value = structuredClone(value);
      throw Error("synthetic-private-vault-error");
    };
    let clearingDenied = denyCleanup;
    vault.clear = async () => {
      if (clearingDenied) throw Error("synthetic-private-vault-error");
      vault.value = null;
    };
    const f = fixture({}, vault);
    try {
      await f.connection.connect();
      await callback(f);
      const status = await statusWhen(
        f.connection,
        denyCleanup ? "error" : "disconnected",
      );
      assert.doesNotMatch(JSON.stringify(status), /synthetic-private/);
      await assert.rejects(f.connection.accessToken(), /Connect/);
      if (denyCleanup)
        await assert.rejects(f.connection.connect(), /Disconnect/);
      else assert.equal(vault.value, null);
      clearingDenied = false;
      await f.connection.disconnect();
      assert.equal(vault.value, null);
    } finally {
      await f.connection.shutdown();
    }
  }
});
