import * as vscode from "vscode";

import { ServeClient } from "../client/OmarClient";
import { serveSpec, startServe, waitFor, type ServeHandle } from "./serve";

/**
 * The daemon the extension starts for itself.
 *
 * An operator who opens the OMAR view should not have to open a terminal
 * first. When nothing answers at a loopback address, `omar serve` is started
 * as a child of the extension host, its output kept in an output channel,
 * and the session connects once it answers. A daemon that was already
 * running is left alone; one this extension started is stopped with it.
 */
export class RuntimeLauncher implements vscode.Disposable {
  private readonly log = vscode.window.createOutputChannel("OMAR Runtime");
  private readonly warned = new vscode.EventEmitter<string>();
  /** Lines the daemon printed about its assistant, which the chat view acts on. */
  readonly onDidWarn = this.warned.event;
  /**
   * The last such line from the daemon now running. It is printed while the
   * daemon starts, before anything has connected to it, so it is kept for
   * whoever asks later rather than only announced.
   */
  assistantWarning: string | null = null;
  private handle: ServeHandle | null = null;
  private startedFor: string | null = null;

  /** Whether a daemon this extension started is still running. */
  get running(): boolean {
    return this.handle !== null && this.handle.process.exitCode === null && !this.handle.process.killed;
  }

  get ownsUrl(): string | null {
    return this.running ? this.startedFor : null;
  }

  /**
   * Start a daemon for `url` and wait for it to answer. False when it is not
   * ours to start (not loopback, or turned off), or when it did not come up.
   */
  async start(url: string, reason: string, options: { withAssistant?: boolean } = {}): Promise<boolean> {
    const config = vscode.workspace.getConfiguration("omar");
    if (!config.get<boolean>("autoStartRuntime", true)) return false;
    let args = config.get<string[]>("serveArguments", ["--restart-ea"]);
    // Asked for an assistant: whatever the arguments say, do not leave it out.
    if (options.withAssistant) args = args.filter((argument) => argument !== "--no-ea");
    const spec = serveSpec(url, config.get<string>("cliPath", "omar"), args, config.get<string>("compilerPath", "omarc"));
    if (!spec.address) return false;
    if (this.running) return false;

    this.log.appendLine(`[${new Date().toISOString()}] starting the runtime: ${reason}`);
    this.assistantWarning = null;
    let handle: ServeHandle;
    try {
      handle = startServe(spec, (line) => {
        this.log.appendLine(line);
        if (/executive assistant/i.test(line)) {
          if (/cannot reply or propose designs/.test(line)) this.assistantWarning = line;
          this.warned.fire(line);
        }
      });
    } catch (cause) {
      this.log.appendLine(`could not start: ${cause instanceof Error ? cause.message : String(cause)}`);
      return false;
    }
    this.handle = handle;
    this.startedFor = url;
    // dispose() does not run when the extension host is killed outright, and
    // a daemon left behind would answer the next window as if it were its own.
    process.once("exit", () => handle.process.kill("SIGTERM"));
    const client = new ServeClient(url);
    const up = await Promise.race([
      waitFor(() => client.health(), 20_000),
      handle.exited.then(() => false),
    ]);
    if (!up) {
      this.handle = null;
      const choice = await vscode.window.showWarningMessage(
        "OMAR could not start its runtime. Is `omar` installed and on PATH, or set in omar.cliPath?",
        "Show log",
      );
      if (choice === "Show log") this.log.show(true);
      return false;
    }
    void handle.exited.then((how) => {
      if (this.handle === handle) this.handle = null;
      this.log.appendLine(`[${new Date().toISOString()}] the runtime stopped (${how})`);
    });
    return true;
  }

  stop(): void {
    if (!this.handle) return;
    this.log.appendLine(`[${new Date().toISOString()}] stopping the runtime`);
    this.handle.process.kill("SIGTERM");
    this.handle = null;
  }

  showLog(): void {
    this.log.show(true);
  }

  dispose(): void {
    this.stop();
    this.warned.dispose();
    this.log.dispose();
  }
}
