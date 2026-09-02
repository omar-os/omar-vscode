import * as vscode from "vscode";

import { countsOf, elapsedOf, statusOf } from "../model/deployment";
import { formatClock, formatElapsed, formatNanos, formatTag } from "../model/format";
import type { RuntimeSession } from "../runtime/RuntimeSession";
import type { ArtifactsProvider } from "./ArtifactsProvider";
import type { GuaranteesProvider } from "./GuaranteesProvider";
import { connectionIcon, connectionLabel, runIcon } from "./icons";

type Row = { label: string; value: string; icon?: vscode.ThemeIcon; tooltip?: string };

/**
 * The selected run at a glance: what it is, where it is, whether the picture
 * is live. Only what the runtime actually said; a row that has no value has
 * no row.
 */
export class SummaryProvider implements vscode.TreeDataProvider<Row>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;
  private readonly ticker: NodeJS.Timeout;

  constructor(
    private readonly session: RuntimeSession,
    private readonly artifacts: ArtifactsProvider,
    private readonly guarantees: GuaranteesProvider,
  ) {
    this.subscription = vscode.Disposable.from(
      session.onDidChange(() => this.changed.fire()),
      artifacts.onDidChangeTreeData(() => this.changed.fire()),
    );
    this.ticker = setInterval(() => {
      const run = session.selectedRun;
      if (run && !run.finished_at) this.changed.fire();
    }, 1000);
  }

  getTreeItem(row: Row): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    item.description = row.value;
    item.iconPath = row.icon;
    item.tooltip = row.tooltip ?? `${row.label}: ${row.value}`;
    return item;
  }

  getChildren(): Row[] {
    const run = this.session.selectedRun;
    if (!run) return [];
    const { live } = this.session.current;
    const status = statusOf(run, live);
    const rows: Row[] = [
      ...(this.session.current.capabilities.readOnly
        ? [{ label: "Access", value: "READ ONLY", icon: new vscode.ThemeIcon("lock"), tooltip: "This connection reaches only a diagram server, which has no way to change the run." }]
        : []),
      { label: "Status", value: status.toUpperCase(), icon: runIcon(status) },
      { label: "Team", value: run.team },
      { label: "Run", value: run.run_id },
      ...(this.artifacts.current?.revision ? [{ label: "Revision", value: this.artifacts.current.revision, tooltip: "SHA-256 of the program as submitted, first seven digits." }] : []),
      { label: "Started", value: formatClock(run.started_at) },
      { label: "Elapsed", value: formatElapsed(elapsedOf(run, Date.now() / 1000)) },
    ];
    if (run.error) rows.push({ label: "Error", value: run.error, icon: new vscode.ThemeIcon("error") });
    if (live) {
      rows.push({
        label: "Picture",
        value: connectionLabel(live.connection),
        icon: connectionIcon(live.connection),
        tooltip: live.detail ?? `Sequence ${live.sequence}`,
      });
    }
    const snapshot = live?.snapshot ?? null;
    if (snapshot) {
      const counts = countsOf(snapshot);
      rows.push(
        { label: "Teams", value: String(counts.teams) },
        { label: "Agents", value: String(counts.agents) },
        { label: "Reactions", value: `${counts.running} running · ${counts.completed} completed · ${counts.idle} idle` },
        { label: "Logical time", value: formatTag(snapshot.current_tag) },
        { label: "Lag", value: formatNanos(snapshot.lag), tooltip: "How far physical time has run past the logical clock. Unmeasured is shown as —." },
      );
    }
    const guarantees = this.guarantees.summary();
    if (guarantees) rows.push({ label: "Guarantees", value: guarantees, icon: new vscode.ThemeIcon("shield") });
    return rows;
  }

  dispose(): void {
    clearInterval(this.ticker);
    this.subscription.dispose();
    this.changed.dispose();
  }
}
