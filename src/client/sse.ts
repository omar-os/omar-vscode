/**
 * Server-sent events, parsed by hand.
 *
 * The extension host is Node, which has `fetch` but no `EventSource`, so the
 * stream is read as text and cut into frames here. The grammar is small: a
 * frame is lines until a blank one; `id:`, `event:` and `data:` fields, with
 * several `data:` lines joined by newlines; a line starting with `:` is a
 * comment the server sends to keep the connection warm.
 */

export type SseFrame = {
  id: string | null;
  event: string | null;
  data: string;
};

export class SseParser {
  private buffer = "";
  private id: string | null = null;
  private event: string | null = null;
  private data: string[] = [];

  /** Feed a chunk, get back every frame it completed. */
  feed(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    for (;;) {
      const end = this.buffer.search(/\r\n|\r|\n/);
      if (end < 0) break;
      const line = this.buffer.slice(0, end);
      const eol = this.buffer.startsWith("\r\n", end) ? 2 : 1;
      this.buffer = this.buffer.slice(end + eol);
      const frame = this.line(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  private line(line: string): SseFrame | null {
    if (line === "") {
      if (this.data.length === 0 && this.event === null && this.id === null) return null;
      const frame = { id: this.id, event: this.event, data: this.data.join("\n") };
      this.id = null;
      this.event = null;
      this.data = [];
      return frame;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "id":
        this.id = value;
        break;
      case "event":
        this.event = value;
        break;
      case "data":
        this.data.push(value);
        break;
      default:
        // `retry` and anything unknown: the spec says ignore.
        break;
    }
    return null;
  }
}

/** Read a response body as SSE frames until it ends or the signal fires. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const cancel = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.feed(decoder.decode(value, { stream: true }))) yield frame;
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
