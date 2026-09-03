import * as vscode from "vscode";

import { dataDir, workspaceFiles } from "../artifacts/files";
import { listArtifacts, type Artifact, type ArtifactGroup, type ArtifactListing } from "../artifacts/store";
import { formatClock } from "../model/format";
import type { RuntimeSession, SessionState } from "../runtime/RuntimeSession";

/**
 * When to list again: a different run, a change of status, or the snapshot
 * arriving — the producers of logs are named from the snapshot's agents, so
 * a listing made before it has none.
 */
function keyOf(state: SessionState): string | null {
  if (!state.selected) return null;
  return `${state.selected}:${state.live?.record.status ?? ""}:${state.live?.snapshot ? "picture" : "blank"}`;
}

export type ArtifactNode =
  | { kind: "caveat"; text: string }
  | { kind: "group"; group: ArtifactGroup }
  | { kind: "artifact"; artifact: Artifact };

const ICONS: Record<Artifact["kind"], string> = {
  program: "file-code",
  outputs: "output",
  state: "database",
  record: "history",
  log: "terminal",
  instructions: "book",
};

/**
 * What the selected run wrote, opened with VS Code's own editors.
 *
 * Re-listed when the run changes and when the directory does; while a run is
 * live, also every few seconds, because the runtime writes its files at the
 * end and a watcher on a directory that does not exist yet sees nothing.
 */
export class ArtifactsProvider implements vscode.TreeDataProvider<ArtifactNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private listing: ArtifactListing | null = null;
  private listedFor: string | null = null;
  private generation = 0;
  private watcher: vscode.FileSystemWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly session: RuntimeSession) {
    this.subscriptions.push(
      session.onDidChange((state) => {
        if (keyOf(state) !== this.listedFor) void this.relist();
      }),
    );
    this.timer = setInterval(() => {
      const run = this.session.selectedRun;
      if (run && !run.finished_at) void this.relist();
    }, 3000);
  }

  async relist(): Promise<void> {
    const run = this.session.selectedRun;
    const state = this.session.current;
    this.listedFor = keyOf(state);
    if (!run) {
      this.listing = null;
      this.watch(null);
      this.changed.fire();
      return;
    }
    // Listings overlap — one from the record, one from the snapshot arriving
    // a moment later — and the disk answers in no fixed order. Only the latest
    // asked for may land, or a listing made before the snapshot could
    // overwrite one made after it and leave every log without its agent.
    const generation = ++this.generation;
    const listing = await listArtifacts(workspaceFiles, dataDir(), run, state.live?.snapshot ?? null);
    if (generation !== this.generation || this.session.selectedRun?.run_id !== run.run_id) return;
    // Listed every few seconds while a run is live; only a listing that
    // differs is worth telling anyone about, or every view reading this
    // redraws on the clock.
    const same = this.listing !== null && JSON.stringify(this.listing) === JSON.stringify(listing);
    this.listing = listing;
    this.watch(listing.directory);
    if (!same) this.changed.fire();
  }

  private watch(directory: string | null): void {
    if (this.watcher && this.watcher.ignoreCreateEvents === false && this.watchedDirectory === directory) return;
    this.watcher?.dispose();
    this.watcher = null;
    this.watchedDirectory = directory;
    if (!directory) return;
    const pattern = new vscode.RelativePattern(vscode.Uri.file(directory), "**/*");
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const relist = () => void this.relist();
    this.watcher.onDidCreate(relist);
    this.watcher.onDidChange(relist);
    this.watcher.onDidDelete(relist);
  }
  private watchedDirectory: string | null = null;

  getTreeItem(node: ArtifactNode): vscode.TreeItem {
    switch (node.kind) {
      case "caveat": {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("charts.yellow"));
        item.tooltip = node.text;
        return item;
      }
      case "group": {
        const item = new vscode.TreeItem(node.group.label, vscode.TreeItemCollapsibleState.Expanded);
        item.description = String(node.group.artifacts.length);
        return item;
      }
      case "artifact": {
        const { artifact } = node;
        const uri = vscode.Uri.file(artifact.path);
        const item = new vscode.TreeItem(artifact.name, vscode.TreeItemCollapsibleState.None);
        item.resourceUri = uri;
        item.iconPath = new vscode.ThemeIcon(ICONS[artifact.kind]);
        item.description = artifact.modified ? formatClock(artifact.modified) : undefined;
        item.tooltip = new vscode.MarkdownString(
          [
            `\`${artifact.path}\``,
            artifact.producer ? `Produced by ${artifact.producer.replace(/^agent::/, "")}` : "Written by the runtime",
            artifact.modified ? `Modified ${formatClock(artifact.modified)}` : "",
            artifact.size !== null ? `${artifact.size} bytes` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
        item.contextValue = `artifact.${artifact.kind}`;
        item.command = { command: "vscode.open", title: "Open", arguments: [uri] };
        return item;
      }
    }
  }

  getChildren(node?: ArtifactNode): ArtifactNode[] {
    if (!this.listing) return [];
    if (!node) {
      return [
        ...(this.listing.caveat ? [{ kind: "caveat" as const, text: this.listing.caveat }] : []),
        ...this.listing.groups.map((group) => ({ kind: "group" as const, group })),
      ];
    }
    if (node.kind === "group") return node.group.artifacts.map((artifact) => ({ kind: "artifact", artifact }));
    return [];
  }

  /** For a test, and for the reveal command. */
  get current(): ArtifactListing | null {
    return this.listing;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.watcher?.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changed.dispose();
  }
}
