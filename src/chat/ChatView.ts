import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import { activeEa } from "../artifacts/store";
import { dataDir, workspaceFiles } from "../artifacts/files";

import { ChatClient, type Assistant, type ChatMessage } from "../client/chat";
import type { RuntimeLauncher } from "../runtime/RuntimeLauncher";
import type { RuntimeSession } from "../runtime/RuntimeSession";
import type { ArtifactsProvider } from "../views/ArtifactsProvider";
import type { GuaranteesProvider } from "../views/GuaranteesProvider";
import type { Selection } from "../views/Inspector";
import { componentName } from "../topology/components";
import { deploymentContext, withoutContext } from "./context";
import { Thread, type ThreadState } from "./thread";

/**
 * The Assistant view: the operator's thread with the executive assistant.
 *
 * The page draws; this owns the thread (one per connected daemon), what the
 * next message carries — the inspected component as the selection, and the
 * runtime's account of the selected deployment as context — and the actions
 * on a proposal. When the daemon refuses a message because no assistant is
 * running, that is said, with a way to start one where the extension can.
 */

export type Notice = { text: string; action: string | null; label: string | null };

const STALE_ASSISTANT: Notice = {
  text: "The assistant was started before this runtime and cannot answer through it.",
  action: "restartAssistant",
  label: "Restart assistant",
};

