import * as vscode from "vscode";

import type { LogEntry } from "../client/follow";
import type { DiagramEvent } from "../client/protocol";
import { formatClock, formatTag } from "../model/format";
import type { RuntimeSession } from "../runtime/RuntimeSession";

/** What happened, newest first; a click on an event inspects its subject. */
export class EventsProvider implements vscode.TreeDataProvider<LogEntry>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly session: RuntimeSession) {
    this.subscription = session.onDidChange(() => this.changed.fire());
  }

  getTreeItem(entry: LogEntry): vscode.TreeItem {
    if (entry.kind === "note") {
      const item = new vscode.TreeItem(entry.text, vscode.TreeItemCollapsibleState.None);
      item.description = formatClock(entry.at / 1000);
      item.iconPath = new vscode.ThemeIcon("info", new vscode.ThemeColor("charts.yellow"));
      item.tooltip = entry.text;
      return item;
    }
    const { event } = entry;
    const [label, subject] = describe(event);
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `event:${event.sequence}`;
    item.description = `#${event.sequence} · ${formatClock(entry.at / 1000)}${event.tag ? ` · t=${formatTag(event.tag)}` : ""}`;
    item.iconPath = icon(event.kind);
    item.tooltip = new vscode.MarkdownString(`\`\`\`json\n${JSON.stringify(event.payload, null, 2)}\n\`\`\``);
    item.contextValue = "event";
    if (subject) item.command = { command: "omar.inspect", title: "Inspect", arguments: [subject] };
    return item;
  }

  getChildren(): LogEntry[] {
    const log = this.session.current.live?.log ?? [];
    return [...log].reverse();
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}

function describe(event: DiagramEvent): [string, string | null] {
  const reaction = typeof event.payload["reaction"] === "string" ? event.payload["reaction"] : null;
  const short = reaction?.replace(/^reaction::/, "") ?? "";
  switch (event.kind) {
    case "run_started":
      return ["Run started", null];
    case "tag_advanced": {
      const ports = Object.keys((event.payload["ports"] as Record<string, unknown> | undefined) ?? {});
      return [`Tag advanced${ports.length > 0 ? ` · ${ports.join(", ")}` : ""}`, null];
    }
    case "reaction_started":
      return [`${short} started`, reaction];
    case "reaction_completed": {
      const writes = Object.keys((event.payload["writes"] as Record<string, unknown> | undefined) ?? {});
      return [`${short} completed${writes.length > 0 ? ` · wrote ${writes.join(", ")}` : ""}`, reaction];
    }
    case "run_completed":
      return ["Run completed", null];
    case "run_failed":
      return [`Run failed · ${String(event.payload["message"] ?? "")}`, null];
  }
}

function icon(kind: DiagramEvent["kind"]): vscode.ThemeIcon {
  switch (kind) {
    case "run_started":
      return new vscode.ThemeIcon("play");
    case "tag_advanced":
      return new vscode.ThemeIcon("watch");
    case "reaction_started":
      return new vscode.ThemeIcon("play-circle", new vscode.ThemeColor("charts.green"));
    case "reaction_completed":
      return new vscode.ThemeIcon("pass", new vscode.ThemeColor("charts.blue"));
    case "run_completed":
      return new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("charts.blue"));
    case "run_failed":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
  }
}
