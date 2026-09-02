import type { LiveRun } from "../client/follow";
import type {
  DiagramAgent,
  DiagramReaction,
  DiagramSnapshot,
  RunRecord,
  RunStatus,
} from "../client/protocol";

/**
 * A run arranged for reading: teams holding agents holding reactions.
 *
 * Derived from the snapshot and nothing else. The runtime keeps no state for
 * an agent — its reactions have states — so an agent's activity here is a
 * summary of those, and the reactions are kept underneath it so the summary
 * can be checked against what it summarises.
 */

export type Activity = "idle" | "running" | "completed";

export type AgentView = {
  id: string;
  name: string;
  backend: string;
  instance: string;
  reactions: DiagramReaction[];
  activity: Activity;
};

export type TeamView = {
  id: string;
  name: string;
  /** The team declaration this instance came from. */
  team: string;
  agents: AgentView[];
  children: TeamView[];
};

export type Counts = {
  teams: number;
  agents: number;
  reactions: number;
  running: number;
  completed: number;
  idle: number;
};

export function activityOf(reactions: DiagramReaction[]): Activity {
  if (reactions.some((reaction) => reaction.status === "running")) return "running";
  if (reactions.length > 0 && reactions.every((reaction) => reaction.status === "completed")) {
    return "completed";
  }
  return "idle";
}

export function agentViews(snapshot: DiagramSnapshot): AgentView[] {
  return snapshot.agents.map((agent: DiagramAgent) => {
    const reactions = snapshot.reactions
      .filter((reaction) => reaction.agent === agent.id)
      .sort((a, b) => a.order - b.order);
    return { ...agent, reactions, activity: activityOf(reactions) };
  });
}

/**
 * Teams as a tree, agents placed by the instance they name.
 *
 * A runtime that predates instances sends none; every agent then sits in one
 * team named after the program, which is what the program was before it could
 * nest.
 */
export function teamViews(snapshot: DiagramSnapshot): TeamView[] {
  const agents = agentViews(snapshot);
  if (snapshot.instances.length === 0) {
    return [{ id: "instance::", name: snapshot.team, team: snapshot.team, agents, children: [] }];
  }
  const teams = new Map<string, TeamView>();
  for (const instance of snapshot.instances) {
    teams.set(instance.id, {
      id: instance.id,
      name: instance.name,
      team: instance.team,
      agents: agents.filter((agent) => agent.instance === instance.name),
      children: [],
    });
  }
  const roots: TeamView[] = [];
  for (const instance of snapshot.instances) {
    const view = teams.get(instance.id)!;
    const parent = instance.parent ? teams.get(instance.parent) : undefined;
    if (parent) parent.children.push(view);
    else roots.push(view);
  }
  return roots;
}

export function countsOf(snapshot: DiagramSnapshot | null): Counts {
  if (!snapshot) return { teams: 0, agents: 0, reactions: 0, running: 0, completed: 0, idle: 0 };
  const by = (status: DiagramReaction["status"]) =>
    snapshot.reactions.filter((reaction) => reaction.status === status).length;
  return {
    teams: Math.max(snapshot.instances.length, 1),
    agents: snapshot.agents.length,
    reactions: snapshot.reactions.length,
    running: by("running"),
    completed: by("completed"),
    idle: by("idle"),
  };
}

/**
 * One word for where a run is, from the daemon's record first and the live
 * picture second. The record is the daemon's word on the lifecycle; the
 * picture can be ahead of it by the moment between a run's last event and the
 * daemon writing it down.
 */
export type DeploymentStatus = RunStatus;

export function statusOf(record: RunRecord, live: LiveRun | null): DeploymentStatus {
  if (record.status !== "running" && record.status !== "starting") return record.status;
  const pictured = live?.snapshot?.status;
  if (pictured === "completed") return "completed";
  if (pictured === "failed") return "failed";
  return record.status;
}

/** Seconds the run has been going, or took. */
export function elapsedOf(record: RunRecord, nowSeconds: number): number {
  // A diagram-only connection has no daemon record and so no start time; an
  // elapsed time measured from the epoch would be a lie.
  if (!record.started_at) return Number.NaN;
  const end = record.finished_at ?? nowSeconds;
  return Math.max(0, end - record.started_at);
}
