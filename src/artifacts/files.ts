import { homedir } from "node:os";

import * as vscode from "vscode";

import type { Files } from "./store";

/**
 * The disk as VS Code sees it, which under Remote SSH is the remote disk.
 * A missing file is null rather than an error: the listing asks about files
 * that may not have been written yet.
 */
export const workspaceFiles: Files = {
  async readDirectory(path) {
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path));
      return entries
        .filter(([, type]) => type === vscode.FileType.File || type === vscode.FileType.Directory)
        .map(([name, type]) => [name, type === vscode.FileType.File ? "file" : "directory"]);
    } catch {
      return [];
    }
  },
  async stat(path) {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(path));
      return { mtime: Math.floor(stat.mtime / 1000), size: stat.size };
    } catch {
      return null;
    }
  },
  async readFile(path) {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(path)));
    } catch {
      return null;
    }
  },
};

/** `omar.dataDir`, with `~` meaning the extension host's home. */
export function dataDir(): string {
  const configured = vscode.workspace.getConfiguration("omar").get<string>("dataDir", "~/.omar");
  return configured.replace(/^~(?=$|\/)/, homedir());
}
