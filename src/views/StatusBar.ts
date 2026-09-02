import * as vscode from "vscode";

import { statusOf } from "../model/deployment";
import type { RuntimeSession } from "../runtime/RuntimeSession";

/** `OMAR: Disconnected`, `OMAR: program RUNNING`, `OMAR: program STALE`. */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscription: vscode.Disposable;

  constructor(session: RuntimeSession) {
    this.item = vscode.window.createStatusBarItem("omar.status", vscode.StatusBarAlignment.Left, 50);
    this.item.name = "OMAR";
    this.item.command = "omar.showMenu";
    this.subscription = session.onDidChange((state) => {
      const run = session.selectedRun;
      this.item.backgroundColor = undefined;
      switch (state.reach) {
        case "disconnected":
          this.item.text = "$(circle-slash) OMAR: Disconnected";
          this.item.tooltip = "Not connected to an OMAR runtime. Click to connect.";
          break;
        case "connecting":
          this.item.text = "$(sync~spin) OMAR: Connecting…";
          this.item.tooltip = `Connecting to ${state.url}`;
          break;
        case "unreachable":
          this.item.text = "$(warning) OMAR: Unreachable";
          this.item.tooltip = `${state.url}\n${state.problem ?? ""}`;
          this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
          break;
        case "connected": {
          if (!run) {
            this.item.text = "$(pulse) OMAR: No deployment";
            this.item.tooltip = `${state.url}\nNo runs yet.`;
            break;
          }
          const status = statusOf(run, state.live).toUpperCase();
          const stale = state.live?.connection === "stale";
          this.item.text = `$(pulse) OMAR: ${run.team} ${status}${stale ? " (STALE)" : ""}`;
          this.item.tooltip = `${state.url}\n${run.run_id}\n${state.live?.detail ?? ""}`;
          if (stale) this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
          break;
        }
      }
    });
    this.item.text = "$(circle-slash) OMAR: Disconnected";
    this.item.show();
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}