export class ChatView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "omar.chat";

  private view: vscode.WebviewView | null = null;
  private client: ChatClient | null = null;
  private thread: Thread | null = null;
  private threadState: ThreadState = { messages: [], connection: "off", drafting: false, problem: null };
  private assistant: Assistant | null = null;
  private attachContext: boolean;
  private noticed: Notice | null = null;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly renderedEmitter = new vscode.EventEmitter<number>();
  /** How many messages the page last drew; for a test. */
  readonly onDidRender = this.renderedEmitter.event;
  rendered = -1;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly session: RuntimeSession,
    private readonly selection: Selection,
    private readonly guarantees: GuaranteesProvider,
    private readonly artifacts: ArtifactsProvider,
    private readonly launcher: RuntimeLauncher,
  ) {
    this.attachContext = vscode.workspace.getConfiguration("omar").get<boolean>("attachDeploymentContext", true);
    this.subscriptions.push(
      session.onDidChange(() => this.follow()),
      selection.onDidChange(() => this.post()),
      launcher.onDidWarn((line) => {
        // The daemon says so on stderr when the assistant it found was
        // launched without it and so cannot answer.
        if (/cannot reply or propose designs/.test(line)) {
          this.noticed = STALE_ASSISTANT;
          this.post();
        }
      }),
    );
    this.follow();
  }

  get messages(): ChatMessage[] {
    return this.threadState.messages;
  }

  get state(): ThreadState {
    return this.threadState;
  }

  /** What the view is telling the operator it cannot do, if anything. */
  get notice(): Notice | null {
    return this.noticed;
  }

  get assistantName(): string | null {
    return this.assistant?.backend ?? null;
  }

  /** Follow the connected daemon's thread, or none. */
  private follow(): void {
    const { url, reach, mode } = this.session.current;
    const wanted = reach === "connected" && mode === "daemon" ? url : null;
    if (wanted === (this.client?.url ?? null)) return;
    this.thread?.stop();
    this.thread = null;
    this.client = null;
    this.assistant = null;
    // The daemon may have said, while starting, that its assistant cannot
    // answer; that was before this thread existed, and still holds.
    this.noticed = wanted && this.launcher.ownsUrl === wanted && this.launcher.assistantWarning ? STALE_ASSISTANT : null;
    if (wanted) {
      const client = new ChatClient(wanted);
      this.client = client;
      this.thread = new Thread(client, (state) => {
        this.threadState = state;
        this.noticeFrom(state);
        this.post();
      });
      this.thread.start();
      void client.assistant().then(
        (assistant) => {
          if (this.client === client) {
            this.assistant = assistant;
            this.post();
          }
        },
        () => {
          // A daemon that predates the route simply has no name to show.
        },
      );
    } else {
      this.threadState = { messages: [], connection: "off", drafting: false, problem: null };
    }
    this.post();
  }

  private noticeFrom(state: ThreadState): void {
    if (state.problem && /executive assistant is not running/.test(state.problem)) {
      this.noticed = this.launcher.running
        ? {
            text: "No assistant is running behind this runtime. The extension started the runtime without one.",
            action: "restartWithAssistant",
            label: "Restart with assistant",
          }
        : { text: "No assistant is running behind this runtime. Start it with `omar serve --restart-ea`.", action: null, label: null };
    }
  }

  /** The operator's message, with the deployment's context in front when asked for. */
  async send(text: string): Promise<boolean> {
    if (!this.thread) return false;
    const run = this.session.selectedRun;
    const selection = this.selection.current ? [componentName(this.selection.current)] : [];
    let full = text;
    if (this.attachContext && run && this.session.current.mode === "daemon") {
      const context = deploymentContext({
        run,
        live: this.session.current.live,
        guarantees: this.guarantees.current(),
        listing: this.artifacts.current,
        inspected: this.selection.current,
        nowSeconds: Date.now() / 1000,
      });
      full = `${context}\n\n${text}`;
    }
    return this.thread.send(full, selection);
  }

  proposalAt(sequence: number): ChatMessage | null {
    return this.threadState.messages.find((message) => message.sequence === sequence && message.design) ?? null;
  }

  async act(action: string): Promise<void> {
    const url = this.session.current.url;
    switch (action) {
      case "restartWithAssistant": {
        if (!url) return;
        this.launcher.stop();
        if (await this.launcher.start(url, "the operator asked for an assistant", { withAssistant: true })) {
          this.noticed = null;
          await this.session.connect(url);
        }
        break;
      }
      case "restartAssistant": {
        const backend = this.assistant?.backend ?? this.assistant?.available[0];
        if (!backend) {
          vscode.window.showWarningMessage("The runtime did not say which backend the assistant runs on.");
          return;
        }
        await this.relaunch(backend, `Restart the assistant on ${backend}? Its current session is lost.`);
        break;
      }
      case "attachTerminal":
        await this.attachTerminal();
        break;
      default:
        if (action.startsWith("switchBackend:")) {
          const backend = action.slice("switchBackend:".length);
          if (backend && backend !== this.assistant?.backend) {
            await this.relaunch(backend, `Move the assistant to ${backend}? Its current session is lost.`);
          }
        }
    }
  }

  /** The daemon relaunches the assistant on a backend; nothing of its session survives. */
  private async relaunch(backend: string, question: string): Promise<void> {
    if (!this.client) return;
    const confirmed = await vscode.window.showWarningMessage(question, { modal: true }, "Restart");
    if (confirmed !== "Restart") return;
    try {
      await this.client.restartAssistant(backend);
      this.launcher.assistantWarning = null;
      this.noticed = null;
      this.assistant = { backend, available: this.assistant?.available ?? [backend] };
      this.post();
    } catch (cause) {
      vscode.window.showErrorMessage(`The runtime refused to restart the assistant: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  /**
   * A terminal on the assistant's own tmux pane, where it runs and prints.
   *
   * The session is named by the runtime — `<prefix>ea-<ea>` — and found by
   * asking tmux, on this extension host, which under Remote SSH is the
   * machine the assistant is on.
   */
  private async attachTerminal(): Promise<void> {
    const ea = await activeEa(workspaceFiles, dataDir());
    const sessions = await new Promise<string[]>((resolve) => {
      execFile("tmux", ["list-sessions", "-F", "#S"], { timeout: 5000 }, (error, stdout) => {
        resolve(error ? [] : stdout.split("\n").map((line) => line.trim()).filter(Boolean));
      });
    });
    const session = sessions.find((name) => name.endsWith(`ea-${ea}`)) ?? sessions.find((name) => /ea-\d+$/.test(name));
    if (!session) {
      vscode.window.showWarningMessage(
        sessions.length === 0
          ? "No tmux sessions were found on this machine; the assistant runs in one, so either tmux is not on PATH or no assistant is running."
          : `No assistant session for EA ${ea} among the tmux sessions: ${sessions.join(", ")}.`,
      );
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: `OMAR assistant · ${session}`,
      shellPath: "tmux",
      shellArgs: ["attach-session", "-t", session],
    });
    terminal.show();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, "media", "webview");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = html(view.webview, media);
    view.webview.onDidReceiveMessage(
      (message: { kind?: string; text?: string; value?: boolean; sequence?: number; action?: string; messages?: number }) => {
        switch (message.kind) {
          case "ready":
            this.post();
            break;
          case "send":
            if (typeof message.text === "string") void this.send(message.text);
            break;
          case "attachContext":
            this.attachContext = message.value === true;
            void vscode.workspace.getConfiguration("omar").update("attachDeploymentContext", this.attachContext, vscode.ConfigurationTarget.Global);
            this.post();
            break;
          case "clearSelection":
            this.selection.set(null);
            break;
          case "preview":
            if (typeof message.sequence === "number") void vscode.commands.executeCommand("omar.previewProposal", message.sequence);
            break;
          case "openProgram":
            if (typeof message.sequence === "number") void vscode.commands.executeCommand("omar.openProposalProgram", message.sequence);
            break;
          case "deploy":
            if (typeof message.sequence === "number") void vscode.commands.executeCommand("omar.deployProposal", message.sequence);
            break;
          case "action":
            if (typeof message.action === "string") void this.act(message.action);
            break;
          case "rendered":
            this.rendered = message.messages ?? 0;
            this.renderedEmitter.fire(this.rendered);
            break;
        }
      },
      null,
      this.subscriptions,
    );
    view.onDidDispose(() => {
      if (this.view === view) this.view = null;
    }, null, this.subscriptions);
    this.post();
  }

  private post(): void {
    if (!this.view) return;
    const run = this.session.selectedRun;
    const state = {
      messages: this.threadState.messages.map((message) => {
        if (message.role !== "operator") return message;
        const { text, hadContext } = withoutContext(message.text);
        return { ...message, text, contextAttached: hadContext };
      }),
      connection: this.threadState.connection,
      drafting: this.threadState.drafting,
      problem: this.threadState.problem,
      assistant: this.assistant?.backend ?? null,
      backends: this.assistant?.available ?? [],
      selection: this.selection.current ? [componentName(this.selection.current)] : [],
      deployment: run && this.session.current.mode === "daemon" ? run.team : null,
      attachContext: this.attachContext,
      notice: this.noticed,
      previewing: this.selection.proposal?.sequence ?? null,
    };
    void this.view.webview.postMessage({ kind: "state", state });
  }

  dispose(): void {
    this.thread?.stop();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.renderedEmitter.dispose();
  }
}

function html(webview: vscode.Webview, media: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.js"));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.css"));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;" />
<link rel="stylesheet" href="${style}" />
<style nonce="${nonce}">
  html, body, #root { height: 100%; margin: 0; }
  body { background: var(--ink); color: var(--text); font: 12px ui-sans-serif, system-ui, sans-serif; overflow: hidden; }
  #root { display: flex; flex-direction: column; }
  .thread-head { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--line); flex: none; }
  .thread-head select { background: var(--panel-2); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; font-size: 11px; }
  .thread-head .head-button { border: 1px solid var(--line); background: transparent; color: var(--text); border-radius: 6px; padding: 2px 8px; font-size: 11px; cursor: pointer; }
  .thread-head .head-button:hover { border-color: var(--purple); }
  .muted { color: var(--muted); }
  .pill { border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; letter-spacing: 0.04em; font-size: 10px; }
  .pill.live { border-color: #4ade80; color: #4ade80; }
  .pill.stale { border-color: #facc15; color: #facc15; }
  .pill.off, .pill.connecting { color: var(--muted); }
  .messages { padding: 14px 16px; }
  .message { max-width: 900px; }
  .messages .empty, .empty { color: var(--muted); padding: 8px 2px; }
  .waiting { color: var(--muted); font-style: italic; padding: 0 0 8px 38px; }
  .turn .context-note { margin: -14px 0 16px 38px; color: #6a6672; font-size: 10px; }
  .proposal-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: -10px 0 18px 38px; }
  .primary-button, .secondary-button { height: 26px; padding: 0 10px; border-radius: 7px; font-size: 11px; cursor: pointer; }
  .primary-button { border: 0; background: var(--purple); color: white; }
  .secondary-button { border: 1px solid var(--line); background: transparent; color: var(--text); }
  .notice { display: flex; align-items: center; gap: 10px; margin: 10px 12px 0; padding: 8px 10px; border: 1px solid rgba(250, 204, 21, 0.4); background: rgba(250, 204, 21, 0.1); border-radius: 9px; font-size: 11.5px; }
  .problem { margin: 0 16px; color: #fecaca; font-size: 11.5px; }
  .prompt-box { margin: 10px 12px 12px; max-width: 900px; }
  .prompt-box textarea { min-height: 64px; }
  .prompt-box .composer-actions { display: flex; align-items: center; justify-content: space-between; padding: 0 10px 8px 12px; color: #77737f; font-size: 10.5px; }
  .composer-status input { vertical-align: middle; }
  .selection-bar { margin: 0 12px; }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
