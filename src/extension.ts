import * as vscode from "vscode";

import { compileProgram, type Compiled } from "./compile";
import { diagramOnlySource } from "./client/diagramOnly";
import { followRun } from "./client/follow";
import { DiagramWebview, type DiagramState } from "./topology/DiagramWebview";
import { RuntimeSession } from "./runtime/RuntimeSession";
import { RuntimeLauncher } from "./runtime/RuntimeLauncher";
import { isRunFinished } from "./client/protocol";
import { normalizeRuntimeUrl } from "./client/OmarClient";
import { formatNanos, formatTag } from "./model/format";
import { DeploymentsProvider } from "./views/DeploymentsProvider";
import { SummaryProvider } from "./views/SummaryProvider";
import { TeamsProvider } from "./views/TeamsProvider";
import { StatusBar } from "./views/StatusBar";
import { InspectorProvider, Selection } from "./views/Inspector";
import { MissionControlPanel } from "./topology/MissionControlPanel";
import type { Guarantee } from "./model/guarantees";
import { deployProposal, runProgram, stopDeployment } from "./commands/operate";
import { ChatView } from "./chat/ChatView";
import { dataDir, workspaceFiles } from "./artifacts/files";
import { ArtifactsProvider } from "./views/ArtifactsProvider";
import { GuaranteesProvider } from "./views/GuaranteesProvider";
import { EventsProvider } from "./views/EventsProvider";

const LANGUAGE = "omar";

/** What the extension hands back, so a test can watch the session it runs. */
export type OmarApi = {
  session: RuntimeSession;
  launcher: RuntimeLauncher;
  selection: Selection;
  panel: MissionControlPanel;
  artifacts: ArtifactsProvider;
  guarantees: GuaranteesProvider;
  chat: ChatView;
  /** The per-file diagram panels. */
  diagrams?: DiagramPanels;
};

