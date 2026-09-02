import * as vscode from "vscode";

import { compile } from "./omarc";
import { fromBytecode, fromSnapshot, type Topology } from "./diagram";
import { render } from "./webview";
import { RuntimeSession } from "./runtime/RuntimeSession";
import { DeploymentsProvider } from "./views/DeploymentsProvider";
import { SummaryProvider } from "./views/SummaryProvider";
import { TeamsProvider } from "./views/TeamsProvider";
import { StatusBar } from "./views/StatusBar";
import { InspectorProvider, Selection } from "./views/Inspector";
import { MissionControlPanel } from "./topology/MissionControlPanel";

const LANGUAGE = "omar";

/** What the extension hands back, so a test can watch the session it runs. */
export type OmarApi = { session: RuntimeSession; selection: Selection; panel: MissionControlPanel };

export function activate(context: vscode.ExtensionContext): OmarApi {
  const diagnostics = vscode.languages.createDiagnosticCollection(LANGUAGE);
  const panels = new DiagramPanels(context, diagnostics);
  context.subscriptions.push(diagnostics, panels);

  context.subscriptions.push(
    vscode.commands.registerCommand("omar.compile", async () => {
      const editor = omarEditor();
      if (!editor) return;
      const result = await check(editor.document, diagnostics);
      if (!result.ok) {
        vscode.window.showErrorMessage(
          `${result.problems.length} problem${result.problems.length > 1 ? "s" : ""} in ${basename(editor.document)}.`,
        );
        return;
      }
      // Written beside the source, which is where someone looking for it will
      // look. The runtime compiles to a temporary of its own and does not read
      // this; it is here to be inspected.
      const target = editor.document.uri.with({
        path: editor.document.uri.path.replace(/\.omar$/, ".json"),
      });
      await vscode.workspace.fs.writeFile(
        target,
        Buffer.from(`${JSON.stringify(result.bytecode, null, 2)}\n`),
      );
      vscode.window.showInformationMessage(
        `Compiled ${result.team} to ${basename({ uri: target } as vscode.TextDocument)}.`,
      );
    }),

    vscode.commands.registerCommand("omar.showDiagram", async () => {
      const editor = omarEditor();
      if (editor) await panels.show(editor.document);
    }),

    // A diagram tracks the file it was opened for, so editing is enough to
    // redraw it. Compiling on every keystroke would be a compiler per keystroke.
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (document.languageId !== LANGUAGE) return;
      if (vscode.workspace.getConfiguration("omar").get<boolean>("compileOnSave", true)) {
        await check(document, diagnostics);
      }
      await panels.refresh(document);
    }),

    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)),
  );

  return activateMissionControl(context);
}

export function deactivate(): void {}

/**
 * Mission Control: the runtime's deployments, read through one session.
 *
 * The views are thin. Each asks the session for what it holds and redraws
 * when told; none keeps state of its own, so none can disagree with another.
 */
