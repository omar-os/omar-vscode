/** The API a VS Code webview page is handed by the host. */
declare function acquireVsCodeApi<State = unknown>(): {
  postMessage(message: unknown): void;
  getState(): State | undefined;
  setState(state: State): void;
};
