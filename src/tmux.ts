import { execFile } from "node:child_process";

/**
 * Where an agent lives: the runtime runs every agent, and the assistant, in
 * a tmux session on the machine the daemon is on.
 *
 * The daemon writes each run agent's session into the deployment record
 * (`sessions`, agent name → session), which is the authority. Failing that
 * the name is derived the way the runtime derives it — dots to underscores
 * after the EA's prefix — and matched against what tmux lists. The
 * assistant's session is `<prefix>ea-<ea>`. No vscode here, so this is
 * tested with node.
 */

/** `first.agent` is the session suffix `first_agent`, as the runtime flattens it. */
export function flattenAgentName(agent: string): string {
  return agent.replace(/^agent::/, "").replace(/\./g, "_");
}

/** The session for an agent: the record's word, else the best match among tmux's. */
export function sessionFor(agent: string, recorded: Record<string, string>, listed: string[], ea: string): string | null {
  const name = agent.replace(/^agent::/, "");
  if (recorded[name]) return recorded[name]!;
  const suffix = `-${flattenAgentName(name)}`;
  const mine = listed.filter((session) => session.endsWith(suffix));
  return mine.find((session) => session.includes(`-${ea}-`)) ?? mine[0] ?? null;
}

/** The assistant's session for an EA, among tmux's. */
export function assistantSessionFor(listed: string[], ea: string): string | null {
  return listed.find((session) => session.endsWith(`ea-${ea}`)) ?? listed.find((session) => /ea-\d+$/.test(session)) ?? null;
}

/** What tmux has on this host; nothing when tmux is not there. */
export function listSessions(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("tmux", ["list-sessions", "-F", "#S"], { timeout: 5000 }, (error, stdout) => {
      resolve(error ? [] : stdout.split("\n").map((line) => line.trim()).filter(Boolean));
    });
  });
}