function activateMissionControl(context: vscode.ExtensionContext): OmarApi {
  const session = new RuntimeSession();
  const deployments = new DeploymentsProvider(session);
  const summary = new SummaryProvider(session);
  const teams = new TeamsProvider(session);
  const selection = new Selection();
  const inspector = new InspectorProvider(session, selection);
  const inspectorView = vscode.window.createTreeView("omar.inspector", { treeDataProvider: inspector });
  const panel = new MissionControlPanel(session, selection);
  context.subscriptions.push(
    session,
    deployments,
    summary,
    teams,
    selection,
    inspector,
    inspectorView,
    panel,
    new StatusBar(session),
    vscode.window.registerTreeDataProvider("omar.deployments", deployments),
    vscode.window.registerTreeDataProvider("omar.summary", summary),
    vscode.window.registerTreeDataProvider("omar.teams", teams),
    session.onDidChange((state) => {
      void vscode.commands.executeCommand("setContext", "omar.reach", state.reach);
      void vscode.commands.executeCommand("setContext", "omar.hasSelection", state.selected !== null);
      // A new run is a new picture; what was selected in the old one is gone.
      if (selection.current && !state.live?.snapshot) selection.set(null);
    }),
    selection.onDidChange(() => {
      inspectorView.description = inspector.title() ?? undefined;
      void vscode.commands.executeCommand("setContext", "omar.inspecting", selection.current !== null);
    }),
    vscode.commands.registerCommand("omar.openMissionControl", () => panel.show()),

    vscode.commands.registerCommand("omar.connect", async (url?: string) => {
      const configured = configuredUrl();
      const chosen =
        url ??
        (await vscode.window.showInputBox({
          title: "Connect to an OMAR runtime",
          prompt: "Address of omar serve",
          value: configured,
          validateInput: (value) => {
            try {
              new URL(value);
              return null;
            } catch {
              return "Not a URL.";
            }
          },
        }));
      if (!chosen) return;
      if (chosen !== configured) {
        await vscode.workspace
          .getConfiguration("omar")
          .update("runtimeUrl", chosen, vscode.ConfigurationTarget.Global);
      }
      await session.connect(chosen);
    }),
    vscode.commands.registerCommand("omar.disconnect", () => session.disconnect()),
    vscode.commands.registerCommand("omar.refresh", () => session.refresh()),
    vscode.commands.registerCommand("omar.selectDeployment", async (runId?: string) => {
      if (runId) {
        session.select(runId);
        return;
      }
      const runs = session.current.runs;
      if (runs.length === 0) {
        vscode.window.showInformationMessage("The runtime has no deployments.");
        return;
      }
      const pick = await vscode.window.showQuickPick(
        runs.map((run) => ({
          label: run.team,
          description: run.status.toUpperCase(),
          detail: run.run_id,
          runId: run.run_id,
        })),
        { title: "Select a deployment" },
      );
      if (pick) session.select(pick.runId);
    }),
    vscode.commands.registerCommand("omar.inspect", (id: string | null) => selection.set(id ?? null)),
    vscode.commands.registerCommand("omar.showMenu", async () => {
      const state = session.current;
      const choices = [
        state.reach === "disconnected"
          ? { label: "$(plug) Connect to runtime", command: "omar.connect" }
          : { label: "$(debug-disconnect) Disconnect", command: "omar.disconnect" },
        { label: "$(type-hierarchy) Open Mission Control", command: "omar.openMissionControl" },
        { label: "$(list-selection) Select deployment", command: "omar.selectDeployment" },
        { label: "$(refresh) Refresh", command: "omar.refresh" },
      ];
      const pick = await vscode.window.showQuickPick(choices, {
        title: state.url ? `OMAR · ${state.url}` : "OMAR",
      });
      if (pick) await vscode.commands.executeCommand(pick.command);
    }),

    vscode.workspace.onDidChangeConfiguration((change) => {
      if (change.affectsConfiguration("omar.runtimeUrl") && session.current.reach !== "disconnected") {
        void session.connect(configuredUrl());
      }
    }),
  );

  // Connect on activation: the address has a default, and an unreachable
  // daemon is shown as exactly that rather than as a prompt.
  void session.connect(configuredUrl());
  return { session, selection, panel };
}

function configuredUrl(): string {
  return vscode.workspace.getConfiguration("omar").get<string>("runtimeUrl", "http://127.0.0.1:7340");
}

function omarEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.languageId === LANGUAGE) return editor;
  vscode.window.showWarningMessage("Open an .omar program first.");
  return undefined;
}

function basename(document: vscode.TextDocument): string {
  return document.uri.path.split("/").pop() ?? document.uri.path;
}

