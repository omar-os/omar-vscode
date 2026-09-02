import type { LiveRun } from "../client/follow";
import type { RunRecord } from "../client/protocol";
import type { ArtifactListing } from "../artifacts/store";
import { elapsedOf, statusOf } from "../model/deployment";
import { formatElapsed, formatTag } from "../model/format";
import { countGuarantees, type Guarantee } from "../model/guarantees";

/**
 * What the assistant is told about the selected deployment.
 *
 * The runtime gives the assistant nothing about runs: a chat message reaches
 * it as text and the selection, and no tool of its reads a run. So the
 * extension says what the runtime says — status, each reaction's state, the
 * values on the ports, the last events, the guarantees, and where the files
 * are — in a block the assistant can read. Everything in it comes from the
 * runtime's own answers; nothing is inferred. It is bounded, and says when
 * it was cut, so a long run does not become a long prompt.
 */

export const CONTEXT_BEGIN = "[Mission Control context — from the runtime, not typed by the operator]";
export const CONTEXT_END = "[end of context]";

const MAX_EVENTS = 12;
const MAX_VALUE = 80;
const MAX_CHARS = 6000;

export type ContextInput = {
  run: RunRecord;
  live: LiveRun | null;
  guarantees: Guarantee[];
  listing: ArtifactListing | null;
  /** The id the operator is looking at in the inspector, if any. */
  inspected: string | null;
  nowSeconds: number;
};

export function deploymentContext(input: ContextInput): string {
  const { run, live } = input;
  const snapshot = live?.snapshot ?? null;
  const lines: string[] = [CONTEXT_BEGIN];
  const status = statusOf(run, live);
  const elapsed = elapsedOf(run, input.nowSeconds);
  lines.push(
    `Deployment ${run.team} (run ${run.run_id}): ${status.toUpperCase()}` +
      (Number.isFinite(elapsed) ? `, elapsed ${formatElapsed(elapsed)}` : "") +
      (live ? `, picture ${live.connection.toUpperCase()}` : "") +
      (snapshot?.current_tag ? `, logical time ${formatTag(snapshot.current_tag)}` : "") +
      (run.error ? `, error: ${run.error}` : ""),
  );
  if (live?.detail && live.connection !== "live") lines.push(`Picture note: ${live.detail}`);

  if (snapshot) {
    const agentName = new Map(snapshot.agents.map((agent) => [agent.id, `${agent.name} (${agent.backend})`]));
    lines.push("Reactions:");
    for (const reaction of snapshot.reactions) {
      lines.push(`  ${reaction.name} — ${reaction.status}; agent ${agentName.get(reaction.agent) ?? reaction.agent}` + (reaction.contract ? `; contract ${reaction.contract}` : ""));
    }
    const carrying = snapshot.ports.filter((port) => port.value !== null && port.value !== undefined);
    if (carrying.length > 0) {
      lines.push("Port values:");
      for (const port of carrying) lines.push(`  ${port.name} = ${brief(port.value)}` + (port.last_tag ? ` (written at ${formatTag(port.last_tag)})` : ""));
    }
    const empty = snapshot.ports.filter((port) => port.value === null || port.value === undefined).map((port) => port.name);
    if (empty.length > 0) lines.push(`Ports without a value yet: ${empty.join(", ")}`);
    if (snapshot.timers.length > 0) {
      lines.push("Timers: " + snapshot.timers.map((timer) => `${timer.name} (last fired ${formatTag(timer.last_tag)})`).join(", "));
    }
  } else {
    lines.push("No picture of this deployment: its diagram server is gone.");
  }

  const events = (live?.log ?? []).slice(-MAX_EVENTS);
  if (events.length > 0) {
    const dropped = (live?.log.length ?? 0) - events.length;
    lines.push(`Recent events${dropped > 0 ? ` (${dropped} earlier omitted)` : ""}:`);
    for (const entry of events) {
      if (entry.kind === "note") {
        lines.push(`  note: ${entry.text}`);
        continue;
      }
      const { event } = entry;
      const subject = typeof event.payload["reaction"] === "string" ? String(event.payload["reaction"]).replace(/^reaction::/, "") : "";
      const writes = event.payload["writes"];
      const wrote = writes && typeof writes === "object" ? Object.entries(writes as Record<string, unknown>).map(([port, value]) => `${port}=${brief(value)}`).join(", ") : "";
      lines.push(`  #${event.sequence} ${event.kind}${subject ? ` ${subject}` : ""}${event.tag ? ` at ${formatTag(event.tag)}` : ""}${wrote ? ` wrote ${wrote}` : ""}${event.kind === "run_failed" ? ` — ${String(event.payload["message"] ?? "")}` : ""}`);
    }
  }

  if (input.guarantees.length > 0) {
    const counts = countGuarantees(input.guarantees);
    const summary = Object.entries(counts).filter(([, count]) => count > 0).map(([name, count]) => `${count} ${name}`).join(", ");
    lines.push(`Guarantees: ${summary}. ` + input.guarantees.map((guarantee) => `${guarantee.name}: ${guarantee.status}`).join("; "));
  }

  if (input.listing?.directory) {
    lines.push(`Files on this machine: ${input.listing.directory} (` + input.listing.groups.map((group) => `${group.label.toLowerCase()}: ${group.artifacts.map((artifact) => artifact.name).join(", ")}`).join("; ") + ")");
    if (input.listing.caveat) lines.push(`Files note: ${input.listing.caveat}`);
  }
  if (input.inspected) lines.push(`The operator is inspecting: ${input.inspected}`);
  lines.push(CONTEXT_END);

  let text = lines.join("\n");
  if (text.length > MAX_CHARS) {
    text = `${text.slice(0, MAX_CHARS - CONTEXT_END.length - 40)}\n  … (context cut at ${MAX_CHARS} characters)\n${CONTEXT_END}`;
  }
  return text;
}

/** The operator's own words, when a message carries a context block. */
export function withoutContext(text: string): { text: string; hadContext: boolean } {
  const end = text.indexOf(CONTEXT_END);
  if (!text.startsWith(CONTEXT_BEGIN) || end < 0) return { text, hadContext: false };
  return { text: text.slice(end + CONTEXT_END.length).replace(/^\s+/, ""), hadContext: true };
}

function brief(value: unknown): string {
  const text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
}
