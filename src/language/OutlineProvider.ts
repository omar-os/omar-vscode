import * as vscode from "vscode";

import { symbolsOf, type Symbol } from "./symbols";

/** The Outline view's contents for an `.omar` file. */
export class OutlineProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    return symbolsOf(document.getText()).map((symbol) => toDocumentSymbol(symbol, document));
  }
}

const KINDS: Record<string, vscode.SymbolKind> = {
  team: vscode.SymbolKind.Class,
  main: vscode.SymbolKind.Module,
  input: vscode.SymbolKind.Field,
  output: vscode.SymbolKind.Field,
  action: vscode.SymbolKind.Event,
  timer: vscode.SymbolKind.Event,
  instance: vscode.SymbolKind.Object,
  prompt: vscode.SymbolKind.Function,
};

function toDocumentSymbol(symbol: Symbol, document: vscode.TextDocument): vscode.DocumentSymbol {
  const full = new vscode.Range(symbol.line, 0, symbol.end, document.lineAt(Math.min(symbol.end, document.lineCount - 1)).text.length);
  const name = new vscode.Range(symbol.line, symbol.from, symbol.line, symbol.to);
  const result = new vscode.DocumentSymbol(symbol.name, symbol.detail, KINDS[symbol.kind] ?? vscode.SymbolKind.Variable, full, name);
  result.children = symbol.children.map((child) => toDocumentSymbol(child, document));
  return result;
}
