import * as vscode from "vscode";

import { inspect, type Row } from "../model/inspect";
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
  ) {
    this.subscriptions = [
      session.onDidChange(() => this.changed.fire()),
      selection.onDidChange(() => this.changed.fire()),
    ];
  }

  /** The heading the view shows: what is selected, and what kind of thing it is. */
  title(): string | null {
    const snapshot = this.session.current.live?.snapshot;
    const id = this.selection.current;
    if (!snapshot || !id) return null;
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
    return item;
  }

  getChildren(): Row[] {
    const snapshot = this.session.current.live?.snapshot;
    const id = this.selection.current;
    if (!snapshot || !id) return [];
    return inspect(snapshot, id)?.rows ?? [];
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}
