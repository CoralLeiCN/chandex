import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { KeychainDriveVault } from "../src/connectors/drive-vault.ts";

// Exercise only one newly generated synthetic owner. Never inspect another
// account or use OAuth/Google credentials, including on cleanup.
const root = await mkdtemp(join(tmpdir(), "codeboom-drive-vault-check-"));
const vault = new KeychainDriveVault(root);
let cleared = false;
try {
  assert.equal(await vault.read(), null);
  await vault.write({ synthetic: true, value: "dummy-not-a-provider-token" });
  assert.deepEqual(await vault.read(), {
    synthetic: true,
    value: "dummy-not-a-provider-token",
  });
  await vault.write({ synthetic: true, value: "updated-dummy-value" });
  assert.deepEqual(await vault.read(), {
    synthetic: true,
    value: "updated-dummy-value",
  });
  await vault.clear();
  assert.equal(await vault.read(), null);
  cleared = true;
  await writeFile(
    resolve(".codeboom/drive-vault-native-check.json"),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        platform: process.platform,
        helper: "Swift Security-framework helper",
        syntheticOwnerOnly: true,
        checks: [
          "absent read",
          "write",
          "read",
          "update",
          "read update",
          "clear",
          "absent read",
        ],
        result: "passed",
        cleanup: "synthetic entry deleted",
        authenticatedGoogleAccount: false,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Synthetic Keychain read/write/update/delete passed; owned entry removed. No Google account was accessed.",
  );
} finally {
  if (!cleared) await vault.clear();
  await rm(root, { recursive: true, force: true });
}
