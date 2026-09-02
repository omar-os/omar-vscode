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
  const { session, launcher, selection, panel, artifacts, guarantees, chat } = api;

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

    // The topology panel is the web app's own diagram, bundled: it is handed
    // the snapshot, and it reports back what it drew once ELK has laid it out.
    await vscode.commands.executeCommand("omar.openMissionControl");
    assert.equal(panel.state().connection, "live");
    assert.equal(panel.state().snapshot.reactions.find((reaction) => reaction.id === "reaction::watch.reaction.0").status, "running");
    await until(() => panel.drawn !== null, "the diagram to report what it drew", 30_000);
    assert.equal(panel.drawn.error, null, "the diagram drew without error");
    assert.ok(panel.drawn.nodes >= 13, `the diagram drew its nodes (${panel.drawn.nodes})`);
    await vscode.commands.executeCommand("omar.inspect", "reaction::watch.reaction.0");
    assert.equal(selection.current, "reaction::watch.reaction.0");
    assert.deepEqual(panel.state().selection, ["watch.reaction.0"], "the diagram selects by component name");

    // Guarantees: precise statuses, nothing proven, and one inspects like a node.
    const listed = guarantees.current();
    assert.ok(listed.length >= 5);
    assert.equal(listed.filter((guarantee) => guarantee.status === "proven").length, 0);
    assert.ok(listed.some((guarantee) => guarantee.status === "enforced"));
    assert.ok(listed.some((guarantee) => guarantee.status === "unchecked"));
    await vscode.commands.executeCommand("omar.inspect", "guarantee:declared-effects");
    assert.equal(selection.current, "guarantee:declared-effects");
    await vscode.commands.executeCommand("omar.showOnTopology", guarantees.find("declared-effects"));
    assert.equal(panel.state().highlight.length, 4, "every reaction is brought forward");
    await vscode.commands.executeCommand("omar.clearHighlight");
    assert.equal(panel.state().highlight, null);

    // Events: the streamed transition is in the log.
    assert.ok(session.current.live.log.some((entry) => entry.kind === "event" && entry.event.kind === "reaction_started"));

    // The artifacts view lists what the run wrote and opens it natively.
    // Listed with the snapshot in hand, which names the log's agent; a
    // listing made before it arrived is not the one to look at.
    const logOf = () => artifacts.current?.groups.find((group) => group.label === "Agent logs")?.artifacts[0];
    await until(() => logOf()?.producer, "the artifacts to be listed with their producers");
    const log = logOf();
    assert.equal(log.producer, "agent::watch.agent");
    assert.match(artifacts.current.revision, /^[0-9a-f]{7}$/, "the program has a revision");
    const item = artifacts.getTreeItem({ kind: "artifact", artifact: log });
    await vscode.commands.executeCommand(item.command.command, ...item.command.arguments);
    await until(() => vscode.window.activeTextEditor?.document.uri.fsPath === log.path, "the log to open in an editor");
    assert.match(vscode.window.activeTextEditor.document.getText(), /hello from the watcher/);

    // The assistant: the thread is followed once the daemon is reached, a
    // message carries the runtime's account of the selected deployment and
    // the inspected component, and a proposal can be previewed and deployed.
    await until(() => chat.state.connection === "live", "the chat thread to go live");
    await vscode.commands.executeCommand("omar.inspect", "port::src.go");
    assert.equal(await chat.send("please propose something"), true);
    await until(() => chat.messages.some((message) => message.design), "the assistant to propose", 15_000);
    const sent = chat.messages.find((message) => message.role === "operator");
    assert.match(sent.text, /^\[Mission Control context/, "the runtime's account goes in front");
    assert.match(sent.text, /Deployment program \(run run-1\): RUNNING/);
    assert.match(sent.text, /watch\.reaction\.0 — running/);
    assert.match(sent.text, /please propose something$/);
    assert.deepEqual(sent.selection, ["src.go"], "the inspected component is the selection");
    assert.equal(chat.state.drafting, false, "a proposal ends the wait");
    const proposal = chat.messages.find((message) => message.design);
    await vscode.commands.executeCommand("omar.previewProposal", proposal.sequence);
    assert.equal(panel.state().connection, "proposal");
    assert.equal(panel.state().team, "program");
    await vscode.commands.executeCommand("omar.clearProposalPreview");
    assert.equal(panel.state().connection, "live");
    {
      const originalPick = vscode.window.showQuickPick;
      vscode.window.showQuickPick = async (items) => items[1];
      try {
        await vscode.commands.executeCommand("omar.deployProposal", proposal.sequence);
      } finally {
        vscode.window.showQuickPick = originalPick;
      }
    }
    assert.equal(stub.started.length, 1, "the proposal was deployed through the daemon");
    assert.equal(stub.started[0].program, "team T {}");
    assert.deepEqual(stub.started[0].inputs, { "src.go": 1 }, "the assistant's inputs, with nothing to ask");
    assert.equal(stub.started[0].fast, true);
    assert.equal(session.current.selected, "run-2");
    stub.started.length = 0;
    session.select("run-1");
    await until(() => session.current.live?.connection === "live", "run-1 to be live again");
    await vscode.commands.executeCommand("omar.inspect", null);

    // Capabilities are found out, not assumed: the daemon answers, so a run
    // can be started; the CLI is not asked for here, so stopping is not offered.
    await until(() => session.current.capabilities.run, "capabilities to be discovered: " + JSON.stringify(session.current.capabilities) + " reach=" + session.current.reach);
    assert.equal(session.current.capabilities.readOnly, false);
    assert.equal(session.current.capabilities.proofs, false);

    // Running a program: the daemon checks it, the operator is asked for each
    // open input, and the new run is selected.
    const program = await vscode.workspace.openTextDocument({ language: "omar", content: "team T {}" });
    const answers = ["7", "$(watch) Real time"];
    const window = vscode.window;
    const originalInput = window.showInputBox;
    const originalPick = window.showQuickPick;
    window.showInputBox = async (options) => {
      assert.match(options.title, /src\.go : int/);
      return answers.shift();
    };
    window.showQuickPick = async (items) => items.find((item) => item.label === answers.shift());
    try {
      await vscode.commands.executeCommand("omar.runProgram", program.uri);
    } finally {
      window.showInputBox = originalInput;
      window.showQuickPick = originalPick;
    }
    assert.equal(stub.started.length, 1);
    assert.deepEqual(stub.started[0].inputs, { "src.go": 7 });
    assert.equal(stub.started[0].fast, false);
    assert.equal(session.current.selected, "run-2");

    await vscode.commands.executeCommand("omar.disconnect");
    assert.equal(session.current.reach, "disconnected");
    assert.equal(session.current.live, null);

    // Nothing answering at a loopback address: the extension starts a runtime
    // itself (here the fake `omar` in the fixtures) and connects once it
    // answers, and stops it when asked.
    const free = await new Promise((resolve) => {
      const probe = require("node:net").createServer();
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
    const configuration = vscode.workspace.getConfiguration("omar");
    await configuration.update("cliPath", join(__dirname, "..", "fixtures", "fake-omar"), vscode.ConfigurationTarget.Global);
    await configuration.update("autoStartRuntime", true, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("omar.connect", `http://127.0.0.1:${free}`);
    await until(() => session.current.reach === "connected", "the runtime the extension started to answer", 30_000);
    assert.equal(launcher.running, true, "the extension owns the daemon it started");
    await vscode.commands.executeCommand("omar.stopRuntime");
    await until(() => !launcher.running, "the started runtime to stop");
    await until(() => session.current.reach !== "connected", "the session to notice the runtime is gone", 15_000);
    await configuration.update("autoStartRuntime", false, vscode.ConfigurationTarget.Global);
    await configuration.update("cliPath", undefined, vscode.ConfigurationTarget.Global);

    // A diagram server alone is read only by construction.
    await vscode.commands.executeCommand("omar.connectDiagram", stub.url);
    await until(() => session.current.reach === "connected" && session.current.live?.connection === "live", "the diagram-only picture to go live");
    assert.equal(session.current.mode, "diagram");
    assert.equal(session.current.capabilities.readOnly, true);
    assert.equal(session.current.capabilities.run, false);
    assert.equal(session.selectedRun.team, "program");
    await vscode.commands.executeCommand("omar.disconnect");
  } finally {
    stub.close();
    // The test profile is reused by a developer's own runs; leave it as found.
    await vscode.workspace.getConfiguration("omar").update("dataDir", undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration("omar").update("cliPath", undefined, vscode.ConfigurationTarget.Global);
  }
}

module.exports = { run };
