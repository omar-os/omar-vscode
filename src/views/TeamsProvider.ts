import * as vscode from "vscode";

import type { DiagramReaction } from "../client/protocol";
import { teamViews, type AgentView, type TeamView } from "../model/deployment";
import { formatNanos } from "../model/format";
import type { RuntimeSession } from "../runtime/RuntimeSession";
import { activityIcon } from "./icons";

/** A team, an agent, or one of an agent's reactions. */
export type TeamsNode =
  | { kind: "team"; team: TeamView }
  | { kind: "agent"; agent: AgentView }
  | { kind: "reaction"; reaction: DiagramReaction };

/** The selected run's teams, their agents, and what each agent reacts to. */
export class TeamsProvider implements vscode.TreeDataProvider<TeamsNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly session: RuntimeSession) {
    this.subscription = session.onDidChange(() => this.changed.fire());
  }

  getTreeItem(node: TeamsNode): vscode.TreeItem {
    switch (node.kind) {
      case "team": {
        const item = new vscode.TreeItem(node.team.name, vscode.TreeItemCollapsibleState.Expanded);
        item.id = node.team.id;
        item.description = node.team.team;
        item.iconPath = new vscode.ThemeIcon("organization");
        item.contextValue = "team";
        return item;
      }
      case "agent": {
        const { agent } = node;
        const item = new vscode.TreeItem(
          agent.name.split(".").pop() ?? agent.name,
          agent.reactions.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
        );
        item.id = agent.id;
        item.description = `${agent.backend} · ${agent.activity}`;
        item.iconPath = activityIcon(agent.activity);
        item.tooltip = `${agent.name}\nbackend: ${agent.backend}\nteam: ${agent.instance}`;
        item.contextValue = "agent";
        item.command = { command: "omar.inspect", title: "Inspect", arguments: [agent.id] };
        return item;
      }
      case "reaction": {
        const { reaction } = node;
        const item = new vscode.TreeItem(reaction.name, vscode.TreeItemCollapsibleState.None);
        item.id = reaction.id;
        item.description = reaction.status + (reaction.within !== null ? ` · within ${formatNanos(reaction.within)}` : "");
        item.iconPath = activityIcon(reaction.status);
        item.tooltip = [
          `triggers: ${reaction.triggers.join(", ") || "—"}`,
          `effects: ${reaction.effects.join(", ") || "—"}`,
          `contract: ${reaction.contract || "—"}`,
          reaction.invocation_id ? `invocation: ${reaction.invocation_id}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        item.contextValue = "reaction";
        item.command = { command: "omar.inspect", title: "Inspect", arguments: [reaction.id] };
        return item;
      }
    }
  }

  getChildren(node?: TeamsNode): TeamsNode[] {
    const snapshot = this.session.current.live?.snapshot;
    if (!snapshot) return [];
    if (!node) return teamViews(snapshot).map((team) => ({ kind: "team", team }));
    switch (node.kind) {
      case "team":
        return [
          ...node.team.children.map((team): TeamsNode => ({ kind: "team", team })),
          ...node.team.agents.map((agent): TeamsNode => ({ kind: "agent", agent })),
        ];
      case "agent":
        return node.agent.reactions.map((reaction) => ({ kind: "reaction", reaction }));
      case "reaction":
        return [];
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
