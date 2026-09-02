import { execFile } from "node:child_process";

/**
 * What this connection can do, found out rather than assumed.
 *
 * The daemon has no capabilities route yet, so what it offers is read off
 * what it answers, and what needs the CLI is checked by running it. A
 * control the runtime cannot honour is not shown; and nothing here grants
 * anything — the runtime refuses what it refuses whether or not a button
 * was drawn.
 */
export type Capabilities = {
  protocolVersion: number | null;
  /** Live events from a run's diagram server. Always, on protocol 1. */
  eventStreaming: boolean;
  /** Starting a run: the daemon's admission API is reachable. */
  run: boolean;
  /** Stopping a run: the `omar` CLI is on this machine, and drives the daemon's own record. */
  stop: boolean;
  /** Reading a run's files: the data directory is where this extension host can see it. */
  artifacts: boolean;
  /** A list of guarantees from the runtime itself. Not yet; the view shows a catalogue. */
  guarantees: boolean;
  proofs: boolean;
  sandboxes: boolean;
  pauseResume: boolean;
  approvals: boolean;
  /** Nothing this connection reaches can change the run. */
  readOnly: boolean;
};

export const NONE: Capabilities = {
  protocolVersion: null,
  eventStreaming: false,
  run: false,
  stop: false,
  artifacts: false,
  guarantees: false,
  proofs: false,
  sandboxes: false,
  pauseResume: false,
  approvals: false,
  readOnly: true,
};

export async function discover(input: {
  protocolVersion: number | null;
  /** The admission daemon answered. */
  daemon: boolean;
  cliPath: string;
  artifactsReadable: boolean;
}): Promise<Capabilities> {
  const cli = input.daemon && (await cliWorks(input.cliPath));
  return {
    protocolVersion: input.protocolVersion,
    eventStreaming: input.protocolVersion === 1,
    run: input.daemon,
    stop: cli,
    artifacts: input.artifactsReadable,
    guarantees: false,
    proofs: false,
    sandboxes: false,
    pauseResume: false,
    approvals: false,
    readOnly: !input.daemon,
  };
}

/** Whether `omar --version` runs; a missing or broken CLI is simply no CLI. */
export function cliWorks(cliPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cliPath, ["--version"], { timeout: 5000 }, (error, stdout) => {
      resolve(!error && /^omar\b/.test(stdout.trim()));
    });
  });
}
