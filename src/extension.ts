import * as vscode from "vscode";

import { compile } from "./omarc";
import { fromBytecode } from "./diagram";
import { diagramOnlySource } from "./client/diagramOnly";
import { followRun } from "./client/follow";
import { DiagramWebview } from "./topology/DiagramWebview";
import { RuntimeSession } from "./runtime/RuntimeSession";
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
import { runProgram, stopDeployment } from "./commands/operate";
import { dataDir, workspaceFiles } from "./artifacts/files";
import { ArtifactsProvider } from "./views/ArtifactsProvider";
import { GuaranteesProvider } from "./views/GuaranteesProvider";
import { EventsProvider } from "./views/EventsProvider";

const LANGUAGE = "omar";

/** What the extension hands back, so a test can watch the session it runs. */
export type OmarApi = {
  session: RuntimeSession;
  selection: Selection;
  panel: MissionControlPanel;
  artifacts: ArtifactsProvider;
  guarantees: GuaranteesProvider;
};

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
  context.subscriptions.push(
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
    vscode.commands.registerCommand("omar.stopDeployment", () => stopDeployment(session, cliPath(), false)),
    vscode.commands.registerCommand("omar.killDeployment", () => stopDeployment(session, cliPath(), true)),
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

  // Connect on activation: the address has a default, and an unreachable
  // daemon is shown as exactly that rather than as a prompt.
  void session.connect(configuredUrl());
  return { session, selection, panel, artifacts, guarantees };
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
 * A panel shows the compiled program the way the daemon's preview would draw
 * it, and follows a run when one is listening at `omar.diagramServerUrl`: the
 * same diagram either way, the running one carrying what is happening on top
 * of what exists.
 */
class DiagramPanels implements vscode.Disposable {
  private readonly panels = new Map<string, DiagramWebview>();
  private readonly streams = new Map<string, AbortController>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly diagnostics: vscode.DiagnosticCollection,
  ) {}

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

    const result = await compile(
      vscode.workspace.getConfiguration("omar").get<string>("compilerPath", "omarc"),
      document.getText(),
      basename(document),
    );
    if (!result.ok) {
      panel.post({
        snapshot: null, selection: [], highlight: null, team: basename(document), status: "", connection: null,
        detail: null, tag: "", lag: "", empty: `Does not compile:\n${result.problems.map((problem) => problem.message).join("\n")}`,
      });
      return;
    }
    const compiled = fromBytecode(result.bytecode);
    panel.post({
      snapshot: compiled, selection: [], highlight: null, team: compiled.team, status: "", connection: "compiled",
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
