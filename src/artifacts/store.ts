import { createHash } from "node:crypto";

import type { DiagramSnapshot, RunRecord } from "../client/protocol";

/**
 * What a run wrote to disk, found where the runtime puts it.
 *
 * The daemon does not serve these files; it writes them under its data
 * directory and `omar status` prints the path. The extension host runs on
 * the same machine as the daemon — under Remote SSH that is the remote — so
 * the files are read from there and opened as ordinary documents.
 *
 *     <data>/active_ea                          which EA is current
 *     <data>/ea/<ea>/serve/<run_id>/program.omar  the program as submitted
 *     <data>/ea/<ea>/topologies/<team>/
 *         deployment.json  outputs.json  state.json
 *         logs/<agent>.txt        the agent's pane, captured at the end
 *         agents/<agent>/system.md  the agent's standing instructions
 *
 * The topology directory is per team, not per run: a later run of the same
 * team overwrites it. When its record is newer than the run being shown, the
 * listing says so instead of passing off another run's files as this one's.
 */

export type ArtifactKind = "program" | "outputs" | "state" | "record" | "log" | "instructions";

export type Artifact = {
  id: string;
  /** Shown to the reader. */
  name: string;
  kind: ArtifactKind;
  /** Absolute path on the extension host. */
  path: string;
  /** The agent it came from, as an id, when it came from one. */
  producer: string | null;
  /** Unix seconds, from the file. */
  modified: number | null;
  size: number | null;
};

export type ArtifactGroup = { label: string; artifacts: Artifact[] };

export type ArtifactListing = {
  /** The topology directory, when it exists. */
  directory: string | null;
  /**
   * The program's revision: the first seven hex digits of the SHA-256 of its
   * source as submitted. Nothing more is available — the daemon keeps no
   * history — and it is enough to tell one revision from another, which is
   * what a proof must be scoped to.
   */
  revision: string | null;
  groups: ArtifactGroup[];
  /** Something the reader must know before trusting the list. */
  caveat: string | null;
};

/** The few file operations this needs, so a test can hand it a fake disk. */
export type Files = {
  readDirectory(path: string): Promise<[string, "file" | "directory"][]>;
  stat(path: string): Promise<{ mtime: number; size: number } | null>;
  readFile(path: string): Promise<string | null>;
};

export function join(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

/** The EA the runtime is using, as written in `active_ea`; 0 when unwritten. */
export async function activeEa(files: Files, dataDir: string): Promise<string> {
  const text = await files.readFile(join(dataDir, "active_ea"));
  const trimmed = text?.trim() ?? "";
  return /^\d+$/.test(trimmed) ? trimmed : "0";
}

export function topologyDir(dataDir: string, ea: string, team: string): string {
  return join(dataDir, "ea", ea, "topologies", team);
}

export function programPath(dataDir: string, ea: string, runId: string): string {
  return join(dataDir, "ea", ea, "serve", runId, "program.omar");
}

/**
 * The tmux session name the runtime derives from an agent name: dots become
 * underscores. Reversed here by matching against the agents actually in the
 * run, since the mapping is not one to one in general.
 */
export function agentForLog(filename: string, agents: { id: string; name: string }[]): string | null {
  const stem = filename.replace(/\.txt$/, "");
  const found = agents.find((agent) => agent.name.replace(/\./g, "_") === stem);
  return found?.id ?? null;
}

export async function listArtifacts(
  files: Files,
  dataDir: string,
  run: RunRecord,
  snapshot: DiagramSnapshot | null,
): Promise<ArtifactListing> {
  const ea = await activeEa(files, dataDir);
  const agents = snapshot?.agents ?? [];
  const groups: ArtifactGroup[] = [];
  let caveat: string | null = null;

  const describe = async (path: string, name: string, kind: ArtifactKind, producer: string | null): Promise<Artifact | null> => {
    const stat = await files.stat(path);
    if (!stat) return null;
    return { id: path, name, kind, path, producer, modified: stat.mtime, size: stat.size };
  };

  const program = await describe(programPath(dataDir, ea, run.run_id), "program.omar", "program", null);
  if (program) groups.push({ label: "Program", artifacts: [program] });
  const source = program ? await files.readFile(program.path) : null;
  const revision = source === null ? null : revisionOf(source);

  const directory = topologyDir(dataDir, ea, run.team);
  const record = await files.readFile(join(directory, "deployment.json"));
  if (record === null) {
    return { directory: null, revision, groups, caveat: groups.length === 0 ? "The runtime has written nothing for this run yet." : null };
  }
  try {
    const parsed = JSON.parse(record) as { started_at?: number };
    if (typeof parsed.started_at === "number" && parsed.started_at > run.started_at) {
      caveat = `A later run of ${run.team} has overwritten this run's files; what is listed belongs to that run.`;
    }
  } catch {
    caveat = "deployment.json could not be read.";
  }

  const results: Artifact[] = [];
  for (const [file, kind] of [
    ["outputs.json", "outputs"],
    ["state.json", "state"],
    ["deployment.json", "record"],
  ] as const) {
    const artifact = await describe(join(directory, file), file, kind, null);
    if (artifact) results.push(artifact);
  }
  if (results.length > 0) groups.push({ label: "Results", artifacts: results });

  const logs: Artifact[] = [];
  for (const [name, type] of await files.readDirectory(join(directory, "logs"))) {
    if (type !== "file" || !name.endsWith(".txt")) continue;
    const artifact = await describe(join(directory, "logs", name), name, "log", agentForLog(name, agents));
    if (artifact) logs.push(artifact);
  }
  logs.sort((a, b) => a.name.localeCompare(b.name));
  if (logs.length > 0) groups.push({ label: "Agent logs", artifacts: logs });

  const instructions: Artifact[] = [];
  for (const [name, type] of await files.readDirectory(join(directory, "agents"))) {
    if (type !== "directory") continue;
    const agent = agents.find((candidate) => candidate.name === name);
    for (const [file, fileType] of await files.readDirectory(join(directory, "agents", name))) {
      if (fileType !== "file") continue;
      const artifact = await describe(join(directory, "agents", name, file), `${name}/${file}`, "instructions", agent?.id ?? null);
      if (artifact) instructions.push(artifact);
    }
  }
  instructions.sort((a, b) => a.name.localeCompare(b.name));
  if (instructions.length > 0) groups.push({ label: "Agent instructions", artifacts: instructions });

  return { directory, revision, groups, caveat };
}

export function revisionOf(source: string): string {
  return createHash("sha256").update(source).digest("hex").slice(0, 7);
}
