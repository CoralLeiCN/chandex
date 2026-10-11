import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

/** A fixed local process owns ONNX/WASM allocations until the OS reclaims them. */
export class AudioProcess extends EventEmitter {
  readonly child: ChildProcess;
  private exited = false;
  private failed = false;
  private readonly exitCompletion: Promise<number>;

  constructor(bytes: Buffer, preloadModules: string[] = []) {
    super();
    this.child = fork(
      new URL("./audio-process-entry.ts", import.meta.url),
      [],
      {
        execArgv: [
          "--import",
          "tsx",
          ...preloadModules.flatMap((module) => ["--import", module]),
          "--max-old-space-size=256",
        ],
        serialization: "advanced",
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    // Engine diagnostics may include source fragments. Never forward or retain.
    this.child.stdout!.resume();
    this.child.stderr!.resume();
    this.exitCompletion = new Promise((resolve) => {
      this.child.once("exit", (code) => {
        this.exited = true;
        resolve(code ?? 1);
        this.emit("exit", code);
      });
      this.child.once("error", () => {
        if (!this.child.pid) {
          this.exited = true;
          resolve(1);
        }
        this.fail("Audio extraction process failed.");
      });
    });
    this.child.on("message", (message) => this.emit("message", message));
    this.child.send({ bytes }, (error) => {
      if (error && !this.exited)
        this.fail("Audio extraction process could not receive its input.");
    });
  }

  private fail(message: string) {
    if (this.failed) return;
    this.failed = true;
    this.emit("error", new Error(message));
  }

  async terminate(): Promise<number> {
    if (!this.exited) this.child.kill("SIGKILL");
    return this.exitCompletion;
  }
}
