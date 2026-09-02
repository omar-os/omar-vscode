import {
  applyDiagramEvent,
  isRunFinished,
  type DiagramEvent,
  type DiagramSnapshot,
  type RunRecord,
} from "./protocol";

/**
 * Following one run: the live picture, and whether it is live.
 *
 * `connection` is the part a reader must not miss. `live` means the events
 * are arriving; `stale` means they stopped and what is shown is what was last
 * known; `final` means the run is over and the picture is its last state.
 * Cached state is never passed off as live: the moment the stream breaks the
 * connection says so, and it says `live` again only once a fresh snapshot has
 * been fetched and the stream re-opened.
 */
export type Connection = "connecting" | "live" | "stale" | "final";

export type LiveRun = {
  record: RunRecord;
  snapshot: DiagramSnapshot | null;
  connection: Connection;
  /** The last sequence folded in; events at or below it are already shown. */
  sequence: number;
  /** Why the connection is what it is, for a reader. */
  detail: string | null;
};

/** How a follower reaches the runtime; the client in practice, a fake in tests. */
export type RunSource = {
  record(signal: AbortSignal): Promise<RunRecord>;
  snapshot(signal: AbortSignal): Promise<DiagramSnapshot>;
  events(signal: AbortSignal): AsyncIterable<DiagramEvent>;
};

export type FollowOptions = {
  /** Called on every change, with the whole state. */
  onChange: (state: LiveRun) => void;
  /** Milliseconds between reconnection attempts. */
  retryMs?: number;
  /** Give up on reconnecting after this many attempts in a row; 0 keeps trying. */
  maxRetries?: number;
  /** Milliseconds between polls of the record after the run's own end is seen. */
  settleMs?: number;
};

/**
 * Follow a run until it ends or the signal fires.
 *
 * Snapshot first, then the stream: the stream does not replay, so the
 * snapshot's sequence is where the picture starts, and an event at or below it
 * is one the snapshot already includes. A gap above it means something was
 * missed, and the fix is another snapshot rather than a guess. When the
 * stream breaks, the daemon is asked whether the run is over; a finished run
 * is final, an unfinished one is stale until the stream is back.
 */
export async function followRun(
  record: RunRecord,
  source: RunSource,
  options: FollowOptions,
  signal: AbortSignal,
): Promise<LiveRun> {
  const retryMs = options.retryMs ?? 1000;
  const maxRetries = options.maxRetries ?? 0;
  const settleMs = options.settleMs ?? 300;
  let state: LiveRun = { record, snapshot: null, connection: "connecting", sequence: 0, detail: null };
  const emit = (change: Partial<LiveRun>) => {
    state = { ...state, ...change };
    options.onChange(state);
  };

  if (isRunFinished(record.status)) {
    // Nothing to follow; the record is the whole story. The diagram server is
    // gone, so no snapshot, and the reader is told why.
    emit({ connection: "final", detail: `Run ${record.status}.` });
    return state;
  }

  let failures = 0;
  while (!signal.aborted) {
    try {
      const snapshot = await source.snapshot(signal);
      emit({ snapshot, sequence: snapshot.sequence, connection: "connecting", detail: null });
      failures = 0;
      for await (const event of source.events(signal)) {
        if (event.sequence <= state.sequence) continue;
        if (event.sequence > state.sequence + 1) {
          // A gap. The snapshot is authoritative and carries its own sequence,
          // which is at least this event's; if the event is newer than the
          // snapshot it will show up in the next one, not be lost.
          const fresh = await source.snapshot(signal);
          emit({ snapshot: fresh, sequence: Math.max(fresh.sequence, state.sequence), connection: "live" });
          if (event.sequence <= state.sequence) continue;
        }
        const snapshotNow = state.snapshot ?? snapshot;
        emit({
          snapshot: applyDiagramEvent(snapshotNow, event),
          sequence: event.sequence,
          connection: "live",
          detail: null,
        });
        if (event.kind === "run_completed" || event.kind === "run_failed") {
          await settle(state, source, emit, signal, { ended: true, settleMs });
          return state;
        }
      }
      if (signal.aborted) break;
      // The stream ended without a terminal event: the server closed it. Ask
      // the daemon what became of the run before deciding what to show.
      await settle(state, source, emit, signal, { ended: false, settleMs });
      return state;
    } catch (cause) {
      if (signal.aborted) break;
      failures += 1;
      const detail = cause instanceof Error ? cause.message : String(cause);
      const outcome = await settleOrStale(source, emit, signal, detail);
      if (outcome === "final") return state;
      if (maxRetries > 0 && failures >= maxRetries) return state;
      await sleep(retryMs, signal);
    }
  }
  return state;
}

/**
 * The run ended, or the stream did: the daemon's record has the last word.
 *
 * The daemon writes a run's final status only after the run's thread returns,
 * which is a moment after its last event, so a record read straight away may
 * still say running. When the stream itself said the run is over, the record
 * is polled for a little while; the event was the runtime's own word, so the
 * run is final either way, and only the record's status may lag.
 */
async function settle(
  state: LiveRun,
  source: RunSource,
  emit: (change: Partial<LiveRun>) => void,
  signal: AbortSignal,
  how: { ended: boolean; settleMs: number },
): Promise<void> {
  const attempts = how.ended ? 10 : 1;
  let record: RunRecord | null = null;
  let problem: string | null = null;
  for (let attempt = 0; attempt < attempts && !signal.aborted; attempt += 1) {
    if (attempt > 0) await sleep(how.settleMs, signal);
    try {
      record = await source.record(signal);
      problem = null;
      if (isRunFinished(record.status)) break;
    } catch (cause) {
      problem = cause instanceof Error ? cause.message : String(cause);
    }
  }
  if (record && isRunFinished(record.status)) {
    emit({ record, connection: "final", detail: `Run ${record.status}.` });
  } else if (how.ended) {
    emit({
      ...(record ? { record } : {}),
      connection: "final",
      detail: `Run ${state.snapshot?.status ?? "ended"}; the daemon has not recorded it yet.`,
    });
  } else if (record) {
    // The stream is gone but the daemon still calls the run live. The stream
    // is what carried the truth, so its absence is stale, not final.
    emit({ record, connection: "stale", detail: "Event stream ended before the run did." });
  } else {
    emit({ connection: "stale", detail: `Could not confirm how the run ended: ${problem}` });
  }
}

async function settleOrStale(
  source: RunSource,
  emit: (change: Partial<LiveRun>) => void,
  signal: AbortSignal,
  detail: string,
): Promise<Connection> {
  let record: RunRecord | null = null;
  try {
    record = await source.record(signal);
  } catch {
    // The daemon is unreachable too; stale is all that can be said.
  }
  if (record && isRunFinished(record.status)) {
    emit({ record, connection: "final", detail: `Run ${record.status}.` });
    return "final";
  }
  emit({ ...(record ? { record } : {}), connection: "stale", detail });
  return "stale";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
