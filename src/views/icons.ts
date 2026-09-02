import * as vscode from "vscode";

import type { Connection } from "../client/follow";
import type { ReactionStatus, RunStatus } from "../client/protocol";
import type { Activity } from "../model/deployment";

/**
 * One icon per state, the same everywhere a state is drawn.
 *
 * Shape as well as colour: a reader who cannot tell green from red still
 * tells a check from a cross.
 */

export function runIcon(status: RunStatus): vscode.ThemeIcon {
  switch (status) {
    case "starting":
      return new vscode.ThemeIcon("clock", new vscode.ThemeColor("charts.yellow"));
    case "running":
      return new vscode.ThemeIcon("play-circle", new vscode.ThemeColor("charts.green"));
    case "completed":
      return new vscode.ThemeIcon("pass", new vscode.ThemeColor("charts.blue"));
    case "stopped":
      return new vscode.ThemeIcon("debug-stop", new vscode.ThemeColor("charts.orange"));
    case "failed":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
  }
}

export function activityIcon(activity: Activity | ReactionStatus): vscode.ThemeIcon {
  switch (activity) {
    case "running":
      return new vscode.ThemeIcon("play-circle", new vscode.ThemeColor("charts.green"));
    case "completed":
      return new vscode.ThemeIcon("pass", new vscode.ThemeColor("charts.blue"));
    case "idle":
      return new vscode.ThemeIcon("circle-outline");
  }
}

export function connectionIcon(connection: Connection): vscode.ThemeIcon {
  switch (connection) {
    case "live":
      return new vscode.ThemeIcon("broadcast", new vscode.ThemeColor("charts.green"));
    case "connecting":
      return new vscode.ThemeIcon("sync");
    case "stale":
      return new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow"));
    case "final":
      return new vscode.ThemeIcon("lock");
  }
}

export function connectionLabel(connection: Connection): string {
  switch (connection) {
    case "live":
      return "LIVE";
    case "connecting":
      return "CONNECTING";
    case "stale":
      return "STALE";
    case "final":
      return "FINAL";
  }
}
