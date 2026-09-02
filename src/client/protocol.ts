/**
 * What the OMAR runtime says over the wire, typed.
 *
 * Two servers, two protocols. `omar serve` admits programs and reports runs;
 * each run brings up a diagram server of its own that carries the topology and
 * streams what happens to it. The shapes here follow the runtime's serde
 * structs field for field, and the normalisers fill in what an older runtime
 * leaves out, so the rest of the extension reads one shape and never guesses.
 */

export const SERVE_PROTOCOL_VERSION = 1;
export const DIAGRAM_PROTOCOL_VERSION = 1;

export type DiagramTag = {
  /** Nanoseconds of logical time since the run began. */
  timestamp: number;
  microstep: number;
};

/** A run as `omar serve` reports it. `diagram_address` is host:port, not a URL. */
export type RunRecord = {
  run_id: string;
  team: string;
  status: RunStatus;
  diagram_address: string | null;
  /** Unix seconds. */
  started_at: number;
  finished_at: number | null;
  error: string | null;
};

/**
 * `stopped` is what a graceful `omar stop` leaves behind. The web client's
 * validator does not know it and throws; a client that meets a stopped run
 * and refuses to draw it is worse than one that shows it stopped.
 */
export type RunStatus = "starting" | "running" | "completed" | "stopped" | "failed";

const RUN_STATUSES: ReadonlySet<string> = new Set([
  "starting",
  "running",
  "completed",
  "stopped",
  "failed",
]);

export function isRunFinished(status: RunStatus): boolean {
  return status === "completed" || status === "stopped" || status === "failed";
}

export type RunRequest = {
  program: string;
  inputs: Record<string, unknown>;
  /** Run the logical clock as fast as the work allows. */
  fast?: boolean;
  timeout_seconds?: number;
};

export type DiagramInstance = {
  id: string;
  name: string;
  /** The team it was instantiated from. */
  team: string;
  /** The container this one sits in, as an id, or "" at the top level. */
  parent: string;
};

export type DiagramAgent = {
  id: string;
  name: string;
  backend: string;
  /** The instance it belongs to, as a name. */
  instance: string;
};

export type DiagramPort = {
  id: string;
  name: string;
  kind: "input" | "output" | "action";
  type: string;
  delay: number | null;
  value: unknown;
  last_tag: DiagramTag | null;
  instance: string;
};

export type DiagramTimer = {
  id: string;
  name: string;
  offset: number;
  /** 0 fires once. */
  period: number;
  last_tag: DiagramTag | null;
  instance: string;
};

export type ReactionStatus = "idle" | "running" | "completed";

export type DiagramReaction = {
  id: string;
  name: string;
  /** Agent id. */
  agent: string;
  order: number;
  /** Port and timer ids. */
  triggers: string[];
  /** Port ids. */
  effects: string[];
  contract: string;
  status: ReactionStatus;
  invocation_id: string | null;
  instance: string;
  /** Nanoseconds the reaction gave itself, or null when bounded only by the run. */
  within: number | null;
};

export type DiagramEdge = {
  id: string;
  kind: "connection" | "trigger" | "effect";
  source: string;
  target: string;
  delay: number | null;
};

export type DiagramStatus = "ready" | "running" | "completed" | "failed";

export type DiagramSnapshot = {
  protocol_version: number;
  team: string;
  sequence: number;
  status: DiagramStatus;
  current_tag: DiagramTag | null;
  /** Nanoseconds physical time ran past the logical clock; null when unmeasured. */
  lag: number | null;
  instances: DiagramInstance[];
  agents: DiagramAgent[];
  ports: DiagramPort[];
  timers: DiagramTimer[];
  reactions: DiagramReaction[];
  edges: DiagramEdge[];
};

export type DiagramEventKind =
  | "run_started"
  | "tag_advanced"
  | "reaction_started"
  | "reaction_completed"
  | "run_completed"
  | "run_failed";

export const DIAGRAM_EVENT_KINDS: readonly DiagramEventKind[] = [
  "run_started",
  "tag_advanced",
  "reaction_started",
  "reaction_completed",
  "run_completed",
  "run_failed",
];

export type DiagramEvent = {
  protocol_version: number;
  sequence: number;
  team: string;
  tag: DiagramTag | null;
  kind: DiagramEventKind;
  payload: Record<string, unknown>;
};

export type Health = { status: string; protocol_version: number };

export class ProtocolError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tagOf(value: unknown): DiagramTag | null {
  if (!isRecord(value)) return null;
  const { timestamp, microstep } = value;
  return typeof timestamp === "number" && typeof microstep === "number"
    ? { timestamp, microstep }
    : null;
}

