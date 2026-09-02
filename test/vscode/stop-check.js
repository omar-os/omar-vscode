// Not a test: a manual check of Stop against a real daemon. Connects to
// OMAR_URL, waits for the selected run to be live, stops it through the CLI
// with the confirmation answered, and prints what the daemon then says.
const vscode = require("vscode");
async function run() {
  const api = await vscode.extensions.getExtension("omar-os.omar-vscode").activate();
  await vscode.commands.executeCommand("omar.connect", process.env.OMAR_URL);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && api.session.current.live?.connection !== "live") await new Promise((r) => setTimeout(r, 200));
  console.log("STOP-CHECK before:", api.session.selectedRun?.team, api.session.selectedRun?.status, "canStop:", api.session.current.capabilities.stop);
  const original = vscode.window.showWarningMessage;
  vscode.window.showWarningMessage = async (message, options, ...items) => items[0];
  try {
    await vscode.commands.executeCommand("omar.stopDeployment");
  } finally {
    vscode.window.showWarningMessage = original;
  }
  const settle = Date.now() + 15000;
  while (Date.now() < settle && api.session.current.live?.connection !== "final") await new Promise((r) => setTimeout(r, 200));
  console.log("STOP-CHECK after:", api.session.selectedRun?.status, api.session.current.live?.connection, api.session.current.live?.detail);
}
module.exports = { run };
