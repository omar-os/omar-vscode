import * as vscode from "vscode";

import { followRun, type LiveRun } from "../client/follow";
import { DiagramClient, ServeClient, diagramUrlFor, RuntimeRefused } from "../client/OmarClient";
import { isRunFinished, type RunRecord } from "../client/protocol";
import { diagramOnlySource } from "../client/diagramOnly";
import { discover, NONE, type Capabilities } from "./capabilities";

/**
 * The extension's one connection to a runtime.
 *
 * Holds the daemon's list of runs and follows the selected one; everything a
 * view shows comes from here, and here it comes from the runtime. The daemon
 * has no stream for its run list, so the list is polled — a loopback call
 * every couple of seconds is cheap, and it doubles as the liveness check.
 */

export type Reach = "disconnected" | "connecting" | "starting" | "connected" | "unreachable";

export type SessionState = {
  url: string | null;
  reach: Reach;
  /** What went wrong, when `reach` is unreachable. */
  problem: string | null;
  runs: RunRecord[];
  selected: string | null;
  live: LiveRun | null;
  /**
   * `daemon`: connected to `omar serve`, which admits and lists runs.
   * `diagram`: connected to one run's diagram server alone, as `omar run
   * --diagram-server` exposes it. That surface can only be read, so the
   * session is read-only by construction, not by a switch.
   */
  mode: "daemon" | "diagram";
  capabilities: Capabilities;
};

const POLL_MS = 2000;

