// Not a test: a manual check that a run agent's pane opens in a terminal once.
// Connects, waits for the selected run to be live, attaches to first.agent
// twice, and prints the terminals VS Code has.
const vscode = require("vscode");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(250);
  }
  return false;
}
async function run() {
  const api = await vscode.extensions.getExtension("omar-os.omar-vscode").activate();
  await vscode.commands.executeCommand("omar.connect", process.env.OMAR_URL);
  await until(() => api.session.current.reach === "connected", 40_000);
  if (process.env.SIGNAL_DIR) require("node:fs").writeFileSync(`${process.env.SIGNAL_DIR}/connected`, "1");
  await until(() => api.session.current.live?.connection === "live", 30_000);
  await until(() => api.artifacts.current?.directory, 15_000);
  const names = () => vscode.window.terminals.map((terminal) => terminal.name);
  await api.terminals.attachAgent("agent::first.agent", api.artifacts.current.directory);
  await sleep(1500);
  console.log("TERMINAL-CHECK after first:", JSON.stringify(names()));
  await api.terminals.attachAgent("agent::first.agent", api.artifacts.current.directory);
  await sleep(1000);
  console.log("TERMINAL-CHECK after second:", JSON.stringify(names()));
  await api.terminals.attachAssistant();
  await api.terminals.attachAssistant();
  await sleep(1500);
  console.log("TERMINAL-CHECK with assistant:", JSON.stringify(names()));
  await sleep(2000);
}
module.exports = { run };
