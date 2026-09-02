// Not a test: run one of the manual harnesses (screenshot.js, stop-check.js)
// in a VS Code loaded with the extension, against a real runtime.
//   OMAR_SUITE=stop-check.js OMAR_URL=http://127.0.0.1:7340 xvfb-run -a node test/vscode/manual-run.mjs
import { resolve } from "node:path";

import { runTests } from "@vscode/test-electron";

const root = resolve(import.meta.dirname, "..", "..");
const suite = process.env.OMAR_SUITE ?? "screenshot.js";
await runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: resolve(root, "test", "vscode", suite),
  launchArgs: [process.env.WS || root, "--disable-extensions", "--disable-workspace-trust"],
  extensionTestsEnv: { OMAR_URL: process.env.OMAR_URL, OMAR_INSPECT: process.env.OMAR_INSPECT, OMAR_HOLD_MS: process.env.OMAR_HOLD_MS, SIGNAL_DIR: process.env.SIGNAL_DIR, QUESTION: process.env.QUESTION, WAIT_MS: process.env.WAIT_MS },
}).catch((error) => {
  console.error(String(error));
});