/** Compile and report, returning what the compiler said. */
async function check(
  document: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection,
): Promise<Awaited<ReturnType<typeof compile>>> {
  const compilerPath = vscode.workspace
    .getConfiguration("omar")
    .get<string>("compilerPath", "omarc");

  const result = await compile(compilerPath, document.getText(), basename(document));
  diagnostics.set(
    document.uri,
    result.ok
      ? []
      : result.problems.map((problem) => {
          const range = new vscode.Range(
            problem.line,
            problem.from,
            problem.line,
            problem.to,
          );
          const diagnostic = new vscode.Diagnostic(
            range,
            problem.message,
            vscode.DiagnosticSeverity.Error,
          );
          diagnostic.source = "omarc";
          return diagnostic;
        }),
  );
  return result;
}

/**
 * The diagram windows, one per program.
 *
 * A panel shows the compiled topology, and follows a run when one is reachable:
 * the same picture either way, with the running one carrying what is happening
 * on top of what exists.
 */
class DiagramPanels implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly streams = new Map<string, AbortController>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly diagnostics: vscode.DiagnosticCollection,
  ) {}

  async show(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    let panel = this.panels.get(key);
    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        "omar.diagram",
        `Topology · ${basename(document)}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      panel.onDidDispose(() => {
        this.panels.delete(key);
        this.streams.get(key)?.abort();
        this.streams.delete(key);
      }, null, this.context.subscriptions);
      this.panels.set(key, panel);
    }
    panel.reveal(vscode.ViewColumn.Beside, true);
    await this.refresh(document);
  }

  async refresh(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    const panel = this.panels.get(key);
    if (!panel) return;

    const result = await compile(
      vscode.workspace.getConfiguration("omar").get<string>("compilerPath", "omarc"),
      document.getText(),
      basename(document),
    );
    if (!result.ok) {
      panel.webview.html = render(null, result.problems.map((problem) => problem.message));
      return;
    }

    const topology = fromBytecode(result.bytecode);
    panel.webview.html = render(topology, []);
    await this.follow(key, panel, topology);
  }

  /**
   * Follow a running topology, if one is listening.
   *
   * The diagram server streams what is happening; a snapshot is fetched first
   * because the stream does not replay what it has already sent. When nothing
   * is there the panel keeps the compiled picture, which is the honest thing to
   * show: the program exists, it just is not running.
   */
  private async follow(key: string, panel: vscode.WebviewPanel, compiled: Topology): Promise<void> {
    this.streams.get(key)?.abort();
    const url = vscode.workspace
      .getConfiguration("omar")
      .get<string>("diagramServerUrl", "")
      .replace(/\/$/, "");
    if (!url) return;

    const abort = new AbortController();
    this.streams.set(key, abort);

    try {
      const response = await fetch(`${url}/v1/diagram`, { signal: abort.signal });
      if (!response.ok) return;
      const snapshot = fromSnapshot(await response.json());
      if (snapshot.team !== compiled.team) {
        // A different program is running. Saying so beats quietly drawing it as
        // if it were the file on screen.
        void panel.webview.postMessage({ kind: "other-run", team: snapshot.team });
        return;
      }
      void panel.webview.postMessage({ kind: "topology", topology: snapshot });
      void this.stream(url, panel, abort);
    } catch {
      // Not running, or not reachable. The compiled picture stands.
    }
  }

  /** Re-fetch on every event: the snapshot is small and always complete. */
  private async stream(
    url: string,
    panel: vscode.WebviewPanel,
    abort: AbortController,
  ): Promise<void> {
    try {
      const events = await fetch(`${url}/v1/events`, { signal: abort.signal });
      const body = events.body;
      if (!body) return;
      const reader = body.getReader();
      const decoder = new TextDecoder();
      while (!abort.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!decoder.decode(value, { stream: true }).includes("event:")) continue;
        const response = await fetch(`${url}/v1/diagram`, { signal: abort.signal });
        if (!response.ok) break;
        void panel.webview.postMessage({
          kind: "topology",
          topology: fromSnapshot(await response.json()),
        });
      }
    } catch {
      // The server shuts down with the run, which is an ordinary ending.
    }
  }

  dispose(): void {
    for (const stream of this.streams.values()) stream.abort();
    for (const panel of this.panels.values()) panel.dispose();
  }
}
