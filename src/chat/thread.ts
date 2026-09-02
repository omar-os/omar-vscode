import type { ChatClient, ChatMessage } from "../client/chat";

/**
 * The thread with the assistant, kept current.
 *
 * Messages arrive on the daemon's stream, which replays the backlog on every
 * connection, so each one is placed by its sequence and a re-delivery changes
 * nothing. `drafting` is true from the operator's message until the assistant
 * answers with something that is not running commentary — a question, an
 * explanation, a proposal — which is when there is something to read. A
 * broken stream is `stale` until it is back, and says so. Nothing here
 * imports vscode.
 */

export type ThreadConnection = "off" | "connecting" | "live" | "stale";

export type ThreadState = {
  messages: ChatMessage[];
  connection: ThreadConnection;
  drafting: boolean;
  /** The daemon's words when a send was refused, until the next send. */
  problem: string | null;
};

export class Thread {
  private state: ThreadState = { messages: [], connection: "off", drafting: false, problem: null };
  private abort: AbortController | null = null;

  constructor(
    private readonly client: ChatClient,
    private readonly onChange: (state: ThreadState) => void,
    private readonly retryMs = 2000,
  ) {}

  get current(): ThreadState {
    return this.state;
  }

  /** Follow the stream until stopped, reconnecting when it breaks. */
  start(): void {
    this.stop();
    const abort = new AbortController();
    this.abort = abort;
    void this.follow(abort.signal);
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
    this.set({ connection: "off" });
  }

  /** Post the operator's message; the daemon echoes it on the stream. */
  async send(text: string, selection: string[]): Promise<boolean> {
    this.set({ problem: null });
    try {
      const message = await this.client.send(text, selection);
      this.place(message);
      this.set({ drafting: true });
      return true;
    } catch (cause) {
      this.set({ problem: cause instanceof Error ? cause.message : String(cause) });
      return false;
    }
  }

  private async follow(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      this.set({ connection: "connecting" });
      try {
        for await (const message of this.client.events(signal, () => this.set({ connection: "live" }))) {
          this.place(message);
        }
        // The daemon closed the stream; it does so only when it is going away.
        if (!signal.aborted) this.set({ connection: "stale" });
      } catch {
        if (!signal.aborted) this.set({ connection: "stale" });
      }
      if (signal.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, this.retryMs));
    }
  }

  /** Put a message where its sequence says, replacing what was there. */
  private place(message: ChatMessage): void {
    const messages = this.state.messages.filter((existing) => existing.sequence !== message.sequence);
    messages.push(message);
    messages.sort((a, b) => a.sequence - b.sequence);
    // Drafting ends with the assistant's first non-progress word after the
    // operator's last; a proposal counts, a progress note does not.
    const lastOperator = [...messages].reverse().find((entry) => entry.role === "operator");
    const answered = messages.some(
      (entry) => entry.role === "assistant" && !entry.progress && (!lastOperator || entry.sequence > lastOperator.sequence),
    );
    const drafting = lastOperator !== undefined && !answered;
    this.set({ messages, drafting });
  }

  private set(change: Partial<ThreadState>): void {
    this.state = { ...this.state, ...change };
    this.onChange(this.state);
  }
}
