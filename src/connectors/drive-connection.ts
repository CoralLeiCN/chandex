import http from "node:http";
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import type { DriveVault } from "./drive-vault.ts";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const CLIENT = /^[A-Za-z0-9_-]{1,200}\.apps\.googleusercontent\.com$/;
const credentialText = (v: unknown): v is string =>
  typeof v === "string" && /^[\x21-\x7e]{1,4096}$/.test(v);
const accessText = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9._~+\/-]{1,4096}={0,2}$/.test(v);
export interface DriveDesktopClient {
  clientId: string;
  clientSecret?: string;
}
export interface DriveConnectionStatus {
  configured: boolean;
  state: "unavailable" | "disconnected" | "connecting" | "connected" | "error";
  error?: string;
  connectedAt?: string;
}
interface Credential {
  schema: 1;
  clientId: string;
  connectionId: string;
  scope: typeof DRIVE_SCOPE;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  connectedAt: string;
}
export async function loadDriveDesktopClient(
  file: string,
  dataRoot: string,
): Promise<DriveDesktopClient> {
  try {
    const [location, root] = await Promise.all([
      realpath(file),
      realpath(dataRoot),
    ]);
    const within = relative(root, location);
    if (
      !within ||
      (!isAbsolute(within) && within !== ".." && !within.startsWith("../"))
    )
      throw Error();
    // Bound configuration before parsing; never return provider-defined endpoints.
    const { open } = await import("node:fs/promises");
    const handle = await open(location, "r");
    let bytes: Buffer;
    try {
      if ((await handle.stat()).size > 65536) throw Error();
      const buffer = Buffer.alloc(65537);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65536) throw Error();
      bytes = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    const client = value.installed;
    if (
      value.web ||
      !client ||
      !CLIENT.test(client.client_id) ||
      (client.auth_uri &&
        ![AUTHORIZE, "https://accounts.google.com/o/oauth2/auth"].includes(
          client.auth_uri,
        )) ||
      (client.token_uri &&
        ![TOKEN, "https://accounts.google.com/o/oauth2/token"].includes(
          client.token_uri,
        )) ||
      (client.client_secret !== undefined &&
        (!credentialText(client.client_secret) ||
          client.client_secret.length > 1024))
    )
      throw Error();
    return {
      clientId: client.client_id,
      ...(client.client_secret ? { clientSecret: client.client_secret } : {}),
    };
  } catch {
    throw Error(
      "Configure a valid Google Desktop OAuth client JSON outside the notebook data directory.",
    );
  }
}
function storedCredential(v: unknown, client: DriveDesktopClient): Credential {
  const c = v as Credential;
  if (
    !c ||
    c.schema !== 1 ||
    c.clientId !== client.clientId ||
    c.scope !== DRIVE_SCOPE ||
    typeof c.connectionId !== "string" ||
    !/^[a-f0-9-]{36}$/.test(c.connectionId) ||
    !accessText(c.accessToken) ||
    !credentialText(c.refreshToken) ||
    !Number.isSafeInteger(c.expiresAt) ||
    c.expiresAt < 0 ||
    typeof c.connectedAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(c.connectedAt) ||
    !Number.isFinite(Date.parse(c.connectedAt)) ||
    new Date(c.connectedAt).toISOString() !== c.connectedAt
  )
    throw Error();
  // Reconstruct only owned fields; do not retain arbitrary vault properties.
  return {
    schema: 1,
    clientId: c.clientId,
    connectionId: c.connectionId,
    scope: c.scope,
    accessToken: c.accessToken,
    refreshToken: c.refreshToken,
    expiresAt: c.expiresAt,
    connectedAt: c.connectedAt,
  };
}
async function externalBrowser(url: string) {
  if (process.platform !== "darwin" || !url.startsWith(AUTHORIZE + "?"))
    throw Error();
  await new Promise<void>((done, reject) => {
    const child = spawn("/usr/bin/open", [url], {
      shell: false,
      stdio: "ignore",
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 10000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(Error());
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0 ? done() : reject(Error());
    });
  });
}
function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((done, reject) => {
    const abort = () =>
      reject(
        Error("Google Drive authorization cancelled or exceeded its deadline."),
      );
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(done, () =>
        reject(
          Error("Google Drive authorization failed. Try connecting again."),
        ),
      )
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
interface Flow {
  epoch: number;
  state: string;
  verifier: string;
  redirect: string;
  controller: AbortController;
  server: http.Server;
  timer: NodeJS.Timeout;
  consumed: boolean;
  done?: Promise<void>;
}
export class DriveConnection {
  private credential: Credential | null = null;
  private state: DriveConnectionStatus;
  private epoch = 0;
  private flow?: Flow;
  private refresh?: { controller: AbortController; done: Promise<void> };
  private init?: Promise<void>;
  private writes = Promise.resolve();
  private controls = Promise.resolve();
  private stopped = false;
  constructor(
    private readonly client: DriveDesktopClient | undefined,
    private readonly vault: DriveVault,
    private readonly options: {
      transport?: typeof fetch;
      openBrowser?: (url: string) => Promise<void>;
      now?: () => number;
      consentTimeoutMs?: number;
      tokenTimeoutMs?: number;
      unavailableReason?: string;
    } = {},
  ) {
    if (
      client &&
      (!CLIENT.test(client.clientId) ||
        (client.clientSecret !== undefined &&
          !credentialText(client.clientSecret)))
    )
      throw Error("Invalid Google Desktop OAuth client configuration.");
    this.state = client
      ? { configured: true, state: "disconnected" }
      : {
          configured: false,
          state: "unavailable",
          error:
            options.unavailableReason ??
            "Google Drive connection is not configured.",
        };
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private queue<T>(fn: () => Promise<T>, control = false): Promise<T> {
    const next = (control ? this.controls : this.writes).then(fn);
    if (control)
      this.controls = next.then(
        () => {},
        () => {},
      );
    else
      this.writes = next.then(
        () => {},
        () => {},
      );
    return next;
  }
  async initialize() {
    if (!this.client || this.stopped) return;
    if (!this.init) {
      const epoch = this.epoch;
      this.init = (async () => {
        try {
          const raw = await this.vault.read();
          const credential =
            raw === null ? null : storedCredential(raw, this.client!);
          if (epoch !== this.epoch || this.stopped) return;
          this.credential = credential;
          if (credential)
            this.state = {
              configured: true,
              state: "connected",
              connectedAt: credential.connectedAt,
            };
        } catch {
          if (epoch === this.epoch && !this.stopped)
            this.state = {
              configured: true,
              state: "error",
              error:
                "Secure Drive credentials could not be loaded. Disconnect and reconnect after checking Keychain access.",
            };
        }
      })();
    }
    await this.init;
  }
  async status(): Promise<DriveConnectionStatus> {
    await this.initialize();
    return { ...this.state };
  }
  // Private provider token exchange; no provider body or exception becomes UI text.
  private async exchange(
    fields: Record<string, string>,
    controller: AbortController,
  ) {
    const signal = controller.signal;
    const timer = setTimeout(
      () => controller.abort(),
      this.options.tokenTimeoutMs ?? 20000,
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const task = Promise.resolve().then(() =>
        (this.options.transport ?? fetch)(TOKEN, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
            "accept-encoding": "identity",
          },
          body: new URLSearchParams({
            client_id: this.client!.clientId,
            ...(this.client!.clientSecret
              ? { client_secret: this.client!.clientSecret }
              : {}),
            ...fields,
          }),
        }),
      );
      task.then(
        (r) => {
          if (signal.aborted) void r.body?.cancel().catch(() => {});
        },
        () => {},
      );
      const response = await waitFor(task, signal);
      const length = response.headers.get("content-length");
      if (
        response.status !== 200 ||
        response.redirected ||
        (response.url && response.url !== TOKEN) ||
        response.headers
          .get("content-type")
          ?.split(";")[0]
          .trim()
          .toLowerCase() !== "application/json" ||
        (response.headers.has("content-encoding") &&
          response.headers.get("content-encoding") !== "identity") ||
        (length !== null &&
          (!/^\d{1,10}$/.test(length) || Number(length) > 65536)) ||
        !response.body
      ) {
        void response.body?.cancel().catch(() => {});
        throw Error();
      }
      reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await waitFor(reader.read(), signal);
        if (part.done) break;
        size += part.value.length;
        if (size > 65536) throw Error();
        parts.push(part.value);
      }
      if (length !== null && size !== Number(length)) throw Error();
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)),
      );
      if (
        !value ||
        value.token_type !== "Bearer" ||
        value.scope !== DRIVE_SCOPE ||
        !accessText(value.access_token) ||
        !Number.isInteger(value.expires_in) ||
        value.expires_in < 60 ||
        value.expires_in > 86400 ||
        (value.refresh_token !== undefined &&
          !credentialText(value.refresh_token)) ||
        signal.aborted
      )
        throw Error();
      return {
        accessToken: value.access_token as string,
        refreshToken: value.refresh_token as string | undefined,
        expiresAt: this.now() + value.expires_in * 1000,
      };
    } catch {
      throw Error(
        "Google Drive authorization failed. Reconnect and grant read-only Drive access.",
      );
    } finally {
      clearTimeout(timer);
      if (reader) {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }
  private closeFlow(flow: Flow) {
    clearTimeout(flow.timer);
    flow.server.close();
    flow.server.closeAllConnections();
    if (this.flow === flow) this.flow = undefined;
  }
  private finishFlow(flow: Flow, message: string) {
    flow.controller.abort();
    this.closeFlow(flow);
    if (this.epoch === flow.epoch && !this.stopped)
      this.state = { configured: true, state: "disconnected", error: message };
  }
  async connect(): Promise<DriveConnectionStatus> {
    const requestedEpoch = this.epoch;
    return this.queue(async () => {
      await this.initialize();
      if (requestedEpoch !== this.epoch) return { ...this.state };
      if (!this.client || this.stopped)
        throw Error("Google Drive connection is unavailable.");
      if (this.state.state !== "disconnected")
        throw Error(
          "Disconnect the current Drive connection before connecting again.",
        );
      const epoch = ++this.epoch;
      const state = randomBytes(32).toString("base64url"),
        verifier = randomBytes(48).toString("base64url");
      const controller = new AbortController();
      const server = http.createServer((req, res) =>
        this.callback(flow, req, res),
      );
      server.requestTimeout = 10000;
      server.headersTimeout = 10000;
      server.on("clientError", (_error, socket) => socket.destroy());
      await new Promise<void>((done, reject) => {
        const error = () =>
          reject(
            Error("The local Drive authorization callback could not start."),
          );
        server.once("error", error);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", error);
          done();
        });
      });
      if (epoch !== this.epoch || this.stopped) {
        server.close();
        server.closeAllConnections();
        return { ...this.state };
      }
      const redirect =
        "http://127.0.0.1:" +
        (server.address() as import("node:net").AddressInfo).port +
        "/callback";
      const flow: Flow = {
        epoch,
        state,
        verifier,
        redirect,
        controller,
        server,
        consumed: false,
        timer: setTimeout(
          () =>
            this.finishFlow(
              flow,
              "Google Drive connection timed out. Connect again when ready.",
            ),
          this.options.consentTimeoutMs ?? 600000,
        ),
      };
      this.flow = flow;
      this.state = { configured: true, state: "connecting" };
      const url = new URL(AUTHORIZE);
      url.search = new URLSearchParams({
        client_id: this.client.clientId,
        redirect_uri: redirect,
        response_type: "code",
        scope: DRIVE_SCOPE,
        state,
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
        access_type: "offline",
        prompt: "consent select_account",
        include_granted_scopes: "false",
      }).toString();
      try {
        await waitFor(
          Promise.resolve().then(() =>
            (this.options.openBrowser ?? externalBrowser)(url.href),
          ),
          controller.signal,
        );
      } catch {
        this.finishFlow(
          flow,
          "The external browser could not open. Try connecting again.",
        );
      }
      return { ...this.state };
    }, true);
  }
  private callback(
    flow: Flow,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const reply = (status: number, text: string) => {
      res.writeHead(status, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      });
      res.end(text);
    };
    if (
      req.method !== "GET" ||
      req.headers.host !== new URL(flow.redirect).host ||
      (req.url?.length ?? 0) > 8192
    ) {
      reply(400, "Invalid authorization callback.");
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? "", flow.redirect);
    } catch {
      reply(400, "Invalid authorization callback.");
      return;
    }
    const state = url.searchParams.get("state") ?? "";
    if (
      url.pathname !== "/callback" ||
      flow.consumed ||
      this.flow !== flow ||
      flow.controller.signal.aborted ||
      url.searchParams.getAll("state").length !== 1 ||
      Buffer.byteLength(state) !== Buffer.byteLength(flow.state) ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(flow.state))
    ) {
      reply(400, "Invalid or expired authorization callback.");
      return;
    }
    const code = url.searchParams.get("code"),
      denied = url.searchParams.has("error");
    if (
      (denied && (code || url.searchParams.getAll("error").length !== 1)) ||
      (!denied &&
        (url.searchParams.getAll("code").length !== 1 || !credentialText(code)))
    ) {
      reply(400, "Invalid authorization response.");
      return;
    }
    flow.consumed = true;
    if (denied) {
      reply(
        200,
        "Drive access was not granted. Return to Codeboom to connect when ready.",
      );
      this.finishFlow(flow, "Google Drive access was not granted.");
      return;
    }
    // Never put the authorization code, tokens, state or provider error on the page.
    reply(
      200,
      "Authorization received. Return to Codeboom to check the connection.",
    );
    flow.done = (async () => {
      let cleanupFailed = false;
      const clearIncomplete = async () => {
        try {
          await this.vault.clear();
        } catch {
          cleanupFailed = true;
          throw Error();
        }
      };
      try {
        const token = await this.exchange(
          {
            grant_type: "authorization_code",
            code: code!,
            redirect_uri: flow.redirect,
            code_verifier: flow.verifier,
          },
          flow.controller,
        );
        if (!token.refreshToken) throw Error();
        const record: Credential = {
          schema: 1,
          clientId: this.client!.clientId,
          connectionId: randomUUID(),
          scope: DRIVE_SCOPE,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          expiresAt: token.expiresAt,
          connectedAt: new Date(this.now()).toISOString(),
        };
        await this.queue(async () => {
          if (this.epoch !== flow.epoch || flow.controller.signal.aborted)
            return;
          try {
            await this.vault.write(record);
          } catch {
            await clearIncomplete();
            throw Error();
          }
          if (this.epoch !== flow.epoch || flow.controller.signal.aborted) {
            await clearIncomplete();
            return;
          }
          this.credential = record;
          this.state = {
            configured: true,
            state: "connected",
            connectedAt: record.connectedAt,
          };
        });
        this.closeFlow(flow);
      } catch {
        this.finishFlow(
          flow,
          "Google Drive connection failed. Check Keychain access and grant read-only Drive access when reconnecting.",
        );
        if (cleanupFailed && this.epoch === flow.epoch && !this.stopped)
          this.state = {
            configured: true,
            state: "error",
            error:
              "Drive connection stopped, but incomplete credentials could not be removed. Check Keychain access and disconnect.",
          };
      }
    })();
  }
  async accessToken(signal?: AbortSignal): Promise<string> {
    await this.initialize();
    if (!this.credential || this.stopped || signal?.aborted)
      throw Error("Connect Google Drive before importing a file.");
    if (this.credential.expiresAt > this.now() + 60000)
      return this.credential.accessToken;
    if (!this.refresh) {
      const epoch = this.epoch,
        record = this.credential,
        controller = new AbortController();
      const done = (async () => {
        const token = await this.exchange(
          { grant_type: "refresh_token", refresh_token: record.refreshToken },
          controller,
        );
        await this.queue(async () => {
          if (this.epoch !== epoch || controller.signal.aborted)
            throw Error("Google Drive connection was disconnected.");
          const next: Credential = {
            ...record,
            ...token,
            refreshToken: token.refreshToken ?? record.refreshToken,
          };
          await this.vault.write(next);
          if (this.epoch !== epoch || controller.signal.aborted)
            throw Error("Google Drive connection was disconnected.");
          this.credential = next;
        });
      })();
      const refresh = { controller, done };
      this.refresh = refresh;
      void done
        .finally(() => {
          if (this.refresh === refresh) this.refresh = undefined;
        })
        .catch(() => {});
    }
    try {
      await (signal ? waitFor(this.refresh.done, signal) : this.refresh.done);
    } catch {
      throw Error(
        "Google Drive authorization failed. Try again or disconnect and reconnect.",
      );
    }
    if (!this.credential || this.stopped || signal?.aborted)
      throw Error("Google Drive retrieval cancelled.");
    return this.credential.accessToken;
  }
  async disconnect(): Promise<DriveConnectionStatus> {
    ++this.epoch;
    const flow = this.flow,
      refresh = this.refresh;
    flow?.controller.abort();
    refresh?.controller.abort();
    if (flow) this.closeFlow(flow);
    this.credential = null;
    return this.queue(async () => {
      await Promise.allSettled([this.init, flow?.done, refresh?.done]);
      try {
        await this.queue(() => this.vault.clear());
        this.state = this.client
          ? { configured: true, state: "disconnected" }
          : this.state;
      } catch {
        this.state = {
          configured: !!this.client,
          state: "error",
          error:
            "Drive access has stopped, but credentials could not be removed. Check Keychain access and disconnect again.",
        };
        throw Error(this.state.error);
      }
      return { ...this.state };
    }, true);
  }
  async shutdown() {
    this.stopped = true;
    ++this.epoch;
    const flow = this.flow,
      refresh = this.refresh;
    flow?.controller.abort();
    refresh?.controller.abort();
    if (flow) this.closeFlow(flow);
    await Promise.allSettled([
      this.controls,
      this.init,
      flow?.done,
      refresh?.done,
      this.writes,
    ]);
    this.credential = null;
  }
}
