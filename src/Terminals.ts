import * as vscode from "vscode";

import { activeEa } from "./artifacts/store";
import { dataDir, workspaceFiles } from "./artifacts/files";
import { assistantSessionFor, listSessions, sessionFor } from "./tmux";

/**
 * Terminals attached to the runtime's tmux sessions, one per session.
 *
 * Asking twice for the same pane shows the terminal that is already on it
 * rather than opening another; a terminal the operator closed is forgotten
 * and opened afresh next time.
 */
export class Terminals implements vscode.Disposable {
  private readonly open = new Map<string, vscode.Terminal>();
  private readonly subscription: vscode.Disposable;

  constructor() {
    this.subscription = vscode.window.onDidCloseTerminal((terminal) => {
      for (const [session, known] of this.open) {
        if (known === terminal) this.open.delete(session);
      }
    });
  }

  /** The assistant's own pane. */
  async attachAssistant(): Promise<void> {
    const ea = await activeEa(workspaceFiles, dataDir());
    const sessions = await listSessions();
    const session = assistantSessionFor(sessions, ea);
    if (!session) {
      vscode.window.showWarningMessage(
        sessions.length === 0
          ? "No tmux sessions were found on this machine; the assistant runs in one, so either tmux is not on PATH or no assistant is running."
          : `No assistant session for EA ${ea} among the tmux sessions: ${sessions.join(", ")}.`,
      );
      return;
    }
    this.attach(session, `OMAR assistant · ${session}`);
  }

  /**
   * A run agent's pane. `directory` is the deployment's directory, whose
   * record names each agent's session; without it tmux's list is searched.
   */
  async attachAgent(agent: string, directory: string | null): Promise<void> {
    const ea = await activeEa(workspaceFiles, dataDir());
    let recorded: Record<string, string> = {};
    if (directory) {
      try {
        const record = JSON.parse((await workspaceFiles.readFile(`${directory}/deployment.json`)) ?? "{}") as { sessions?: Record<string, string> };
        recorded = record.sessions ?? {};
      } catch {
        // An unreadable record is no record; tmux's list is the next best.
      }
    }
    const sessions = await listSessions();
    const session = sessionFor(agent, recorded, sessions, ea);
    if (!session) {
      vscode.window.showWarningMessage(`No tmux session for ${agent.replace(/^agent::/, "")} was found; the agent may not have been started, or the run is over and its session cleaned up.`);
      return;
    }
    if (!sessions.includes(session)) {
      vscode.window.showWarningMessage(`The record names ${session} for ${agent.replace(/^agent::/, "")}, but tmux has no such session; the run is over and its sessions were cleaned up.`);
      return;
    }
    this.attach(session, `OMAR · ${agent.replace(/^agent::/, "")}`);
  }

  private attach(session: string, name: string): void {
    const known = this.open.get(session);
    if (known && known.exitStatus === undefined && vscode.window.terminals.includes(known)) {
      known.show();
      return;
    }
    const terminal = vscode.window.createTerminal({ name, shellPath: "tmux", shellArgs: ["attach-session", "-t", session] });
    this.open.set(session, terminal);
    terminal.show();
  }

  dispose(): void {
    this.subscription.dispose();
  }
}
