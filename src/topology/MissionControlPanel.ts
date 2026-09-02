import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import { statusOf } from "../model/deployment";
import { formatNanos, formatTag } from "../model/format";
import type { RuntimeSession } from "../runtime/RuntimeSession";
import type { Selection } from "../views/Inspector";
import { buildGraph, type Graph } from "./graph";
import { renderPanel, type PanelState } from "./webview";

/**
 * The topology panel: one, following whatever deployment is selected.
 *
 * The webview is told the whole state on every change and draws it; it keeps
 * nothing the extension does not also hold, so reopening it loses nothing.
 * Clicks come back as ids and go to the inspector like a click in a tree.
 */
export class MissionControlPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private lastGraphKey = "";
  private lastGraph: Graph | null = null;

  constructor(
    private readonly session: RuntimeSession,
    private readonly selection: Selection,
  ) {
    this.subscriptions.push(
      session.onDidChange(() => this.post()),
      selection.onDidChange(() => this.post()),
    );
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal(undefined, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "omar.missionControl",
      "OMAR Mission Control",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
    );
    panel.iconPath = new vscode.ThemeIcon("type-hierarchy");
    const nonce = randomBytes(16).toString("base64");
    panel.webview.html = renderPanel(panel.webview.cspSource, nonce);
    panel.webview.onDidReceiveMessage(
      (message: { kind?: string; id?: string | null }) => {
        if (message.kind === "ready") this.post();
        if (message.kind === "select") this.selection.set(typeof message.id === "string" ? message.id : null);
      },
      null,
      this.subscriptions,
    );
    panel.onDidDispose(() => {
      this.panel = null;
    }, null, this.subscriptions);
    this.panel = panel;
    this.post();
  }

  private post(): void {
    if (!this.panel) return;
    void this.panel.webview.postMessage({ kind: "state", state: this.state() });
  }

  /** What the panel shows, computed afresh from the session each time. */
  state(): PanelState | null {
    const run = this.session.selectedRun;
    const { live } = this.session.current;
    if (!run) return null;
    const snapshot = live?.snapshot ?? null;
    let graph: Graph | null = null;
    const delays: Record<string, string> = {};
    if (snapshot) {
      // The layout depends on structure only, and structure does not change
      // during a run; node states are re-read from the snapshot each time.
      const key = `${run.run_id}:${snapshot.edges.length}:${snapshot.ports.length}:${snapshot.reactions.length}`;
      graph = key === this.lastGraphKey && this.lastGraph ? refresh(this.lastGraph, snapshot) : buildGraph(snapshot);
      this.lastGraphKey = key;
      this.lastGraph = graph;
      for (const edge of snapshot.edges) {
        if (edge.delay !== null && edge.delay > 0) delays[edge.id] = formatNanos(edge.delay);
      }
    }
    return {
      graph,
      team: run.team,
      status: statusOf(run, live),
      connection: live?.connection ?? "connecting",
      detail: live?.detail ?? null,
      tag: snapshot ? formatTag(snapshot.current_tag) : "",
      lag: snapshot ? formatNanos(snapshot.lag) : "",
      selected: this.selection.current,
      highlight: this.selection.highlight,
      ...{ delays },
    } as PanelState & { delays: Record<string, string> };
  }

  dispose(): void {
    this.panel?.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}

/** The same layout with the states of a newer snapshot. */
function refresh(graph: Graph, snapshot: Parameters<typeof buildGraph>[0]): Graph {
  const fresh = buildGraph(snapshot);
  const at = new Map(fresh.nodes.map((node) => [node.id, node]));
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const now = at.get(node.id);
      if (!now) return node;
      const { status, value } = now;
      const next = { ...node };
      delete next.status;
      delete next.value;
      return { ...next, ...(status ? { status } : {}), ...(value !== undefined ? { value } : {}) };
    }),
  };
}
