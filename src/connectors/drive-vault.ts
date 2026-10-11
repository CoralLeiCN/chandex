import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

export interface DriveVault {
  read(): Promise<unknown | null>;
  write(value: unknown): Promise<void>;
  clear(): Promise<void>;
}
export class KeychainDriveVault implements DriveVault {
  readonly owner: string;
  constructor(
    dataRoot: string,
    private readonly helper = resolve(".codeboom/bin/drive-keychain"),
  ) {
    this.owner = createHash("sha256")
      .update(
        "codeboom-drive\0" +
          resolve(dataRoot) +
          "\0" +
          String(process.getuid?.()),
      )
      .digest("hex");
  }
  private request(
    action: "read" | "write" | "clear",
    value?: unknown,
  ): Promise<{ value?: unknown; ok?: boolean }> {
    if (process.platform !== "darwin" || !existsSync(this.helper))
      return Promise.reject(
        Error(
          "Run npm run drive:setup on macOS to enable secure Drive credentials.",
        ),
      );
    let stored: string | undefined;
    try {
      stored = value === undefined ? undefined : JSON.stringify(value);
    } catch {
      return Promise.reject(Error("Secure Drive credentials are invalid."));
    }
    if (action === "write" && stored === undefined)
      return Promise.reject(Error("Secure Drive credentials are invalid."));
    if (stored !== undefined && Buffer.byteLength(stored) > 24576)
      return Promise.reject(
        Error("Secure Drive credentials exceed their size limit."),
      );
    return new Promise((resolve, reject) => {
      const child = spawn(this.helper, [], {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        }),
        parts: Buffer[] = [];
      let size = 0,
        failure = false;
      let escalation: NodeJS.Timeout | undefined;
      const fail = () => {
        if (failure) return;
        failure = true;
        child.kill("SIGTERM");
        escalation = setTimeout(() => child.kill("SIGKILL"), 250);
      };
      const timer = setTimeout(fail, 10000);
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 65536) fail();
        else parts.push(chunk);
      });
      child.stderr.resume();
      child.stdin.on("error", fail);
      child.once("error", fail);
      child.once("close", (code) => {
        clearTimeout(timer);
        if (escalation) clearTimeout(escalation);
        if (failure || code !== 0) {
          reject(
            Error(
              "Secure Drive credential store is unavailable. Check Keychain access.",
            ),
          );
          return;
        }
        try {
          const result = JSON.parse(Buffer.concat(parts).toString());
          if (
            !result ||
            result.error ||
            (action !== "read" && result.ok !== true)
          )
            throw Error();
          resolve(result);
        } catch {
          reject(Error("Secure Drive credential response is invalid."));
        }
      });
      child.stdin.end(
        JSON.stringify({
          action,
          owner: this.owner,
          ...(stored !== undefined ? { value: stored } : {}),
        }),
      );
    });
  }
  async read() {
    const { value } = await this.request("read");
    if (value === null) return null;
    if (typeof value !== "string")
      throw Error("Secure Drive credential response is invalid.");
    try {
      return JSON.parse(value);
    } catch {
      throw Error(
        "Secure Drive credentials are invalid. Disconnect and reconnect.",
      );
    }
  }
  async write(value: unknown) {
    await this.request("write", value);
  }
  async clear() {
    await this.request("clear");
  }
}
