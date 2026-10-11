import { mkdirSync, chmodSync, renameSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
if (process.platform !== "darwin" || process.argv.length !== 2)
  throw Error("Drive setup requires macOS. Usage: npm run drive:setup");
const dir = resolve(".codeboom/bin"),
  target = resolve(dir, "drive-keychain"),
  stage = target + ".tmp-" + process.pid;
mkdirSync(dir, { recursive: true, mode: 0o700 });
try {
  const child = spawn(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-O",
      "-module-cache-path",
      resolve(".codeboom/swift-module-cache"),
      "src/connectors/native/drive-keychain.swift",
      "-o",
      stage,
    ],
    { stdio: ["ignore", "inherit", "inherit"], shell: false },
  );
  const [code] = await once(child, "exit");
  if (code !== 0)
    throw Error(
      "Drive credential helper compilation failed. Install Apple's Xcode Command Line Tools.",
    );
  chmodSync(stage, 0o700);
  renameSync(stage, target);
  console.log(
    "Built local macOS Keychain helper. No account was connected or credential read.",
  );
} finally {
  rmSync(stage, { force: true });
}
