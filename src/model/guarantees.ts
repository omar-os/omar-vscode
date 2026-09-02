import type { DiagramSnapshot, RunRecord } from "../client/protocol";
import { formatNanos } from "./format";

/**
 * Guarantees, with the precision the word needs.
 *
 * The runtime does not yet publish a list of what it guarantees, so this is
 * a catalogue of what protocol-1 runtime semantics establish, each entry
 * saying by which mechanism and pointing at the parts of the picture it
 * covers. What the runtime does not check is listed as UNCHECKED; nothing is
 * marked PROVEN, because nothing is. When the runtime starts publishing
 * guarantees they replace this catalogue; the shapes here are the ones a
 * runtime-supplied list would have.
 *
 * A status is one thing at a time:
 *   PROVEN     a checked proof establishes it under stated assumptions
 *   ENFORCED   the runtime prevents violation
 *   MONITORED  the runtime detects violation and says so, but may not prevent it
 *   UNCHECKED  declared, and nothing establishes it
 *   PROVING / FAILED / STALE / VIOLATED  as their names say
 * A guarantee may be enforced and also proven; `enforced` is separate from
 * `status` so both can be true.
 */

export type GuaranteeStatus =
  | "proven"
  | "enforced"
  | "monitored"
  | "unchecked"
  | "proving"
  | "failed"
  | "stale"
  | "violated";

export type Evidence =
  | { type: "lean-proof"; uri: string; workflowRevision: string; checker: string }
  | { type: "runtime-mechanism"; description: string }
  | { type: "artifact"; uri: string; description: string };

export type Guarantee = {
  id: string;
  name: string;
  status: GuaranteeStatus;
  /** The property, as a sentence. */
  property: string;
  /** What establishes it, or why nothing does. */
  how: string;
  /** Who says so. */
  source: "runtime" | "catalogue";
  /** Whether the runtime actively prevents violation, apart from status. */
  enforced: boolean;
  evidence: Evidence[];
  /** Ids in the picture this covers; shown on the topology on request. */
  subjects: string[];
  /** Facts a reader needs, label: value. */
  details: [string, string][];
};

export type GuaranteeCounts = Record<GuaranteeStatus, number>;

export function countGuarantees(guarantees: Guarantee[]): GuaranteeCounts {
  const counts: GuaranteeCounts = {
    proven: 0,
    enforced: 0,
    monitored: 0,
    unchecked: 0,
    proving: 0,
    failed: 0,
    stale: 0,
    violated: 0,
  };
  for (const guarantee of guarantees) counts[guarantee.status] += 1;
  return counts;
}

/**
 * Proof evidence is scoped to a revision. A proof checked against another
 * revision of the program does not count for this one: the guarantee is
 * STALE, whatever it was before.
 */
export function withRevision(guarantee: Guarantee, currentRevision: string | null): Guarantee {
  const proofs = guarantee.evidence.filter((evidence) => evidence.type === "lean-proof");
  if (proofs.length === 0 || guarantee.status !== "proven") return guarantee;
  const stale = currentRevision === null || proofs.some((proof) => proof.workflowRevision !== currentRevision);
  return stale ? { ...guarantee, status: "stale" } : guarantee;
}