export function parseHealth(value: unknown): Health {
  if (!isRecord(value) || typeof value["protocol_version"] !== "number") {
    throw new ProtocolError("Health response is not from an OMAR runtime.");
  }
  if (value["protocol_version"] !== SERVE_PROTOCOL_VERSION) {
    throw new ProtocolError(
      `Unsupported serve protocol ${String(value["protocol_version"])}; this extension speaks ${SERVE_PROTOCOL_VERSION}.`,
    );
  }
  return { status: String(value["status"] ?? ""), protocol_version: SERVE_PROTOCOL_VERSION };
}

export function parseRunRecord(value: unknown): RunRecord {
  if (!isRecord(value)) throw new ProtocolError("Run record is not an object.");
  const { run_id, team, status } = value;
  if (typeof run_id !== "string" || typeof team !== "string") {
    throw new ProtocolError("Run record is missing run_id or team.");
  }
  if (typeof status !== "string" || !RUN_STATUSES.has(status)) {
    throw new ProtocolError(`Unsupported run status ${String(status)}.`);
  }
  return {
    run_id,
    team,
    status: status as RunStatus,
    diagram_address:
      typeof value["diagram_address"] === "string" ? value["diagram_address"] : null,
    started_at: typeof value["started_at"] === "number" ? value["started_at"] : 0,
    finished_at: typeof value["finished_at"] === "number" ? value["finished_at"] : null,
    error: typeof value["error"] === "string" ? value["error"] : null,
  };
}

export function parseRunList(value: unknown): RunRecord[] {
  if (!isRecord(value) || !Array.isArray(value["runs"])) {
    throw new ProtocolError("Run list is missing its runs.");
  }
  return value["runs"].map(parseRunRecord);
}

/**
 * Check a snapshot and fill in what an older runtime leaves out.
 *
 * Instances and timers arrived in later protocol revisions and are simply
 * absent before them; `lag` and `within` are null rather than zero when the
 * runtime does not measure them, because unmeasured is not the same as none.
 */
export function parseDiagramSnapshot(value: unknown): DiagramSnapshot {
  if (!isRecord(value)) throw new ProtocolError("Diagram snapshot is not an object.");
  if (value["protocol_version"] !== DIAGRAM_PROTOCOL_VERSION) {
    throw new ProtocolError(
      `Unsupported diagram protocol ${String(value["protocol_version"])}; this extension speaks ${DIAGRAM_PROTOCOL_VERSION}.`,
    );
  }
  if (
    typeof value["team"] !== "string" ||
    !Array.isArray(value["ports"]) ||
    !Array.isArray(value["reactions"]) ||
    !Array.isArray(value["edges"])
  ) {
    throw new ProtocolError("Diagram snapshot is missing required topology fields.");
  }
  const list = <T>(key: string): T[] => (Array.isArray(value[key]) ? (value[key] as T[]) : []);
  return {
    protocol_version: DIAGRAM_PROTOCOL_VERSION,
    team: value["team"],
    sequence: typeof value["sequence"] === "number" ? value["sequence"] : 0,
    status: (value["status"] as DiagramStatus) ?? "ready",
    current_tag: tagOf(value["current_tag"]),
    lag: typeof value["lag"] === "number" ? value["lag"] : null,
    instances: list<DiagramInstance>("instances"),
    agents: list<DiagramAgent>("agents"),
    ports: list<Record<string, unknown>>("ports").map((port) => ({
      ...(port as unknown as DiagramPort),
      delay: typeof port["delay"] === "number" ? port["delay"] : null,
      value: port["value"] ?? null,
      last_tag: tagOf(port["last_tag"]),
      instance: typeof port["instance"] === "string" ? port["instance"] : "",
    })),
    timers: list<Record<string, unknown>>("timers").map((timer) => ({
      ...(timer as unknown as DiagramTimer),
      last_tag: tagOf(timer["last_tag"]),
      instance: typeof timer["instance"] === "string" ? timer["instance"] : "",
    })),
    reactions: list<Record<string, unknown>>("reactions").map((reaction) => ({
      ...(reaction as unknown as DiagramReaction),
      triggers: Array.isArray(reaction["triggers"]) ? (reaction["triggers"] as string[]) : [],
      effects: Array.isArray(reaction["effects"]) ? (reaction["effects"] as string[]) : [],
      status: (reaction["status"] as ReactionStatus) ?? "idle",
      invocation_id:
        typeof reaction["invocation_id"] === "string" ? reaction["invocation_id"] : null,
      within: typeof reaction["within"] === "number" ? reaction["within"] : null,
      instance: typeof reaction["instance"] === "string" ? reaction["instance"] : "",
    })),
    edges: list<Record<string, unknown>>("edges").map((edge) => ({
      ...(edge as unknown as DiagramEdge),
      delay: typeof edge["delay"] === "number" ? edge["delay"] : null,
    })),
  };
}

