import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { runtimeFailure } from "./errors.ts";

export class Rpc extends EventEmitter {
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  readonly process: ChildProcessWithoutNullStreams;
  readonly settled: Promise<void>;
  private closed = false;
  private diagnostics = "";
  constructor(command: string, args: string[], cwd: string) {
    super();
    this.process = spawn(command, args, {
      cwd,
      stdio: "pipe",
      env: { ...process.env },
    });
    this.settled = new Promise((resolve) =>
      this.process.once("close", () => resolve()),
    );
    const onLine = (line: string) => {
      if (line.length > 4_000_000) {
        this.close(new Error("Runtime message exceeded limit."));
        return;
      }
      let message: any;
      try {
        message = JSON.parse(line);
        if (!message || typeof message !== "object" || Array.isArray(message))
          throw new Error("Invalid runtime message.");
      } catch {
        this.close(new Error("Invalid runtime protocol."));
        return;
      }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error)
          pending.reject(
            runtimeFailure(
              message.error.message ?? "Runtime request failed.",
              message.error.data?.codexErrorInfo,
            ),
          );
        else pending.resolve(message.result);
      } else this.emit("message", message);
    };
    let buffer = "";
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => {
      if (this.closed) return;
      buffer += chunk;
      let end: number;
      while (!this.closed && (end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        onLine(line);
      }
      if (buffer.length > 4_000_000) {
        buffer = "";
        this.close(new Error("Runtime message exceeded limit."));
      }
    });
    this.process.stderr.on("data", (chunk) => {
      this.diagnostics = (this.diagnostics + String(chunk)).slice(-8000);
    });
    this.process.on("error", (error) => this.close(error));
    this.process.on("exit", () => {
      this.close(new Error("Codex process exited."));
    });
  }
  send(value: unknown) {
    if (this.closed) throw new Error("Codex is closed.");
    this.process.stdin.write(JSON.stringify(value) + "\n");
  }
  request<T = any>(
    method: string,
    params: unknown = {},
    timeoutMs = 30_000,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("Codex is closed."));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex request timed out: " + method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  close(reason = new Error("Codex closed.")) {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(reason);
    }
    this.pending.clear();
    this.process.kill("SIGTERM");
    const killer = setTimeout(() => {
      if (this.process.exitCode === null) this.process.kill("SIGKILL");
    }, 2000);
    killer.unref();
    this.emit("closed", reason);
  }
}