/** The catalogue, applied to one run. */
export function guaranteesFor(
  run: RunRecord,
  snapshot: DiagramSnapshot | null,
  programUri: string | null,
): Guarantee[] {
  const reactions = snapshot?.reactions ?? [];
  const ports = snapshot?.ports ?? [];
  const admitted = run.status !== "starting";
  const programEvidence: Evidence[] = programUri
    ? [{ type: "artifact", uri: programUri, description: "The program as the daemon compiled and verified it." }]
    : [];

  const guarantees: Guarantee[] = [
    {
      id: "typed-connections",
      name: "Connections are typed",
      status: admitted ? "enforced" : "unchecked",
      property: "Every connection joins a source and a target of the same type, and every trigger, effect and reference names something declared.",
      how: "The daemon verifies the compiled program before admitting a run and refuses one that fails; a run that exists passed.",
      source: "catalogue",
      enforced: admitted,
      evidence: [{ type: "runtime-mechanism", description: "omar serve · verify() at admission" }, ...programEvidence],
      subjects: ports.map((port) => port.id),
      details: [
        ["Connections", String(snapshot?.edges.filter((edge) => edge.kind === "connection").length ?? 0)],
        ["Ports", String(ports.length)],
      ],
    },
    {
      id: "no-causality-loop",
      name: "No instantaneous cycle",
      status: admitted ? "enforced" : "unchecked",
      property: "No reaction depends on itself through connections that cost no time, so every tag has an order to run in.",
      how: "The daemon rejects a program with a zero-delay cycle among reactions before it runs.",
      source: "catalogue",
      enforced: admitted,
      evidence: [{ type: "runtime-mechanism", description: "omar serve · reject_causality_loops() at admission" }, ...programEvidence],
      subjects: reactions.map((reaction) => reaction.id),
      details: [["Reactions", String(reactions.length)]],
    },
    {
      id: "declared-effects",
      name: "Agents write only declared effects",
      status: "enforced",
      property: "An invocation can write only the ports its reaction declares as effects; a write to any other port is refused.",
      how: "The runtime's port-writing tool checks each write against the reaction's declared effects and refuses the rest.",
      source: "catalogue",
      enforced: true,
      evidence: [{ type: "runtime-mechanism", description: "omar_set_port · allowed_effects" }],
      subjects: reactions.map((reaction) => reaction.id),
      details: reactions.map((reaction) => [reaction.name, reaction.effects.map((effect) => effect.replace(/^port::/, "")).join(", ") || "—"]),
    },
  ];

  const contracted = reactions.filter((reaction) => reaction.contract);
  if (contracted.length > 0) {
    guarantees.push({
      id: "effect-contracts",
      name: "Effect contracts are honoured",
      status: "enforced",
      property: "A reaction completes only with a set of effects its contract permits; anything else fails the run rather than being taken as a result.",
      how: "The runtime validates each completion's writes against the contract and stops the run on a violation.",
      source: "catalogue",
      enforced: true,
      evidence: [{ type: "runtime-mechanism", description: "validate_contract() at completion" }],
      subjects: contracted.map((reaction) => reaction.id),
      details: contracted.map((reaction) => [reaction.name, reaction.contract]),
    });
  }

  const bounded = reactions.filter((reaction) => reaction.within !== null);
  if (bounded.length > 0) {
    guarantees.push({
      id: "deadlines",
      name: "Deadlines are kept",
      status: "monitored",
      property: "A reaction that declares `within` answers inside that time.",
      how: "The runtime notices when the time passes without an answer. It cannot make an agent answer: a contract that allows silence completes with no writes; one that requires an effect stops the run.",
      source: "catalogue",
      enforced: false,
      evidence: [{ type: "runtime-mechanism", description: "expired() on the invocation deadline" }],
      subjects: bounded.map((reaction) => reaction.id),
      details: bounded.map((reaction) => [reaction.name, `within ${formatNanos(reaction.within)}`]),
    });
  }

  guarantees.push(
    {
      id: "team-isolation",
      name: "Teams are isolated",
      status: "unchecked",
      property: "An agent in one team cannot read or write another team's workspace.",
      how: "Nothing establishes this. Every agent runs in the daemon's working directory with the backend's own permission checks turned off; no sandbox provider is configured.",
      source: "catalogue",
      enforced: false,
      evidence: [],
      subjects: (snapshot?.agents ?? []).map((agent) => agent.id),
      details: [
        ["Filesystem", "shared · the daemon's working directory"],
        ["Process", "one tmux session per agent"],
        ["Network", "unrestricted"],
        ["Credentials", "the backend's permission checks are disabled"],
        ["Port writes", "scoped to declared effects (see above)"],
        ["Provider", "none"],
      ],
    },
    {
      id: "termination",
      name: "The run terminates",
      status: "unchecked",
      property: "The run reaches an end on its own.",
      how: "Nothing checks this. A periodic timer keeps a run alive until it is stopped.",
      source: "catalogue",
      enforced: false,
      evidence: [],
      subjects: (snapshot?.timers ?? []).map((timer) => timer.id),
      details: [["Periodic timers", String(snapshot?.timers.filter((timer) => timer.period > 0).length ?? 0)]],
    },
  );

  return guarantees;
}

export const STATUS_GLYPH: Record<GuaranteeStatus, string> = {
  proven: "✓",
  enforced: "✓",
  monitored: "◐",
  unchecked: "?",
  proving: "…",
  failed: "✕",
  stale: "⚠",
  violated: "✕",
};
