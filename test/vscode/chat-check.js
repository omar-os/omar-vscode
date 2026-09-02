// Not a test: a manual check of the Assistant view against a real daemon and
// a real executive assistant. Connects (starting the runtime if nothing
// answers), waits for the selected run to be live, restarts a stale
// assistant if the runtime said it cannot answer, asks about the deployment,
// and prints what came back. SIGNAL_DIR gets `connected`, `shot1`, `shot2`.
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const vscode = require("vscode");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const signal = (name) => process.env.SIGNAL_DIR && writeFileSync(join(process.env.SIGNAL_DIR, name), String(Date.now()));
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
  const { session, chat } = api;
  await vscode.commands.executeCommand("workbench.view.extension.omar");
  await vscode.commands.executeCommand("omar.connect", process.env.OMAR_URL);
  console.log("CHAT-CHECK reach:", await until(() => session.current.reach === "connected", 40_000), session.current.reach, session.current.problem);
  signal("connected");
  await until(() => session.current.live?.connection === "live", 30_000);
  await until(() => chat.state.connection === "live", 15_000);
  await sleep(1500);
  console.log("CHAT-CHECK thread:", chat.state.connection, "notice:", JSON.stringify(chat.notice));
  if (chat.notice?.action === "restartAssistant") {
    const original = vscode.window.showWarningMessage;
    vscode.window.showWarningMessage = async (message, options, ...items) => items[0];
    try {
      await chat.act("restartAssistant");
    } finally {
      vscode.window.showWarningMessage = original;
    }
    console.log("CHAT-CHECK restarted the assistant");
    await sleep(8000);
  }
  await vscode.commands.executeCommand("omar.inspect", "reaction::judge.reaction.0");
  await vscode.commands.executeCommand("omar.chat.focus");
  const sent = await chat.send(process.env.QUESTION || "What is this deployment doing right now, and what is it waiting on? Two sentences.");
  console.log("CHAT-CHECK sent:", sent, chat.state.problem);
  await sleep(2500);
  signal("shot1");
  const answered = await until(
    () => chat.messages.some((message) => message.role === "assistant" && !message.progress),
    Number(process.env.WAIT_MS || 150_000),
  );
  console.log("CHAT-CHECK answered:", answered);
  for (const message of chat.messages) {
    console.log(`CHAT-CHECK [${message.sequence}] ${message.role}${message.progress ? " (progress)" : ""}${message.design ? " (proposal)" : ""}: ${message.text.slice(-400).replace(/\n/g, " ⏎ ")}`);
  }
  await sleep(1500);
  signal("shot2");
  await sleep(Number(process.env.HOLD_MS || 4000));
}

module.exports = { run };
