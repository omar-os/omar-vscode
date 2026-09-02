import * as vscode from "vscode";

import type { RunRecord } from "../client/protocol";
import { elapsedOf, statusOf } from "../model/deployment";
import { formatElapsed } from "../model/format";
import type { RuntimeSession } from "../runtime/RuntimeSession";
import { runIcon } from "./icons";

/** The daemon's runs, newest first; the selected one is marked. */
export class DeploymentsProvider implements vscode.TreeDataProvider<RunRecord>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;
  private ticker: NodeJS.Timeout | null = null;

  constructor(private readonly session: RuntimeSession) {
    this.subscription = session.onDidChange(() => this.changed.fire());
    // Elapsed time moves whether or not the daemon says anything.
    this.ticker = setInterval(() => {
      if (session.current.runs.some((run) => !run.finished_at)) this.changed.fire();
    }, 1000);
  }

  getTreeItem(run: RunRecord): vscode.TreeItem {
    const state = this.session.current;
    const live = state.selected === run.run_id ? state.live : null;
    const status = statusOf(run, live);
    const item = new vscode.TreeItem(run.team, vscode.TreeItemCollapsibleState.None);
    item.id = run.run_id;
    item.description = `${status.toUpperCase()} · ${formatElapsed(elapsedOf(run, Date.now() / 1000))}`;
    item.iconPath = runIcon(status);
    item.tooltip = new vscode.MarkdownString(
      [
        `**${run.team}** · \`${run.run_id}\``,
        `Status: ${status}`,
        run.diagram_address ? `Diagram: ${run.diagram_address}` : "No diagram server.",
        run.error ? `Error: ${run.error}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
    item.contextValue = state.selected === run.run_id ? "deployment.selected" : "deployment";
    item.command = { command: "omar.selectDeployment", title: "Select deployment", arguments: [run.run_id] };
    return item;
  }

  getChildren(): RunRecord[] {
    return this.session.current.runs;
  }

  dispose(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.subscription.dispose();
    this.changed.dispose();
  }
}