export function activate(context: vscode.ExtensionContext): OmarApi {
  const diagnostics = vscode.languages.createDiagnosticCollection(LANGUAGE);
  // The daemon, once Mission Control has one, compiles for the editor too;
  // set below, read whenever a program is checked.
  let daemonUrl: () => string | null = () => null;
  const panels = new DiagramPanels(context, () => daemonUrl());
  context.subscriptions.push(diagnostics, panels);

  context.subscriptions.push(
    vscode.commands.registerCommand("omar.compile", async () => {
      const editor = omarEditor();
      if (!editor) return;
      const result = await check(editor.document, diagnostics, daemonUrl());
      if (!result.ok) {
        vscode.window.showErrorMessage(
          `${result.problems.length} problem${result.problems.length > 1 ? "s" : ""} in ${basename(editor.document)}.`,
        );
        return;
      }
      // Written beside the source, which is where someone looking for it will
      // look: the compiled picture, as the daemon or the compiler drew it.
      const target = editor.document.uri.with({
        path: editor.document.uri.path.replace(/\.omar$/, ".json"),
      });
      await vscode.workspace.fs.writeFile(
        target,
        Buffer.from(`${JSON.stringify(result.snapshot, null, 2)}\n`),
      );
      vscode.window.showInformationMessage(
        `Compiled ${result.snapshot.team} (by ${result.by}) to ${basename({ uri: target } as vscode.TextDocument)}.`,
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
        await check(document, diagnostics, daemonUrl());
      }
      await panels.refresh(document);
    }),

    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)),
  );

  const api = activateMissionControl(context);
  daemonUrl = () => {
    const { reach, mode, url } = api.session.current;
    return reach === "connected" && mode === "daemon" ? url : null;
  };
  return { ...api, diagrams: panels };
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
  const launcher = new RuntimeLauncher();
  session.launcher = (url, reason) => launcher.start(url, reason);
  session.probe = async () => ({
    cliPath: cliPath(),
    artifactsReadable: (await workspaceFiles.stat(dataDir())) !== null,
  });
  const deployments = new DeploymentsProvider(session);
  const artifacts = new ArtifactsProvider(session);
  const guarantees = new GuaranteesProvider(session, artifacts);
  const summary = new SummaryProvider(session, artifacts, guarantees);
  const teams = new TeamsProvider(session);
  const events = new EventsProvider(session);
  const selection = new Selection();
  const inspector = new InspectorProvider(session, selection, guarantees);
  const inspectorView = vscode.window.createTreeView("omar.inspector", { treeDataProvider: inspector });
  const panel = new MissionControlPanel(context.extensionUri, session, selection);
  const chat = new ChatView(context.extensionUri, session, selection, guarantees, artifacts, launcher);
  context.subscriptions.push(
    launcher,
    vscode.commands.registerCommand("omar.startRuntime", async () => {
      const url = session.current.url ?? configuredUrl();
      if (session.current.reach === "connected") {
        vscode.window.showInformationMessage(`A runtime is already answering at ${url}.`);
        return;
      }
      if (await launcher.start(url, "asked to")) await session.connect(url);
    }),
    vscode.commands.registerCommand("omar.stopRuntime", () => {
      if (!launcher.running) {
        vscode.window.showInformationMessage("The extension did not start the running runtime, so it will not stop it.");
        return;
      }
      launcher.stop();
      void session.refresh();
    }),
    vscode.commands.registerCommand("omar.showRuntimeLog", () => launcher.showLog()),
    chat,
    vscode.window.registerWebviewViewProvider(ChatView.viewType, chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("omar.openAssistant", () => vscode.commands.executeCommand("omar.chat.focus")),
    vscode.commands.registerCommand("omar.previewProposal", (sequence: number) => {
      const message = chat.proposalAt(sequence);
      if (!message?.design) return;
      if (selection.proposal?.sequence === sequence) {
        selection.setProposal(null);
        return;
      }
      selection.setProposal({ sequence, team: message.design.preview.team, snapshot: message.design.preview });
      panel.show();
    }),
    vscode.commands.registerCommand("omar.clearProposalPreview", () => selection.setProposal(null)),
    vscode.commands.registerCommand("omar.openProposalProgram", async (sequence: number) => {
      const message = chat.proposalAt(sequence);
      if (!message?.design) return;
      const document = await vscode.workspace.openTextDocument({ language: "omar", content: message.design.program });
      await vscode.window.showTextDocument(document, { preview: false });
    }),
    vscode.commands.registerCommand("omar.deployProposal", async (sequence: number) => {
      const message = chat.proposalAt(sequence);
      if (!message?.design) return;
      if (await deployProposal(session, message.design)) selection.setProposal(null);
    }),
    artifacts,
    guarantees,
    events,
    vscode.window.registerTreeDataProvider("omar.artifacts", artifacts),
    vscode.window.registerTreeDataProvider("omar.guarantees", guarantees),
    vscode.window.registerTreeDataProvider("omar.events", events),
    vscode.commands.registerCommand("omar.showOnTopology", (ids: string[] | Guarantee) => {
      selection.setHighlight(Array.isArray(ids) ? ids : ids.subjects);
      panel.show();
    }),
    vscode.commands.registerCommand("omar.clearHighlight", () => selection.setHighlight([])),
    vscode.commands.registerCommand("omar.openEvidence", async (guarantee: Guarantee) => {
      for (const evidence of guarantee.evidence) {
        if (evidence.type === "runtime-mechanism") continue;
        await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(evidence.uri));
        return;
      }
      const mechanisms = guarantee.evidence.map((evidence) => (evidence.type === "runtime-mechanism" ? evidence.description : "")).filter(Boolean);
      vscode.window.showInformationMessage(`${guarantee.name}: ${mechanisms.length > 0 ? mechanisms.join("; ") : "nothing establishes this, so there is no evidence to open."}`);
    }),
    vscode.commands.registerCommand("omar.revealArtifacts", async () => {
      const directory = artifacts.current?.directory;
      if (!directory) {
        vscode.window.showInformationMessage("The runtime has not written a directory for this deployment.");
        return;
      }
      await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(directory)).then(undefined, () =>
        vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(directory)),
      );
    }),
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
      void vscode.commands.executeCommand("setContext", "omar.canRun", state.capabilities.run);
      void vscode.commands.executeCommand("setContext", "omar.canStop", state.capabilities.stop && state.live !== null && !isRunFinished(state.live.record.status));
      void vscode.commands.executeCommand("setContext", "omar.readOnly", state.capabilities.readOnly);
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
    vscode.commands.registerCommand("omar.connectDiagram", async (url?: string) => {
      const chosen =
        url ??
        (await vscode.window.showInputBox({
          title: "Follow a diagram server (read only)",
          prompt: "Address printed by omar run --diagram-server",
          value: vscode.workspace.getConfiguration("omar").get<string>("diagramServerUrl", "") || "http://127.0.0.1:7341",
        }));
      if (chosen) await session.connectDiagram(chosen);
    }),
    vscode.commands.registerCommand("omar.runProgram", (uri?: vscode.Uri) =>
      uri ? vscode.workspace.openTextDocument(uri).then((document) => runProgram(session, document)) : runProgram(session),
    ),
    vscode.commands.registerCommand("omar.stopDeployment", () => stopDeployment(session, cliPath())),
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
        ...(state.capabilities.run ? [{ label: "$(play) Run the open program", command: "omar.runProgram" }] : []),
        ...(state.capabilities.stop && state.live && !isRunFinished(state.live.record.status)
          ? [{ label: "$(debug-stop) Stop deployment", command: "omar.stopDeployment" }]
          : []),
        { label: "$(list-selection) Select deployment", command: "omar.selectDeployment" },
        { label: "$(refresh) Refresh", command: "omar.refresh" },
      ];
      const pick = await vscode.window.showQuickPick(choices, {
        title: state.url ? `OMAR · ${state.url}` : "OMAR",
      });
      if (pick) await vscode.commands.executeCommand(pick.command);
    }),

    vscode.workspace.onDidChangeConfiguration((change) => {
      if (!change.affectsConfiguration("omar.runtimeUrl") || session.current.reach === "disconnected") return;
      // The Connect command writes the setting itself; that is not a change.
      if (sameAddress(configuredUrl(), session.current.url)) return;
      void session.connect(configuredUrl());
    }),
  );

  // Connect on activation: the address has a default, and when nothing
  // answers there the session starts a runtime rather than asking.
  void session.connect(configuredUrl());
  return { session, launcher, selection, panel, artifacts, guarantees, chat };
}

