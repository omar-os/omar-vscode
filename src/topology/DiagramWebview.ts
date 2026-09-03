import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import type { DiagramSnapshot } from "../client/protocol";

/**
 * A panel that shows the web app's diagram.
 *
 * The page is `media/webview/diagram.js`, the web app's `DiagramCanvas`
 * bundled from the vendored omar checkout, and it draws whatever state it is
 * last given. This class owns the panel and the messages; who decides the
 * state — the session, or a compiled file — is the caller's business.
 */

export type DiagramState = {
  snapshot: DiagramSnapshot | null;
  /** Component names, which is how the diagram selects. */
  selection: string[];
  /** Ids to draw at the tag; null draws everything alike. */
  highlight: string[] | null;
  team: string;
  status: string;
  connection: "connecting" | "live" | "stale" | "final" | "compiled" | "proposal" | null;
  detail: string | null;
  tag: string;
  lag: string;
  empty: string | null;
  /** Which picture this is, and which others are on offer. */
  showing: "proposal" | "live" | "file" | "none";
  views: { live: boolean; file: string | null };
};

/** What the page last reported drawing; for a test, mostly. */
export type Drawn = { nodes: number; error: string | null };

export class DiagramWebview implements vscode.Disposable {
  private panel: vscode.WebviewPanel | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly drawnEmitter = new vscode.EventEmitter<Drawn>();
  readonly onDidDraw = this.drawnEmitter.event;
  private last: DiagramState | null = null;
  drawn: Drawn | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly viewType: string,
    private readonly title: string,
    private readonly onToggle: (component: string) => void,
    private readonly onDispose?: () => void,
    /** The reader asked for the other picture: `live` or `file`. */
    private readonly onView?: (which: "live" | "file") => void,
  ) {}

  get open(): boolean {
    return this.panel !== null;
  }

  show(column: vscode.ViewColumn = vscode.ViewColumn.Active, preserveFocus = false): void {
    if (this.panel) {
      this.panel.reveal(column, preserveFocus);
      return;
    }
    const media = vscode.Uri.joinPath(this.extensionUri, "media", "webview");
    const panel = vscode.window.createWebviewPanel(
      this.viewType,
      this.title,
      { viewColumn: column, preserveFocus },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] },
    );
    panel.iconPath = new vscode.ThemeIcon("type-hierarchy");
    panel.webview.html = html(panel.webview, media);
    panel.webview.onDidReceiveMessage(
      (message: { kind?: string; component?: string; which?: string; nodes?: number; error?: string | null }) => {
        switch (message.kind) {
          case "ready":
            if (this.last) void panel.webview.postMessage({ kind: "state", state: this.last });
            break;
          case "toggle":
            if (typeof message.component === "string") this.onToggle(message.component);
            break;
          case "view":
            if (message.which === "live" || message.which === "file") this.onView?.(message.which);
            break;
          case "drawn":
            this.drawn = { nodes: message.nodes ?? 0, error: message.error ?? null };
            this.drawnEmitter.fire(this.drawn);
            break;
        }
      },
      null,
      this.subscriptions,
    );
    panel.onDidDispose(
      () => {
        this.panel = null;
        this.drawn = null;
        this.onDispose?.();
      },
      null,
      this.subscriptions,
    );
    this.panel = panel;
    if (this.last) void panel.webview.postMessage({ kind: "state", state: this.last });
  }

  set title2(value: string) {
    if (this.panel) this.panel.title = value;
  }

  post(state: DiagramState): void {
    this.last = state;
    if (this.panel) void this.panel.webview.postMessage({ kind: "state", state });
  }

  dispose(): void {
    this.panel?.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.drawnEmitter.dispose();
  }
}

/**
 * The page: a root for React, the bundled script by nonce, the diagram's own
 * stylesheet, and a few rules for the header around it. Style attributes are
 * allowed because the diagram positions its SVG with them.
 */
function html(webview: vscode.Webview, media: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "diagram.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "diagram.css"));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;" />
<link rel="stylesheet" href="${style}" />
<style nonce="${nonce}">
  .page-error { padding: 16px; color: #fecaca; font: 12px ui-sans-serif, system-ui, sans-serif; }
  .page-error pre { white-space: pre-wrap; color: #f5f2fa; }
  html, body, #root { height: 100%; margin: 0; overflow: hidden; }
  body { background: var(--ink); color: var(--text); font: 12px ui-sans-serif, system-ui, sans-serif; }
  #root { display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 12px; padding: 6px 12px; border-bottom: 1px solid var(--line); flex: none; }
  header b { font-size: 13px; }
  header .muted { color: var(--muted); }
  .pill { border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; letter-spacing: 0.04em; font-size: 11px; }
  .pill.live { border-color: #4ade80; color: #4ade80; }
  .pill.stale { border-color: #facc15; color: #facc15; }
  .pill.final { color: var(--muted); }
  .banner { flex: none; padding: 6px 12px; background: rgba(250, 204, 21, 0.12); border-bottom: 1px solid rgba(250, 204, 21, 0.4); }
  .banner b { margin-right: 8px; }
  /* The web app draws on its dark ink; here the canvas is light, so the dark
     ports and edges read against it. The boxes are white either way. */
  .diagram-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; background: #e8e8ed; }
  .diagram-panel .diagram-wrap, .diagram-panel .diagram-canvas { background: #e8e8ed; }
  .diagram-panel .diagram-legend { background: rgba(255, 255, 255, 0.85); color: #2c2b30; }
  .diagram-panel .diagram-zoom button { background: rgba(255, 255, 255, 0.9); color: #2c2b30; border-color: #b3b1b8; }
  .diagram-panel .empty { color: #4b4950; }
  .views { margin-left: auto; display: flex; gap: 4px; }
  .views button { border: 1px solid var(--line); background: transparent; color: var(--muted); border-radius: 6px; padding: 1px 8px; font-size: 10.5px; cursor: pointer; }
  .views button.on { color: var(--text); border-color: var(--purple); }
  .empty { padding: 16px; color: var(--muted); }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
