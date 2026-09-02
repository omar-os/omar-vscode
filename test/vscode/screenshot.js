// Not a test: opens Mission Control against whatever runtime OMAR_URL names,
// waits for a live picture, and leaves the window up for a screenshot.
const vscode = require("vscode");
async function run() {
  const api = await vscode.extensions.getExtension("omar-os.omar-vscode").activate();
  await vscode.commands.executeCommand("omar.connect", process.env.OMAR_URL);
  await vscode.commands.executeCommand("workbench.view.extension.omar");
  await vscode.commands.executeCommand("omar.openMissionControl");
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !api.session.current.live?.snapshot) await new Promise((r) => setTimeout(r, 200));
  await vscode.commands.executeCommand("omar.inspect", process.env.OMAR_INSPECT || null);
  await new Promise((r) => setTimeout(r, Number(process.env.OMAR_HOLD_MS || 8000)));
}
module.exports = { run };
