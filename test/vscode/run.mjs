// Launch a VS Code with the extension loaded and run the suite in it.
// Needs a display; CI wraps it in xvfb-run.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runTests } from "@vscode/test-electron";

const root = resolve(import.meta.dirname, "..", "..");
const workspace = mkdtempSync(join(tmpdir(), "omar-vscode-test-"));

// The extension connects on activation and starts a runtime when nothing
// answers; in a test that must not reach for a real `omar`. The profile is
// seeded so activation points at a closed port with starting turned off, and
// the suite turns it on for the step that checks it.
const userData = resolve(root, ".vscode-test", "user-data", "User");
mkdirSync(userData, { recursive: true });
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ "omar.runtimeUrl": "http://127.0.0.1:1", "omar.autoStartRuntime": false }, null, 2),
);

try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: resolve(root, "test", "vscode", "suite.js"),
    launchArgs: [workspace, "--disable-extensions", "--disable-workspace-trust", `--user-data-dir=${resolve(root, ".vscode-test", "user-data")}`],
    version: process.env.VSCODE_VERSION ?? "stable",
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
