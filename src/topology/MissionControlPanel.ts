import * as vscode from "vscode";

import { statusOf } from "../model/deployment";
import { formatNanos, formatTag } from "../model/format";
import type { RuntimeSession } from "../runtime/RuntimeSession";
import type { Selection } from "../views/Inspector";
import { componentName, idOf } from "./components";
import { DiagramWebview, type DiagramState } from "./DiagramWebview";

/**
 * The Mission Control panel: the web app's diagram, following whatever
 * deployment is selected. Clicks come back as component names, which the
 * diagram selects by, and go to the inspector as ids like a click in a tree.
 */
export class MissionControlPanel implements vscode.Disposable {
  private readonly view: DiagramWebview;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    extensionUri: vscode.Uri,
    private readonly session: RuntimeSession,
    private readonly selection: Selection,
  ) {
    this.view = new DiagramWebview(extensionUri, "omar.missionControl", "OMAR Mission Control", (component) => {
      const snapshot = session.current.live?.snapshot;
      const id = snapshot ? idOf(snapshot, component) : null;
      // A click on the selected thing clears the selection; that is what a
      // toggle is for.
      selection.set(id !== null && id === selection.current ? null : id);
    });
    this.subscriptions.push(
      session.onDidChange(() => this.post()),
      selection.onDidChange(() => this.post()),
    );
    this.post();
  }

  show(): void {
    this.view.show();
    this.post();
  }

  /** What the page last reported drawing. */
  get drawn(): { nodes: number; error: string | null } | null {
    return this.view.drawn;
  }

  get onDidDraw(): vscode.Event<{ nodes: number; error: string | null }> {
    return this.view.onDidDraw;
  }

  private post(): void {
    this.view.post(this.state());
  }

  /** What the panel shows, computed afresh from the session each time. */
  state(): DiagramState {
    const run = this.session.selectedRun;
    const { live } = this.session.current;
    if (!run) {
      return { snapshot: null, selection: [], highlight: null, team: "", status: "", connection: null, detail: null, tag: "", lag: "", empty: "Select a deployment to see its topology." };
    }
    const snapshot = live?.snapshot ?? null;
    return {
      snapshot,
      selection: this.selection.current ? [componentName(this.selection.current)] : [],
      highlight: this.selection.highlight.length > 0 ? this.selection.highlight : null,
      team: run.team,
      status: statusOf(run, live),
      connection: live?.connection ?? "connecting",
      detail: live?.detail ?? null,
      tag: snapshot ? formatTag(snapshot.current_tag) : "",
      lag: snapshot ? formatNanos(snapshot.lag) : "",
      empty: live?.detail ?? "No picture of this deployment; its diagram server is gone.",
    };
  }

  dispose(): void {
    this.view.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