export class RuntimeSession implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<SessionState>();
  readonly onDidChange = this.changed.event;

  private state: SessionState = {
    url: null,
    reach: "disconnected",
    problem: null,
    runs: [],
    selected: null,
    live: null,
    mode: "daemon",
    capabilities: NONE,
  };
  private serve: ServeClient | null = null;
  /** How capabilities are worked out; the extension supplies the CLI path and the data directory check. */
  probe: (() => Promise<{ cliPath: string; artifactsReadable: boolean }>) | null = null;
  /**
   * How a daemon is started when none answers; resolves true once one does.
   * Tried on connect, and again from the poll no more than once a half
   * minute, so a daemon that will not start is not started in a loop.
   */
  launcher: ((url: string, reason: string) => Promise<boolean>) | null = null;
  private lastLaunch = 0;
  private poll: NodeJS.Timeout | null = null;
  private following: AbortController | null = null;

  get current(): SessionState {
    return this.state;
  }

  get selectedRun(): RunRecord | null {
    return this.state.runs.find((run) => run.run_id === this.state.selected) ?? null;
  }

  async connect(url: string): Promise<void> {
    this.disconnect();
    let client: ServeClient;
    try {
      client = new ServeClient(url);
    } catch (cause) {
      this.set({ url, reach: "unreachable", problem: cause instanceof Error ? cause.message : String(cause) });
      return;
    }
    this.serve = client;
    this.set({ url: client.url, reach: "connecting", problem: null, runs: [], selected: null, live: null, mode: "daemon", capabilities: NONE });
    await this.refresh();
    if (this.state.reach === "unreachable" && this.serve === client) await this.launch("nothing answered on connect");
    if (this.serve === client) this.poll = setInterval(() => void this.refresh(), POLL_MS);
  }

  /** Ask the launcher for a daemon, and connect to it if one comes up. */
  private async launch(reason: string): Promise<void> {
    const serve = this.serve;
    if (!this.launcher || !serve || Date.now() - this.lastLaunch < 30_000) return;
    this.lastLaunch = Date.now();
    this.set({ reach: "starting", problem: null });
    const started = await this.launcher(serve.url, reason);
    if (this.serve !== serve) return;
    if (started) {
      await this.refresh();
    } else {
      this.set({ reach: "unreachable", problem: this.state.problem ?? "The runtime could not be started." });
    }
  }

  /**
   * Follow one diagram server with no daemon behind it.
   *
   * There is no run list and no record, so a record is read off the snapshot:
   * the team it names, and its status. Nothing here can change the run, and
   * the capabilities say so.
   */
  async connectDiagram(url: string): Promise<void> {
    this.disconnect();
    let only: ReturnType<typeof diagramOnlySource>;
    try {
      only = diagramOnlySource(url);
    } catch (cause) {
      this.set({ url, reach: "unreachable", problem: describe(cause) });
      return;
    }
    this.set({ url: only.client.url, reach: "connecting", problem: null, runs: [], selected: null, live: null, mode: "diagram", capabilities: NONE });
    let record: RunRecord;
    try {
      record = only.recordOf(await only.client.snapshot());
    } catch (cause) {
      this.set({ reach: "unreachable", problem: describe(cause) });
      return;
    }
    const capabilities = await discover({ protocolVersion: 1, daemon: false, cliPath: "", artifactsReadable: false });
    this.set({ reach: "connected", runs: [record], selected: record.run_id, capabilities });
    const abort = new AbortController();
    this.following = abort;
    void followRun(
      record,
      only.source,
      {
        onChange: (live) => {
          if (abort.signal.aborted) return;
          this.set({ live, runs: [live.record] });
        },
      },
      abort.signal,
    );
  }

  disconnect(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.following?.abort();
    this.following = null;
    this.serve = null;
    this.set({ reach: "disconnected", problem: null, runs: [], selected: null, live: null, capabilities: NONE });
  }

  /** Ask the daemon again. Safe to call at any time; a poll in flight is not doubled. */
  private refreshing = false;
  private probedFor: ServeClient | null = null;
  async refresh(): Promise<void> {
    const serve = this.serve;
    if (!serve || this.refreshing) return;
    this.refreshing = true;
    try {
      const health = await serve.health();
      const runs = await serve.listRuns();
      runs.sort((a, b) => b.started_at - a.started_at || b.run_id.localeCompare(a.run_id));
      // First answer from this connection: keyed on the client rather than on
      // the state, because two connects can overlap — a settings change while
      // a command is connecting — and the state then says "connected" before
      // this connection has found anything out.
      const fresh = this.probedFor !== serve;
      this.probedFor = serve;
      this.set({ reach: "connected", problem: null, runs });
      this.autoSelect(runs, fresh);
      if (fresh) {
        // After the picture is on its way: the CLI does not come and go, and a
        // reader should not wait on it.
        const probed = this.probe ? await this.probe() : { cliPath: "", artifactsReadable: false };
        if (this.serve !== serve) return;
        this.set({ capabilities: await discover({ protocolVersion: health.protocol_version, daemon: true, ...probed }) });
      }
    } catch (cause) {
      // The daemon is gone or is not OMAR; either way the list it gave is
      // history now, and the follower will notice on its own.
      const problem = cause instanceof RuntimeRefused ? cause.message : describe(cause);
      const wasReachable = this.state.reach === "connected";
      this.set({ reach: "unreachable", problem, capabilities: NONE });
      // A daemon that went away, or one that never came: try to start one,
      // from the poll rather than here, so this refresh returns.
      if (this.poll && !(cause instanceof RuntimeRefused)) {
        setTimeout(() => void this.launch(wasReachable ? "the runtime stopped answering" : "nothing is answering"), 0);
      }
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Pick a run when there is nothing better to show.
   *
   * On connecting, the newest run; afterwards, a run that has just started
   * while the selected one is over — an operator who starts a run wants to
   * watch that one, not the last. A live selection is never taken away.
   */
  private autoSelect(runs: RunRecord[], fresh: boolean): void {
    const selected = this.selectedRun;
    const newest = runs[0];
    if (!newest) return;
    if (!selected || fresh) {
      this.select(newest.run_id);
      return;
    }
    if (isRunFinished(selected.status) && !isRunFinished(newest.status) && newest.run_id !== selected.run_id) {
      this.select(newest.run_id);
    }
  }

  /**
   * A run the daemon just handed back, selected without waiting for the next
   * poll to list it. The record came from the daemon, so it is as good as the
   * list's; the list catches up on its own.
   */
  adopt(record: RunRecord): void {
    if (!this.state.runs.some((run) => run.run_id === record.run_id)) {
      this.set({ runs: [record, ...this.state.runs] });
    }
    this.select(record.run_id);
  }

  select(runId: string | null): void {
    this.following?.abort();
    this.following = null;
    const record = this.state.runs.find((run) => run.run_id === runId) ?? null;
    if (!record || !this.serve) {
      this.set({ selected: null, live: null });
      return;
    }
    this.set({ selected: record.run_id, live: null });
    const diagramUrl = diagramUrlFor(record);
    const serve = this.serve;
    const abort = new AbortController();
    this.following = abort;
    const source = {
      record: (signal: AbortSignal) => serve.getRun(record.run_id, signal),
      snapshot: (signal: AbortSignal) => {
        if (!diagramUrl) return Promise.reject(new Error("The run has no diagram address."));
        return new DiagramClient(diagramUrl).snapshot(signal);
      },
      events: (signal: AbortSignal) => {
        if (!diagramUrl) throw new Error("The run has no diagram address.");
        return new DiagramClient(diagramUrl).events(signal);
      },
    };
    void followRun(
      record,
      source,
      {
        onChange: (live) => {
          if (abort.signal.aborted) return;
          // The follower's record is fresher than the list's for this run.
          const runs = this.state.runs.map((run) => (run.run_id === live.record.run_id ? live.record : run));
          this.set({ live, runs });
        },
      },
      abort.signal,
    );
  }

  private set(change: Partial<SessionState>): void {
    this.state = { ...this.state, ...change };
    this.changed.fire(this.state);
  }

  dispose(): void {
    this.disconnect();
    this.changed.dispose();
  }
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
