/** The API a VS Code webview page is handed by the host. */
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};
