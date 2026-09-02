// Runs inside the extension host, against a stub runtime. Plain assert, no
// framework: the questions are few and each is a line.
const assert = require("node:assert/strict");
const vscode = require("vscode");

const { start } = require("./stub-runtime");

async function until(predicate, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

async function run() {
  const extension = vscode.extensions.getExtension("omar-os.omar-vscode");
  assert.ok(extension, "the extension is installed in the test host");
  const api = await extension.activate();
  const { session, selection, panel } = api;

  const commands = await vscode.commands.getCommands(true);
  for (const command of ["omar.connect", "omar.disconnect", "omar.selectDeployment", "omar.refresh", "omar.compile", "omar.showDiagram"]) {
    assert.ok(commands.includes(command), `${command} is registered`);
  }

  // Nothing listens on port 1, and that has to be said rather than spun on.
  // (The default address is not used: a developer's own daemon may be there.)
  await vscode.commands.executeCommand("omar.connect", "http://127.0.0.1:1");
  await until(() => session.current.reach === "unreachable", "a closed port to be reported unreachable");
  assert.ok(session.current.problem, "the reason is given");

  const stub = await start();
  try {
    await vscode.commands.executeCommand("omar.connect", stub.url);
    await until(() => session.current.reach === "connected", "the stub to be reached");
    assert.equal(session.current.runs.length, 1);
    assert.equal(session.current.selected, "run-1", "the newest run is selected on its own");

    await until(() => session.current.live?.connection === "live", "the picture to go live");
    const { snapshot } = session.current.live;
    assert.equal(snapshot.team, "program");
    const watch = snapshot.reactions.find((reaction) => reaction.id === "reaction::watch.reaction.0");
    assert.equal(watch.status, "running", "the streamed event reached the picture");
    assert.equal(session.current.live.sequence, 11);

    // The topology panel draws the same picture, and a click in it inspects.
    await vscode.commands.executeCommand("omar.openMissionControl");
    const drawn = panel.state();
    assert.equal(drawn.connection, "live");
    assert.ok(drawn.graph.nodes.some((node) => node.id === "reaction::watch.reaction.0" && node.status === "running"));
    assert.equal(drawn.graph.boxes.length, 4, "one box per instance");
    await vscode.commands.executeCommand("omar.inspect", "reaction::watch.reaction.0");
    assert.equal(selection.current, "reaction::watch.reaction.0");
    assert.equal(panel.state().selected, "reaction::watch.reaction.0");

    await vscode.commands.executeCommand("omar.disconnect");
    assert.equal(session.current.reach, "disconnected");
    assert.equal(session.current.live, null);
  } finally {
    stub.close();
  }
}

module.exports = { run };
