import * as vscode from "vscode";

import { countGuarantees, guaranteesFor, STATUS_GLYPH, type Guarantee, type GuaranteeStatus } from "../model/guarantees";
import type { RuntimeSession } from "../runtime/RuntimeSession";
import type { ArtifactsProvider } from "./ArtifactsProvider";

const ICONS: Record<GuaranteeStatus, [string, string | null]> = {
  proven: ["verified-filled", "charts.green"],
  enforced: ["shield", "charts.green"],
  monitored: ["eye", "charts.yellow"],
  unchecked: ["question", null],
  proving: ["sync", null],
  failed: ["error", "charts.red"],
  stale: ["warning", "charts.yellow"],
  violated: ["error", "charts.red"],
};

export function guaranteeIcon(status: GuaranteeStatus): vscode.ThemeIcon {
  const [name, color] = ICONS[status];
  return new vscode.ThemeIcon(name, color ? new vscode.ThemeColor(color) : undefined);
}

/**
 * The guarantees that hold for the selected run, each with its exact status.
 *
 * Never a single "safe": enforced, monitored and unchecked are three different
 * things, and the view keeps them apart. A summary line at the top counts
 * them, and a footnote says where the list comes from.
 */
export class GuaranteesProvider implements vscode.TreeDataProvider<Guarantee | string>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly session: RuntimeSession,
    private readonly artifacts: ArtifactsProvider,
  ) {
    this.subscriptions = [
      session.onDidChange(() => this.changed.fire()),
      artifacts.onDidChangeTreeData(() => this.changed.fire()),
    ];
  }

  /** The list, as it stands. */
  current(): Guarantee[] {
    const run = this.session.selectedRun;
    if (!run) return [];
    const program = this.artifacts.current?.groups.find((group) => group.label === "Program")?.artifacts[0];
    return guaranteesFor(run, this.session.current.live?.snapshot ?? null, program?.path ?? null);
  }

  find(id: string): Guarantee | null {
    return this.current().find((guarantee) => guarantee.id === id) ?? null;
  }

  summary(): string {
    const counts = countGuarantees(this.current());
    return (Object.entries(counts) as [GuaranteeStatus, number][])
      .filter(([, count]) => count > 0)
      .map(([status, count]) => `${STATUS_GLYPH[status]} ${count} ${status}`)
      .join(" · ");
  }

  getTreeItem(node: Guarantee | string): vscode.TreeItem {
    if (typeof node === "string") {
      const item = new vscode.TreeItem(node, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("info");
      item.tooltip = node;
      return item;
    }
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    item.id = `guarantee:${node.id}`;
    item.description = node.status.toUpperCase();
    item.iconPath = guaranteeIcon(node.status);
    item.tooltip = new vscode.MarkdownString(`**${node.name}** · ${node.status.toUpperCase()}\n\n${node.property}\n\n${node.how}`);
    item.contextValue = `guarantee${node.evidence.some((evidence) => evidence.type !== "runtime-mechanism") ? ".evidence" : ""}`;
    item.command = { command: "omar.inspect", title: "Inspect", arguments: [`guarantee:${node.id}`] };
    return item;
  }

  getChildren(node?: Guarantee | string): (Guarantee | string)[] {
    if (node) return [];
    const guarantees = this.current();
    if (guarantees.length === 0) return [];
    return [
      ...guarantees,
      "Catalogue of what the runtime establishes; it does not publish guarantees yet.",
    ];
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}
