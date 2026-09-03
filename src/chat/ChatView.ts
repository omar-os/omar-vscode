import { randomBytes } from "node:crypto";

import * as vscode from "vscode";

import type { Terminals } from "../Terminals";

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
    private readonly terminals: Terminals,
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
    if (state.problem && /not verified/.test(state.problem) && !/Waiting/.test(state.problem)) {
      this.noticed = {
        text: "The assistant did not take the message. Its pane may be stuck on a prompt, or its backend may not have started; open it to see.",
        action: "attachTerminal",
        label: "Open assistant terminal",
      };
      return;
    }
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
        await this.terminals.attachAssistant();
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
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;" />
<style nonce="${nonce}">
  /* VS Code's own chat, in its own colours: every value is a theme variable. */
  html, body, #root { height: 100%; margin: 0; }
  body { background: var(--vscode-panel-background, var(--vscode-editor-background)); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); overflow: hidden; }
  #root { display: flex; flex-direction: column; }
  * { box-sizing: border-box; }
  .page-error { padding: 16px; color: var(--vscode-errorForeground); }
  .page-error pre { white-space: pre-wrap; }
  .muted { color: var(--vscode-descriptionForeground); }
  .grow { flex: 1; }
  header { display: flex; align-items: center; gap: 8px; padding: 6px 16px; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); flex: none; }
  header b { font-weight: 600; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
  .dot.live { background: var(--vscode-charts-green); }
  .dot.stale { background: var(--vscode-charts-yellow); }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 2px; padding: 2px 4px; font-size: 12px; }
  button { font-family: inherit; font-size: 12px; border-radius: 2px; padding: 3px 10px; cursor: pointer; border: 1px solid transparent; }
  button:disabled { opacity: 0.5; cursor: default; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  .notice { display: flex; align-items: center; gap: 10px; margin: 8px 16px 0; padding: 8px 10px; background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); border-radius: 4px; }
  .thread { flex: 1; overflow: auto; padding: 8px 0; }
  .empty { padding: 16px 20px; }
  .empty p { margin: 0 0 6px; }
  .turn { padding: 8px 20px; }
  .turn.progress .response-body { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .who { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .avatar { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 50%; font-size: 9px; font-weight: 700; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .avatar.you { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .name { font-weight: 600; }
  .chip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; border-radius: 10px; font-size: 11px; font-family: var(--vscode-editor-font-family); background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .chip.muted { background: transparent; border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); color: var(--vscode-descriptionForeground); font-family: inherit; }
  .chip button { padding: 0 2px; background: transparent; color: inherit; font-size: 12px; line-height: 1; }
  .request-body { padding: 8px 12px; border-radius: 4px; white-space: pre-wrap; background: var(--vscode-chat-requestBackground, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-chat-requestBorder, var(--vscode-widget-border, transparent)); }
  .response-body { line-height: 1.5; max-width: 900px; }
  .response-body > :first-child { margin-top: 0; }
  .response-body > :last-child { margin-bottom: 0; }
  .response-body p { margin: 0 0 8px; }
  .response-body a { color: var(--vscode-textLink-foreground); }
  .response-body code { font-family: var(--vscode-editor-font-family); font-size: 12px; background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
  .response-body pre { background: var(--vscode-textCodeBlock-background); padding: 10px 12px; border-radius: 4px; overflow: auto; }
  .response-body pre code { background: transparent; padding: 0; }
  .response-body blockquote { margin: 0 0 8px; padding-left: 10px; border-left: 3px solid var(--vscode-textBlockQuote-border); background: var(--vscode-textBlockQuote-background); }
  .response-body table { border-collapse: collapse; margin-bottom: 8px; }
  .response-body th, .response-body td { border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); padding: 3px 8px; }
  .response-body ul, .response-body ol { padding-left: 22px; margin: 0 0 8px; }
  .response-body h1, .response-body h2, .response-body h3 { font-size: 1em; margin: 10px 0 6px; }
  .actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
  .problem { margin: 0 20px 6px; color: var(--vscode-errorForeground); font-size: 12px; }
  .composer { flex: none; margin: 8px 16px 12px; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent)); border-radius: 6px; background: var(--vscode-input-background); }
  .composer:focus-within { border-color: var(--vscode-focusBorder); outline: none; }
  .attachments { padding: 8px 10px 0; }
  .composer textarea { display: block; width: 100%; resize: none; border: 0; outline: 0; padding: 10px 12px 6px; background: transparent; color: var(--vscode-input-foreground); font-family: inherit; font-size: inherit; line-height: 1.4; }
  .composer textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 0 8px 8px 12px; color: var(--vscode-descriptionForeground); font-size: 12px; }
  .toolbar label { display: inline-flex; align-items: center; gap: 4px; }
  .toolbar input { margin: 0; }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