export function parseDiagramEvent(value: unknown): DiagramEvent {
  if (!isRecord(value)) throw new ProtocolError("Diagram event is not an object.");
  const { kind, sequence } = value;
  if (typeof kind !== "string" || !DIAGRAM_EVENT_KINDS.includes(kind as DiagramEventKind)) {
    throw new ProtocolError(`Unknown diagram event ${String(kind)}.`);
  }
  if (typeof sequence !== "number") {
    throw new ProtocolError("Diagram event has no sequence.");
  }
  return {
    protocol_version: typeof value["protocol_version"] === "number" ? value["protocol_version"] : 0,
    sequence,
    team: typeof value["team"] === "string" ? value["team"] : "",
    tag: tagOf(value["tag"]),
    kind: kind as DiagramEventKind,
    payload: isRecord(value["payload"]) ? value["payload"] : {},
  };
}

/**
 * Fold an event into the snapshot it belongs to.
 *
 * The diagram server dies with the run, so the last few events may arrive
 * with nothing left to re-fetch from. Applying each event locally keeps the
 * picture right whether or not the server is still there to ask; the snapshot
 * is re-fetched only when the sequence shows something was missed.
 */
export function applyDiagramEvent(snapshot: DiagramSnapshot, event: DiagramEvent): DiagramSnapshot {
  const reactionId = event.payload["reaction"];
  const withReaction = (change: Partial<DiagramReaction>) =>
    snapshot.reactions.map((reaction) =>
      reaction.id === reactionId ? { ...reaction, ...change } : reaction,
    );
  const tag = event.tag ?? snapshot.current_tag;

  switch (event.kind) {
    case "run_started":
      return { ...snapshot, status: "running", sequence: event.sequence };
    case "reaction_started": {
      const invocation = event.payload["invocation_id"];
      return {
        ...snapshot,
        sequence: event.sequence,
        current_tag: tag,
        reactions: withReaction({
          status: "running",
          invocation_id: typeof invocation === "string" ? invocation : null,
        }),
      };
    }
    case "reaction_completed": {
      // The writes name ports by name, and carry what the reaction produced;
      // without them a port stays blank until the next snapshot.
      const writes = isRecord(event.payload["writes"]) ? event.payload["writes"] : {};
      return {
        ...snapshot,
        sequence: event.sequence,
        current_tag: tag,
        reactions: withReaction({ status: "completed", invocation_id: null }),
        ports: snapshot.ports.map((port) =>
          port.name in writes ? { ...port, value: writes[port.name], last_tag: tag } : port,
        ),
      };
    }
    case "tag_advanced": {
      const fired = isRecord(event.payload["ports"]) ? event.payload["ports"] : {};
      const lag = event.payload["lag"];
      return {
        ...snapshot,
        sequence: event.sequence,
        current_tag: tag,
        lag: typeof lag === "number" ? lag : snapshot.lag,
        ports: snapshot.ports.map((port) =>
          port.name in fired ? { ...port, value: fired[port.name], last_tag: tag } : port,
        ),
        timers: snapshot.timers.map((timer) =>
          timer.name in fired ? { ...timer, last_tag: tag } : timer,
        ),
      };
    }
    case "run_completed":
      // Nothing can still be running once the run has completed.
      return {
        ...snapshot,
        sequence: event.sequence,
        status: "completed",
        reactions: snapshot.reactions.map((reaction) =>
          reaction.status === "running"
            ? { ...reaction, status: "completed", invocation_id: null }
            : reaction,
        ),
      };
    case "run_failed":
      // A reaction the failure interrupted produced nothing, so it is idle
      // rather than completed.
      return {
        ...snapshot,
        sequence: event.sequence,
        status: "failed",
        reactions: snapshot.reactions.map((reaction) =>
          reaction.status === "running"
            ? { ...reaction, status: "idle", invocation_id: null }
            : reaction,
        ),
      };
  }
}

/** What `/v1/programs/check` says about a program. */
export type CheckResult =
  | { ok: true; openInputs: string[]; preview: DiagramSnapshot }
  | { ok: false; errors: string[] };

export function parseCheckResult(value: unknown): CheckResult {
  if (!isRecord(value) || typeof value["ok"] !== "boolean") {
    throw new ProtocolError("Check response is not from an OMAR runtime.");
  }
  if (!value["ok"]) {
    const errors = Array.isArray(value["errors"]) ? value["errors"].map(String) : ["The program was refused."];
    return { ok: false, errors };
  }
  return {
    ok: true,
    openInputs: Array.isArray(value["open_inputs"]) ? value["open_inputs"].map(String) : [],
    preview: parseDiagramSnapshot(value["preview"]),
  };
}
