import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
const root = path.resolve(".codeboom/isolation");
mkdirSync(root, { recursive: true });
const canary = path.join(root, "canary.txt");
writeFileSync(canary, "PRIVATE_CANARY");
const common = [
  "sandbox",
  "--permission-profile",
  "codeboom",
  "-c",
  'permissions.codeboom={filesystem={":minimal"="read"},network={enabled=false}}',
  "--",
];
const check = (cmd: string[]) =>
  spawnSync(path.resolve("node_modules/.bin/codex"), [...common, ...cmd], {
    encoding: "utf8",
    timeout: 10000,
  });
assert.equal(check(["/bin/echo", "allowed"]).stdout.trim(), "allowed");
for (const cmd of [
  ["/bin/cat", canary],
  ["/usr/bin/touch", path.join(root, "forbidden.txt")],
]) {
  const r = check(cmd);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Operation not permitted/);
}
assert.equal(existsSync(path.join(root, "forbidden.txt")), false);
const server = spawn(
  process.execPath,
  [
    "-e",
    "require('http').createServer((q,s)=>s.end('reachable')).listen(0,'127.0.0.1',function(){console.log(this.address().port)})",
  ],
  { stdio: ["ignore", "pipe", "ignore"] },
);
try {
  const port = await new Promise<string>((resolve, reject) => {
    server.stdout.once("data", (d) => resolve(String(d).trim()));
    server.once("error", reject);
  });
  const url = "http://127.0.0.1:" + port;
  assert.equal(await (await fetch(url)).text(), "reachable");
  const denied = check(["/usr/bin/curl", "-sS", "--max-time", "3", url]);
  assert.notEqual(denied.status, 0);
  assert.equal(denied.stdout, "");
  console.log(
    "PASS: native sandbox runs; private reads, writes, and reachable network connection denied.",
  );
} finally {
  server.kill();
}
