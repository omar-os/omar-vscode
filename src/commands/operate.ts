import { execFile } from "node:child_process";

import * as vscode from "vscode";

import { RuntimeRefused, ServeClient } from "../client/OmarClient";
import type { DiagramSnapshot } from "../client/protocol";
import { openInputs, parseInputValue } from "../model/inputs";
import type { ProposedDesign } from "../client/chat";
import type { RuntimeSession } from "../runtime/RuntimeSession";

/**
 * The operator's controls, each one a call the runtime itself authorises.
 *
 * Starting a run is the daemon's own admission route; stopping one is the
 * daemon's own CLI, which writes the stop request the runner reads. Neither
 * is decided here. When the runtime refuses, its words are shown.
 */

/** Start the program in the active editor, asking for each open input. */
export async function runProgram(session: RuntimeSession, document?: vscode.TextDocument): Promise<void> {
  const target = document ?? vscode.window.activeTextEditor?.document;
  if (!target || target.languageId !== "omar") {
    vscode.window.showWarningMessage("Open an .omar program first.");
    return;
  }
  const url = session.current.url;
  if (session.current.reach !== "connected" || !url) {
    vscode.window.showWarningMessage("Not connected to an OMAR runtime.");
    return;
  }
  const serve = new ServeClient(url);
  const program = target.getText();
  const filename = target.uri.path.split("/").pop() ?? "program.omar";

  let check;
  try {
    check = await serve.checkProgram(program, filename.endsWith(".omar") ? filename : "program.omar");
  } catch (cause) {
    vscode.window.showErrorMessage(`The runtime could not check the program: ${describe(cause)}`);
    return;
  }
  if (!check.ok) {
    vscode.window.showErrorMessage(`The runtime refused the program: ${check.errors.join("; ")}`);
    return;
  }

  const inputs = await askInputs(check.openInputs, check.preview);
  if (inputs === undefined) return;

  const pace = await vscode.window.showQuickPick(
    [
      { label: "$(watch) Real time", description: "Delays are waits, as the program says.", fast: false },
      { label: "$(zap) As fast as the work allows", description: "Delays stay an ordering and stop being a wait.", fast: true },
    ],
    { title: `Run ${check.preview.team}` },
  );
  if (!pace) return;

  try {
    const record = await serve.startRun({ program, inputs, fast: pace.fast });
    session.adopt(record);
    vscode.window.setStatusBarMessage(`OMAR: started ${record.team} (${record.run_id.slice(0, 8)})`, 5000);
  } catch (cause) {
    vscode.window.showErrorMessage(`The runtime refused to start the run: ${describe(cause)}`);
  }
}

/**
 * Deploy what the assistant proposed: its program and the inputs it named,
 * asking the operator for any open input it left out, through the daemon's
 * own admission route. The proposal was compiled by the daemon already, so
 * the only refusal left is the run's.
 */
export async function deployProposal(session: RuntimeSession, design: ProposedDesign): Promise<boolean> {
  const url = session.current.url;
  if (session.current.reach !== "connected" || !url) {
    vscode.window.showWarningMessage("Not connected to an OMAR runtime.");
    return false;
  }
  const missing = openInputs(design.preview).filter((port) => !(port.name in design.inputs)).map((port) => port.name);
  const asked = await askInputs(missing, design.preview, design.inputs);
  if (asked === undefined) return false;
  const pace = await vscode.window.showQuickPick(
    [
      { label: "$(watch) Real time", description: "Delays are waits, as the program says.", fast: false },
      { label: "$(zap) As fast as the work allows", description: "Delays stay an ordering and stop being a wait.", fast: true },
    ],
    { title: `Deploy ${design.preview.team}` },
  );
  if (!pace) return false;
  try {
    const record = await new ServeClient(url).startRun({ program: design.program, inputs: asked, fast: pace.fast });
    session.adopt(record);
    vscode.window.setStatusBarMessage(`OMAR: started ${record.team} (${record.run_id.slice(0, 8)})`, 5000);
    return true;
  } catch (cause) {
    vscode.window.showErrorMessage(`The runtime refused to start the run: ${describe(cause)}`);
    return false;
  }
}

/** One prompt per open input, typed by the port; cancelling any cancels the run. */
async function askInputs(openInputs: string[], preview: DiagramSnapshot, given: Record<string, unknown> = {}): Promise<Record<string, unknown> | undefined> {
  const inputs: Record<string, unknown> = { ...given };
  for (const name of openInputs) {
    const type = preview.ports.find((port) => port.name === name)?.type ?? "string";
    const text = await vscode.window.showInputBox({
      title: `Input ${name} : ${type}`,
      prompt: type === "signal" ? "A signal carries no value; press Enter." : `A value of type ${type}.`,
      validateInput: (value) => (parseInputValue(type, value) === undefined ? `Not a ${type}.` : null),
    });
    if (text === undefined) return undefined;
    inputs[name] = parseInputValue(type, text);
  }
  return inputs;
}

/**
 * `omar stop <team>`, with the CLI's own words on failure.
 *
 * Not `omar kill`: for a run started through the daemon the recorded runner
 * pid is the daemon's own, so a kill takes the daemon down with the run.
 */
export async function stopDeployment(session: RuntimeSession, cliPath: string): Promise<void> {
  const run = session.selectedRun;
  if (!run) {
    vscode.window.showWarningMessage("No deployment selected.");
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    `Stop ${run.team}? The current tag closes, state and logs are persisted, and the sessions are cleaned up.`,
    { modal: true },
    "Stop",
  );
  if (confirmed !== "Stop") return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `OMAR: stopping ${run.team}…` },
    () =>
      new Promise<void>((resolve) => {
        execFile(cliPath, ["stop", run.team], { timeout: 600_000 }, (error, stdout, stderr) => {
          if (error) {
            vscode.window.showErrorMessage(`omar stop failed: ${stderr.trim() || error.message}`);
          } else {
            vscode.window.showInformationMessage(stdout.trim().split("\n").pop() ?? `${run.team} stopped.`);
          }
          void session.refresh();
          resolve();
        });
      }),
  );
}

function describe(cause: unknown): string {
  if (cause instanceof RuntimeRefused) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}
