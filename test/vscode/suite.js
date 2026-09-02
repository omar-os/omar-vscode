// Runs inside the extension host, against a stub runtime. Plain assert, no
// framework: the questions are few and each is a line.
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
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
  const { session, selection, panel, artifacts } = api;

  // A data directory shaped like the runtime's, so the artifacts view has
  // something real to list and open.
  const data = mkdtempSync(join(tmpdir(), "omar-data-"));
  writeFileSync(join(data, "active_ea"), "0");
  mkdirSync(join(data, "ea/0/serve/run-1"), { recursive: true });
  writeFileSync(join(data, "ea/0/serve/run-1/program.omar"), "team T {}\n");
  mkdirSync(join(data, "ea/0/topologies/program/logs"), { recursive: true });
  writeFileSync(join(data, "ea/0/topologies/program/deployment.json"), JSON.stringify({ started_at: 1 }));
  writeFileSync(join(data, "ea/0/topologies/program/outputs.json"), "{}");
  writeFileSync(join(data, "ea/0/topologies/program/logs/watch_agent.txt"), "hello from the watcher\n");
  await vscode.workspace.getConfiguration("omar").update("dataDir", data, vscode.ConfigurationTarget.Global);

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

    // The artifacts view lists what the run wrote and opens it natively.
    await until(() => artifacts.current?.groups.length === 3, "the artifacts to be listed");
    const log = artifacts.current.groups.find((group) => group.label === "Agent logs").artifacts[0];
    assert.equal(log.producer, "agent::watch.agent");
    const item = artifacts.getTreeItem({ kind: "artifact", artifact: log });
    await vscode.commands.executeCommand(item.command.command, ...item.command.arguments);
    await until(() => vscode.window.activeTextEditor?.document.uri.fsPath === log.path, "the log to open in an editor");
    assert.match(vscode.window.activeTextEditor.document.getText(), /hello from the watcher/);

    await vscode.commands.executeCommand("omar.disconnect");
    assert.equal(session.current.reach, "disconnected");
    assert.equal(session.current.live, null);
  } finally {
    stub.close();
    // The test profile is reused by a developer's own runs; leave it as found.
    await vscode.workspace.getConfiguration("omar").update("dataDir", undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration("omar").update("runtimeUrl", undefined, vscode.ConfigurationTarget.Global);
  }
}

module.exports = { run };
