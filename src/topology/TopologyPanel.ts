import * as vscode from "vscode";

import { compileProgram } from "../compile";
import type { DiagramSnapshot } from "../client/protocol";
import { statusOf } from "../model/deployment";
import { formatNanos, formatTag } from "../model/format";
import type { RuntimeSession } from "../runtime/RuntimeSession";
import type { Selection } from "../views/Inspector";
import { componentName, idOf } from "./components";
import { DiagramWebview, type DiagramState } from "./DiagramWebview";

/**
 * The one topology panel.
 *
 * It draws whichever of three pictures is the one to look at: a proposal
 * the operator is previewing, the live picture of the selected deployment,
 * or the compiled picture of an `.omar` file. A file is drawn as soon as it
 * is shown or becomes the active editor, and redrawn on save; when a
 * deployment goes live the panel switches to it on its own, and the header
 * offers the file again. Clicks come back as component names and go to the
 * inspector as ids.
 */

type FilePicture = {
  uri: vscode.Uri;
  name: string;
  snapshot: DiagramSnapshot | null;
  problems: string[];
  by: "daemon" | "omarc" | null;
};

export class TopologyPanel implements vscode.Disposable {
  private readonly view: DiagramWebview;
  private readonly subscriptions: vscode.Disposable[] = [];
  private file: FilePicture | null = null;
  /** `auto` follows the deployment when it has a picture; `file` holds the file. */
  private mode: "auto" | "file" = "auto";
  private lastLiveRun: string | null = null;
  private compiling = 0;

  constructor(
    extensionUri: vscode.Uri,
    private readonly session: RuntimeSession,
    private readonly selection: Selection,
    private readonly daemonUrl: () => string | null,
  ) {
    this.view = new DiagramWebview(
      extensionUri,
      "omar.topology",
      "Topology",
      (component) => {
        const snapshot = this.state().snapshot;
        const id = snapshot ? idOf(snapshot, component) : null;
        // A click on the selected thing clears the selection; that is what a
        // toggle is for.
        selection.set(id !== null && id === selection.current ? null : id);
      },
      undefined,
      (which) => {
        this.mode = which === "file" ? "file" : "auto";
        this.post();
      },
    );
    this.subscriptions.push(
      session.onDidChange((state) => {
        // A deployment that has just gone live takes the panel, whatever it
        // was showing: that is what the operator started it to see.
        const liveRun = state.live?.snapshot && state.live.connection === "live" ? state.live.record.run_id : null;
        if (liveRun && liveRun !== this.lastLiveRun) this.mode = "auto";
        this.lastLiveRun = liveRun ?? this.lastLiveRun;
        this.post();
      }),
      selection.onDidChange(() => this.post()),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.languageId === "omar" && this.view.open) void this.showFile(editor.document, false);
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.file && document.uri.toString() === this.file.uri.toString()) void this.showFile(document, false);
      }),
    );
    this.post();
  }

  /** Open the panel on whatever there is to show. */
  show(): void {
    this.view.show(vscode.ViewColumn.Beside, true);
    const editor = vscode.window.activeTextEditor;
    if (!this.file && editor?.document.languageId === "omar") void this.showFile(editor.document, false);
    this.post();
  }

  /** Draw a file's compiled picture, and look at it. */
  async showFile(document: vscode.TextDocument, reveal: boolean): Promise<void> {
    if (reveal) {
      this.view.show(vscode.ViewColumn.Beside, true);
      this.mode = "file";
    }
    const name = document.uri.path.split("/").pop() ?? "program.omar";
    const generation = ++this.compiling;
    const result = await compileProgram(
      document.getText(),
      name,
      this.daemonUrl(),
      vscode.workspace.getConfiguration("omar").get<string>("compilerPath", "omarc"),
    );
    if (generation !== this.compiling) return;
    this.file = result.ok
      ? { uri: document.uri, name, snapshot: result.snapshot, problems: [], by: result.by }
      : { uri: document.uri, name, snapshot: null, problems: result.problems.map((problem) => problem.message), by: result.by };
    this.post();
  }

  get drawn(): { nodes: number; error: string | null } | null {
    return this.view.drawn;
  }

  get onDidDraw(): vscode.Event<{ nodes: number; error: string | null }> {
    return this.view.onDidDraw;
  }

  private post(): void {
    this.view.post(this.state());
  }

  /** What the panel shows, computed afresh each time. */
  state(): DiagramState {
    const proposal = this.selection.proposal;
    const run = this.session.selectedRun;
    const { live } = this.session.current;
    const livePicture = run && live?.snapshot ? live : null;
    const views = { live: livePicture !== null, file: this.file?.name ?? null };
    const base = { selection: [] as string[], highlight: null as string[] | null, tag: "", lag: "", views };

    if (proposal) {
      // What the assistant proposed, as the daemon compiled it: a picture of
      // a program, with nothing running in it.
      return {
        ...base, showing: "proposal", snapshot: proposal.snapshot, team: proposal.team, status: "proposal",
        connection: "proposal", detail: "Proposed by the assistant; nothing is running. Deploy it from the Assistant view.", empty: null,
      };
    }
    const showLive = run && (this.mode === "auto" || !this.file) && (livePicture || !this.file);
    if (showLive && run) {
      const snapshot = live?.snapshot ?? null;
      return {
        ...base,
        showing: "live",
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
    if (this.file) {
      return {
        ...base,
        showing: "file",
        snapshot: this.file.snapshot,
        selection: this.selection.current ? [componentName(this.selection.current)] : [],
        team: this.file.snapshot?.team ?? this.file.name,
        status: "",
        connection: "compiled",
        detail: this.file.name,
        empty: this.file.problems.length > 0 ? `Does not compile:\n${this.file.problems.join("\n")}` : null,
      };
    }
    return {
      ...base, showing: "none", snapshot: null, team: "", status: "", connection: null, detail: null,
      empty: "Open an .omar file, or select a deployment, to see a topology.",
    };
  }

  dispose(): void {
    this.view.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