function sameAddress(a: string, b: string | null): boolean {
  try {
    return b !== null && normalizeRuntimeUrl(a) === normalizeRuntimeUrl(b);
  } catch {
    return false;
  }
}

function cliPath(): string {
  return vscode.workspace.getConfiguration("omar").get<string>("cliPath", "omar");
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
  daemonUrl: string | null,
): Promise<Compiled> {
  const compilerPath = vscode.workspace
    .getConfiguration("omar")
    .get<string>("compilerPath", "omarc");

  const result = await compileProgram(document.getText(), basename(document), daemonUrl, compilerPath);
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
          diagnostic.source = result.by === "daemon" ? "omar serve" : "omarc";
          return diagnostic;
        }),
  );
  return result;
}

/**
 * The diagram windows, one per program.
 *
 * A panel shows the compiled program the way the daemon's preview would draw
 * it, and follows a run when one is listening at `omar.diagramServerUrl`: the
 * same diagram either way, the running one carrying what is happening on top
 * of what exists.
 */
class DiagramPanels implements vscode.Disposable {
  private readonly panels = new Map<string, DiagramWebview>();
  private readonly streams = new Map<string, AbortController>();
  private readonly shown = new Map<string, DiagramState>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly daemonUrl: () => string | null,
  ) {}

  /** What the panel for a document last showed; for a test. */
  stateOf(document: vscode.Uri): DiagramState | null {
    return this.shown.get(document.toString()) ?? null;
  }

  async show(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    let panel = this.panels.get(key);
    if (!panel) {
      panel = new DiagramWebview(
        this.context.extensionUri,
        "omar.diagram",
        `Topology · ${basename(document)}`,
        () => {},
        () => {
          this.panels.delete(key);
          this.streams.get(key)?.abort();
          this.streams.delete(key);
        },
      );
      this.panels.set(key, panel);
    }
    panel.show(vscode.ViewColumn.Beside, true);
    await this.refresh(document);
  }

  async refresh(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    const panel = this.panels.get(key);
    if (!panel) return;

    const result = await compileProgram(
      document.getText(),
      basename(document),
      this.daemonUrl(),
      vscode.workspace.getConfiguration("omar").get<string>("compilerPath", "omarc"),
    );
    const show = (state: DiagramState) => {
      this.shown.set(key, state);
      panel.post(state);
    };
    if (!result.ok) {
      show({
        snapshot: null, selection: [], highlight: null, team: basename(document), status: "", connection: null,
        detail: null, tag: "", lag: "", empty: `Does not compile:\n${result.problems.map((problem) => problem.message).join("\n")}`,
      });
      return;
    }
    const compiled = result.snapshot;
    show({
      snapshot: compiled, selection: [], highlight: null, team: compiled.team, status: `compiled by ${result.by}`, connection: "compiled",
      detail: null, tag: "", lag: "", empty: null,
    });
    await this.follow(key, panel, compiled.team);
  }

  /**
   * Follow a running topology, if one is listening. When nothing is there the
   * panel keeps the compiled picture, which is the honest thing to show: the
   * program exists, it just is not running.
   */
  private async follow(key: string, panel: DiagramWebview, team: string): Promise<void> {
    this.streams.get(key)?.abort();
    const url = vscode.workspace.getConfiguration("omar").get<string>("diagramServerUrl", "");
    if (!url) return;
    const abort = new AbortController();
    this.streams.set(key, abort);
    try {
      const { source, recordOf, client } = diagramOnlySource(url);
      const snapshot = await client.snapshot(abort.signal);
      if (snapshot.team !== team) {
        // A different program is running. Saying so beats quietly drawing it
        // as if it were the file on screen.
        panel.post({
          snapshot: null, selection: [], highlight: null, team, status: "", connection: null, detail: null, tag: "", lag: "",
          empty: `A different program is running at ${client.url}: ${snapshot.team}.`,
        });
        return;
      }
      void followRun(
        recordOf(snapshot),
        source,
        {
          onChange: (live) =>
            panel.post({
              snapshot: live.snapshot, selection: [], highlight: null, team, status: live.record.status,
              connection: live.connection, detail: live.detail,
              tag: live.snapshot ? formatTag(live.snapshot.current_tag) : "", lag: live.snapshot ? formatNanos(live.snapshot.lag) : "", empty: null,
            }),
        },
        abort.signal,
      );
    } catch {
      // Not running, or not reachable. The compiled picture stands.
    }
  }

  dispose(): void {
    for (const stream of this.streams.values()) stream.abort();
    for (const panel of this.panels.values()) panel.dispose();
  }
}
