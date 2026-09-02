// Not a test: a helper for taking screenshots. Loads the extension, connects to
// OMAR_URL, opens Mission Control, and holds the window open for OMAR_HOLD_MS.
// Run with: DISPLAY=... OMAR_URL=http://127.0.0.1:7340 node test/vscode/screenshot-run.mjs
import { runTests } from "@vscode/test-electron";
import { resolve } from "node:path";
const root = resolve(".");
await runTests({ extensionDevelopmentPath: root, extensionTestsPath: resolve(root, "test/vscode/screenshot.js"), launchArgs: [process.env.WS || root, "--disable-extensions", "--disable-workspace-trust"], extensionTestsEnv: { OMAR_URL: process.env.OMAR_URL, OMAR_INSPECT: process.env.OMAR_INSPECT, OMAR_HOLD_MS: process.env.OMAR_HOLD_MS } }).catch((e) => { console.error(String(e)); });
