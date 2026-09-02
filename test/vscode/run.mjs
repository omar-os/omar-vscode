// Launch a VS Code with the extension loaded and run the suite in it.
// Needs a display; CI wraps it in xvfb-run.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runTests } from "@vscode/test-electron";

const root = resolve(import.meta.dirname, "..", "..");
const workspace = mkdtempSync(join(tmpdir(), "omar-vscode-test-"));

try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: resolve(root, "test", "vscode", "suite.js"),
    launchArgs: [workspace, "--disable-extensions", "--disable-workspace-trust"],
    version: process.env.VSCODE_VERSION ?? "stable",
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
