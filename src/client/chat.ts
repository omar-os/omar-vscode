import { normalizeRuntimeUrl, RuntimeRefused, RuntimeUnreachable } from "./OmarClient";
import { parseDiagramSnapshot, ProtocolError, type DiagramSnapshot } from "./protocol";
import { readSse } from "./sse";

/**
 * The operator's conversation with the executive assistant, as `omar serve`
 * relays it.
 *
 * The daemon keeps the thread in memory and streams it: a subscriber gets
 * the whole backlog first, then what follows. A message the EA sends with a
 * `design` is a proposal — a complete program the daemon has compiled, with
 * the preview it drew — and nothing runs until the operator deploys it.
 */

export type ProposedDesign = {
  program: string;
  inputs: Record<string, unknown>;
  preview: DiagramSnapshot;
};

export type ChatMessage = {
  sequence: number;
  role: "operator" | "assistant";
  text: string;
  /** Commentary while the assistant works, rather than a reply awaiting the operator. */
  progress: boolean;
  design: ProposedDesign | null;
  /** Components the operator had selected when they sent this. */
  selection: string[];
};

export type Assistant = { backend: string | null; available: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseChatMessage(value: unknown): ChatMessage {
  if (!isRecord(value)) throw new ProtocolError("Chat message is not an object.");
  const { sequence, role, text } = value;
  if (typeof sequence !== "number" || typeof text !== "string") {
    throw new ProtocolError("Chat message is missing required fields.");
  }
  if (role !== "operator" && role !== "assistant") {
    throw new ProtocolError(`Unsupported chat role ${String(role)}.`);
  }
  let design: ProposedDesign | null = null;
  if (isRecord(value["design"])) {
    const raw = value["design"];
    if (typeof raw["program"] !== "string") throw new ProtocolError("Proposed design is missing its program.");
    design = {
      program: raw["program"],
      inputs: isRecord(raw["inputs"]) ? raw["inputs"] : {},
      preview: parseDiagramSnapshot(raw["preview"]),
    };
  }
  return {
    sequence,
    role,
    text,
    progress: value["progress"] === true,
    design,
    // Older daemons predate selection; an absent one is simply none.
    selection: Array.isArray(value["selection"]) ? value["selection"].filter((name): name is string => typeof name === "string") : [],
  };
}

/** The chat routes of `omar serve`. */
export class ChatClient {
  readonly url: string;

  constructor(url: string) {
    this.url = normalizeRuntimeUrl(url);
  }

  /** Publish an operator message; the daemon's refusal (no EA, say) comes back in its own words. */
  async send(text: string, selection: string[], signal?: AbortSignal): Promise<ChatMessage> {
    return parseChatMessage(await this.post("/v1/chat", { text, selection }, signal));
  }

  async history(signal?: AbortSignal): Promise<ChatMessage[]> {
    const body = await this.get("/v1/chat", signal);
    if (!isRecord(body) || !Array.isArray(body["messages"])) throw new ProtocolError("Chat history is missing its messages.");
    return body["messages"].map(parseChatMessage);
  }

  async assistant(signal?: AbortSignal): Promise<Assistant> {
    const body = await this.get("/v1/agent", signal);
    if (!isRecord(body)) throw new ProtocolError("Agent description is not an object.");
    return {
      backend: typeof body["backend"] === "string" ? body["backend"] : null,
      available: Array.isArray(body["available"]) ? body["available"].map(String) : [],
    };
  }

  /** Relaunch the assistant on a backend; its current session is lost. */
  async restartAssistant(backend: string, signal?: AbortSignal): Promise<void> {
    await this.post("/v1/agent/backend", { backend }, signal);
  }

  /**
   * The thread as it happens: the backlog first, then live. Ends when the
   * daemon closes the stream; throws when the connection breaks.
   */
  async *events(signal?: AbortSignal, onOpen?: () => void): AsyncGenerator<ChatMessage> {
    let response: Response;
    try {
      response = await fetch(`${this.url}/v1/chat/events`, { headers: { accept: "text/event-stream" }, signal });
    } catch (cause) {
      if (signal?.aborted) return;
      throw new RuntimeUnreachable(`Could not reach ${this.url}: ${describe(cause)}`);
    }
    if (!response.ok || !response.body) throw new RuntimeRefused(response.status, `Runtime returned HTTP ${response.status}.`);
    // The stream is open before anything is on it: an empty thread is live too.
    onOpen?.();
    for await (const frame of readSse(response.body, signal)) {
      if (frame.event !== "message" && frame.event !== "design_proposed") continue;
      yield parseChatMessage(JSON.parse(frame.data));
    }
  }

  private async get(path: string, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.url}${path}`, { signal });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new RuntimeUnreachable(`Could not reach ${this.url}: ${describe(cause)}`);
    }
    if (!response.ok) throw new RuntimeRefused(response.status, await readError(response));
    return response.json();
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
