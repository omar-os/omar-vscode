import * as vscode from "vscode";

import { followRun, type LiveRun } from "../client/follow";
import { DiagramClient, ServeClient, diagramUrlFor, RuntimeRefused } from "../client/OmarClient";
import { isRunFinished, type RunRecord } from "../client/protocol";

/**
 * The extension's one connection to a runtime.
 *
 * Holds the daemon's list of runs and follows the selected one; everything a
 * view shows comes from here, and here it comes from the runtime. The daemon
 * has no stream for its run list, so the list is polled — a loopback call
 * every couple of seconds is cheap, and it doubles as the liveness check.
 */

export type Reach = "disconnected" | "connecting" | "connected" | "unreachable";

export type SessionState = {
  url: string | null;
  reach: Reach;
  /** What went wrong, when `reach` is unreachable. */
  problem: string | null;
  runs: RunRecord[];
  selected: string | null;
  live: LiveRun | null;
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
  };
  private serve: ServeClient | null = null;
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
    this.set({ url: client.url, reach: "connecting", problem: null, runs: [], selected: null, live: null });
    await this.refresh();
    this.poll = setInterval(() => void this.refresh(), POLL_MS);
  }

  disconnect(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.following?.abort();
    this.following = null;
    this.serve = null;
    this.set({ reach: "disconnected", problem: null, runs: [], selected: null, live: null });
  }

  /** Ask the daemon again. Safe to call at any time; a poll in flight is not doubled. */
  private refreshing = false;
  async refresh(): Promise<void> {
    const serve = this.serve;
    if (!serve || this.refreshing) return;
    this.refreshing = true;
    try {
      await serve.health();
      const runs = await serve.listRuns();
      runs.sort((a, b) => b.started_at - a.started_at || b.run_id.localeCompare(a.run_id));
      const wasReachable = this.state.reach === "connected";
      this.set({ reach: "connected", problem: null, runs });
      this.autoSelect(runs, !wasReachable);
    } catch (cause) {
      // The daemon is gone or is not OMAR; either way the list it gave is
      // history now, and the follower will notice on its own.
      const problem = cause instanceof RuntimeRefused ? cause.message : describe(cause);
      this.set({ reach: "unreachable", problem });
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
