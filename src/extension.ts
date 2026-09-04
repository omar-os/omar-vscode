import * as vscode from "vscode";

import { compileProgram, type Compiled } from "./compile";

import { RuntimeSession } from "./runtime/RuntimeSession";
import { RuntimeLauncher } from "./runtime/RuntimeLauncher";
import { isRunFinished } from "./client/protocol";
import { normalizeRuntimeUrl } from "./client/OmarClient";
import { SummaryProvider } from "./views/SummaryProvider";
import { StatusBar } from "./views/StatusBar";
import { Selection } from "./views/Inspector";
import { TopologyPanel } from "./topology/TopologyPanel";
import { OutlineProvider } from "./language/OutlineProvider";
import type { Guarantee } from "./model/guarantees";
import { deployProposal, runProgram, stopDeployment } from "./commands/operate";
import { ChatView } from "./chat/ChatView";
import { Terminals } from "./Terminals";
import { dataDir, workspaceFiles } from "./artifacts/files";
import { ArtifactsProvider } from "./views/ArtifactsProvider";
import { GuaranteesProvider } from "./views/GuaranteesProvider";

const LANGUAGE = "omar";

/** What the extension hands back, so a test can watch the session it runs. */
export type OmarApi = {
  session: RuntimeSession;
  launcher: RuntimeLauncher;
  selection: Selection;
  panel: TopologyPanel;
  artifacts: ArtifactsProvider;
  guarantees: GuaranteesProvider;
  chat: ChatView;
  terminals: Terminals;
};

export function activate(context: vscode.ExtensionContext): OmarApi {
  const diagnostics = vscode.languages.createDiagnosticCollection(LANGUAGE);
  const api = activateMissionControl(context, () => daemonUrl());
  // The daemon, once Mission Control has one, compiles for the editor too;
  // set below, read whenever a program is checked.
  let daemonUrl: () => string | null = () => null;
  context.subscriptions.push(
    diagnostics,
    vscode.languages.registerDocumentSymbolProvider({ language: LANGUAGE }, new OutlineProvider()),
  );

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
      if (editor) await api.panel.showFile(editor.document, true);
    }),

    // Compiling on every keystroke would be a compiler per keystroke; a save
    // is when a program is worth checking. The topology panel redraws itself.
    vscode.workspace.onDidSaveTextDocument(async (document) => {
      if (document.languageId !== LANGUAGE) return;
      if (vscode.workspace.getConfiguration("omar").get<boolean>("compileOnSave", true)) {
        await check(document, diagnostics, daemonUrl());
      }
    }),

    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)),
  );

  daemonUrl = () => {
    const { reach, mode, url } = api.session.current;
    return reach === "connected" && mode === "daemon" ? url : null;
  };
  return api;
}

export function deactivate(): void {}

/**
 * Mission Control: the runtime's deployments, read through one session.
 *
 * The views are thin. Each asks the session for what it holds and redraws
 * when told; none keeps state of its own, so none can disagree with another.
 */
function activateMissionControl(context: vscode.ExtensionContext, daemonUrl: () => string | null): OmarApi {
  const session = new RuntimeSession();
  const launcher = new RuntimeLauncher();
  session.launcher = (url, reason) => launcher.start(url, reason);
  session.probe = async () => ({
    cliPath: cliPath(),
    artifactsReadable: (await workspaceFiles.stat(dataDir())) !== null,
  });
  // Artifacts and guarantees are read here for the summary, the topology and
  // the assistant; the views that listed them are out of the sidebar for now.
  const artifacts = new ArtifactsProvider(session);
  const guarantees = new GuaranteesProvider(session, artifacts);
  const summary = new SummaryProvider(session, artifacts, guarantees);
  const selection = new Selection();
  const terminals = new Terminals();
  const panel = new TopologyPanel(context.extensionUri, session, selection, daemonUrl, (agent) => {
    void terminals.attachAgent(agent, artifacts.current?.directory ?? null);
  });
  const chat = new ChatView(context.extensionUri, session, selection, guarantees, artifacts, launcher, terminals);
  context.subscriptions.push(
    launcher,
    terminals,
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
    vscode.commands.registerCommand("omar.installRuntime", () => launcher.install()),
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
    summary,
    selection,
    panel,
    new StatusBar(session),
    vscode.window.registerTreeDataProvider("omar.summary", summary),
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
      void vscode.commands.executeCommand("setContext", "omar.inspecting", selection.current !== null);
    }),
    vscode.commands.registerCommand("omar.openTopology", () => panel.show()),
    // The old name, for anyone who bound it.
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
          value: "http://127.0.0.1:7341",
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
        { label: "$(type-hierarchy) Open Topology", command: "omar.openTopology" },
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
  return { session, launcher, selection, panel, artifacts, guarantees, chat, terminals };
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
