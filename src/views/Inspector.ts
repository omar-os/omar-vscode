import * as vscode from "vscode";

import type { DiagramSnapshot } from "../client/protocol";
import { inspect, type Row } from "../model/inspect";
import type { Guarantee } from "../model/guarantees";
import type { RuntimeSession } from "../runtime/RuntimeSession";

/**
 * What the reader is looking at: one id in the picture, and optionally a set
 * of ids to bring forward. Presentation state, so it lives here and not in
 * the session, which holds only what the runtime said.
 */
export class Selection implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private id: string | null = null;
  private bright: string[] = [];
  private proposed: { sequence: number; team: string; snapshot: DiagramSnapshot } | null = null;

  get current(): string | null {
    return this.id;
  }

  get highlight(): string[] {
    return this.bright;
  }

  set(id: string | null): void {
    if (id === this.id) return;
    this.id = id;
    this.changed.fire();
  }

  setHighlight(ids: string[]): void {
    this.bright = ids;
    this.changed.fire();
  }

  /** A proposal being looked at in the diagram panel instead of the run. */
  get proposal(): { sequence: number; team: string; snapshot: DiagramSnapshot } | null {
    return this.proposed;
  }

  setProposal(proposal: { sequence: number; team: string; snapshot: DiagramSnapshot } | null): void {
    this.proposed = proposal;
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/** The selected thing, row by row, from the live snapshot. */
export class InspectorProvider implements vscode.TreeDataProvider<Row>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly session: RuntimeSession,
    private readonly selection: Selection,
    /** Where a `guarantee:` id is looked up. */
    private readonly guarantees: { find(id: string): Guarantee | null },
  ) {
    this.subscriptions = [
      session.onDidChange(() => this.changed.fire()),
      selection.onDidChange(() => this.changed.fire()),
    ];
  }

  /** The heading the view shows: what is selected, and what kind of thing it is. */
  title(): string | null {
    const id = this.selection.current;
    if (!id) return null;
    const guarantee = guaranteeId(id) ? this.guarantees.find(guaranteeId(id)!) : null;
    if (guarantee) return `${guarantee.name} · ${guarantee.status.toUpperCase()}`;
    const snapshot = this.session.current.live?.snapshot;
    if (!snapshot) return null;
    const view = inspect(snapshot, id);
    return view ? `${view.title} · ${view.kind}` : null;
  }

  getTreeItem(row: Row): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    item.description = row.value;
    item.tooltip = `${row.label}: ${row.value}`;
    if (row.ref) {
      item.command = { command: "omar.inspect", title: "Inspect", arguments: [row.ref] };
      item.iconPath = new vscode.ThemeIcon("arrow-small-right");
    }
    if (row.open) {
      item.command = { command: "vscode.open", title: "Open", arguments: [vscode.Uri.file(row.open)] };
      item.iconPath = new vscode.ThemeIcon("go-to-file");
      item.resourceUri = vscode.Uri.file(row.open);
    }
    if (row.highlight) {
      item.command = { command: "omar.showOnTopology", title: "Show on topology", arguments: [row.highlight] };
      item.iconPath = new vscode.ThemeIcon("type-hierarchy");
    }
    return item;
  }

  getChildren(): Row[] {
    const id = this.selection.current;
    if (!id) return [];
    const guarantee = guaranteeId(id) ? this.guarantees.find(guaranteeId(id)!) : null;
    if (guarantee) return guaranteeRows(guarantee);
    const snapshot = this.session.current.live?.snapshot;
    if (!snapshot) return [];
    return inspect(snapshot, id)?.rows ?? [];
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}

export function guaranteeId(id: string): string | null {
  return id.startsWith("guarantee:") ? id.slice("guarantee:".length) : null;
}

/**
 * A guarantee, row by row: status first, then the property, how it is
 * established, the evidence, and the facts. Evidence with a file opens it;
 * a mechanism is named and nothing more, because there is nothing to open.
 */
export function guaranteeRows(guarantee: Guarantee): Row[] {
  const rows: Row[] = [
    { label: "Status", value: guarantee.status.toUpperCase() },
    { label: "Runtime enforcement", value: guarantee.enforced ? "enabled" : "none" },
    { label: "Property", value: guarantee.property },
    { label: "How", value: guarantee.how },
    { label: "Source", value: guarantee.source === "runtime" ? "the runtime" : "catalogue of runtime semantics" },
  ];
  for (const evidence of guarantee.evidence) {
    switch (evidence.type) {
      case "lean-proof":
        rows.push({ label: "Proof", value: `${evidence.uri} · ${evidence.checker} · @ ${evidence.workflowRevision}`, open: evidence.uri });
        break;
      case "artifact":
        rows.push({ label: "Evidence", value: evidence.description, open: evidence.uri });
        break;
      case "runtime-mechanism":
        rows.push({ label: "Mechanism", value: evidence.description });
        break;
    }
  }
  for (const [label, value] of guarantee.details) rows.push({ label, value });
  if (guarantee.subjects.length > 0) {
    rows.push({ label: "Covers", value: `${guarantee.subjects.length} in the picture`, highlight: guarantee.subjects });
  }
  return rows;
}
