import {
  DIAGRAM_EVENT_KINDS,
  parseCheckResult,
  parseDiagramEvent,
  parseDiagramSnapshot,
  parseHealth,
  parseRunList,
  parseRunRecord,
  type DiagramEvent,
  type DiagramEventKind,
  type CheckResult,
  type DiagramSnapshot,
  type Health,
  type RunRecord,
  type RunRequest,
} from "./protocol";
import { readSse } from "./sse";

/**
 * The runtime, reached over HTTP.
 *
 * Everything the extension knows about a run comes through here: the daemon
 * for which runs exist and how each ended, the run's own diagram server for
 * what is inside it and what it is doing. Nothing is cached; the runtime is
 * the source of truth and this is the one door to it.
 */

export class RuntimeUnreachable extends Error {}
export class RuntimeRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function normalizeRuntimeUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Runtime URL must use http or https.");
  }
  return parsed.toString().replace(/\/$/, "");
}

/** `omar serve` reports host:port; the diagram API is plain HTTP beside it. */
export function diagramUrlFor(record: RunRecord): string | null {
  return record.diagram_address ? `http://${record.diagram_address}` : null;
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new RuntimeUnreachable(`Could not reach ${url}: ${describe(cause)}`);
  }
  if (!response.ok) throw new RuntimeRefused(response.status, await readError(response));
  return response.json();
}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Not JSON; the status is all there is.
  }
  return `Runtime returned HTTP ${response.status}.`;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = (cause as { cause?: unknown }).cause;
    return inner instanceof Error ? inner.message : cause.message;
  }
  return String(cause);
}

/** The admission daemon: `omar serve`. */
export class ServeClient {
  readonly url: string;

  constructor(url: string) {
    this.url = normalizeRuntimeUrl(url);
  }

  health(signal?: AbortSignal): Promise<Health> {
    return getJson(`${this.url}/health`, signal).then(parseHealth);
  }

  listRuns(signal?: AbortSignal): Promise<RunRecord[]> {
    return getJson(`${this.url}/v1/runs`, signal).then(parseRunList);
  }

  getRun(id: string, signal?: AbortSignal): Promise<RunRecord> {
    return getJson(`${this.url}/v1/runs/${encodeURIComponent(id)}`, signal).then(parseRunRecord);
  }

  startRun(request: RunRequest, signal?: AbortSignal): Promise<RunRecord> {
    return this.post("/v1/runs", request, signal).then(parseRunRecord);
  }

  /** Compile and verify a program without running it. `filename` must end in `.omar`. */
  checkProgram(program: string, filename: string, signal?: AbortSignal): Promise<CheckResult> {
    return this.post("/v1/programs/check", { program, filename }, signal).then(parseCheckResult);
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new RuntimeUnreachable(`Could not reach ${this.url}: ${describe(cause)}`);
    }
    if (!response.ok) throw new RuntimeRefused(response.status, await readError(response));
    return response.json();
  }
}

/** One run's diagram server. It lives exactly as long as the run. */
export class DiagramClient {
  readonly url: string;

  constructor(url: string) {
    this.url = normalizeRuntimeUrl(url);
  }

  snapshot(signal?: AbortSignal): Promise<DiagramSnapshot> {
    return getJson(`${this.url}/v1/diagram`, signal).then(parseDiagramSnapshot);
  }

  /**
   * The event stream, as it arrives. Ends when the server closes it, which it
   * does when the run ends; throws when the connection breaks before that.
   */
  async *events(signal?: AbortSignal): AsyncGenerator<DiagramEvent> {
    let response: Response;
    try {
      response = await fetch(`${this.url}/v1/events`, {
        headers: { accept: "text/event-stream" },
        signal,
      });
    } catch (cause) {
      if (signal?.aborted) return;
      throw new RuntimeUnreachable(`Could not reach ${this.url}: ${describe(cause)}`);
    }
    if (!response.ok || !response.body) {
      throw new RuntimeRefused(response.status, await readError(response));
    }
    for await (const frame of readSse(response.body, signal)) {
      if (!frame.event || !DIAGRAM_EVENT_KINDS.includes(frame.event as DiagramEventKind)) continue;
      yield parseDiagramEvent(JSON.parse(frame.data));
    }
  }
}
