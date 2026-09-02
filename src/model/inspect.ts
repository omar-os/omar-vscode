import type { DiagramSnapshot } from "../client/protocol";
import { formatNanos, formatTag } from "./format";
import { activityOf } from "./deployment";

/**
 * What the runtime knows about one thing in the picture, as label/value rows.
 *
 * Only what the snapshot carries. A field the runtime does not report has no
 * row, rather than a row saying something made up; the one exception is
 * `value`, where "none" is itself a fact the runtime states.
 */
export type Row = {
  label: string;
  value: string;
  /** An id in the picture the row points at, if any. */
  ref?: string;
  /** A file the row opens, if any. */
  open?: string;
  /** Ids the row brings forward on the topology, if any. */
  highlight?: string[];
};

export type Inspection = {
  id: string;
  kind: "reaction" | "agent" | "port" | "timer" | "instance";
  title: string;
  rows: Row[];
};

export function inspect(snapshot: DiagramSnapshot, id: string): Inspection | null {
  const port = snapshot.ports.find((candidate) => candidate.id === id);
  if (port) {
    return {
      id,
      kind: "port",
      title: port.name,
      rows: [
        { label: "Kind", value: port.kind },
        { label: "Type", value: port.type },
        { label: "Value", value: port.value === null || port.value === undefined ? "none" : JSON.stringify(port.value) },
        { label: "Written at", value: formatTag(port.last_tag) },
        ...(port.delay !== null ? [{ label: "Delay", value: formatNanos(port.delay) }] : []),
        { label: "Team", value: port.instance || snapshot.team, ref: instanceRef(snapshot, port.instance) },
      ],
    };
  }
  const timer = snapshot.timers.find((candidate) => candidate.id === id);
  if (timer) {
    return {
      id,
      kind: "timer",
      title: timer.name,
      rows: [
        { label: "Offset", value: formatNanos(timer.offset) },
        { label: "Period", value: timer.period === 0 ? "once" : formatNanos(timer.period) },
        { label: "Last fired", value: formatTag(timer.last_tag) },
        { label: "Team", value: timer.instance || snapshot.team, ref: instanceRef(snapshot, timer.instance) },
      ],
    };
  }
  const reaction = snapshot.reactions.find((candidate) => candidate.id === id);
  if (reaction) {
    const agent = snapshot.agents.find((candidate) => candidate.id === reaction.agent);
    const portValue = (portId: string) => {
      const found = snapshot.ports.find((candidate) => candidate.id === portId);
      if (!found) return { label: portId.replace(/^\w+::/, ""), value: "" };
      return {
        label: found.name,
        value: found.value === null || found.value === undefined ? "none" : JSON.stringify(found.value),
        ref: found.id,
      };
    };
    return {
      id,
      kind: "reaction",
      title: reaction.name,
      rows: [
        { label: "Status", value: reaction.status },
        ...(reaction.invocation_id ? [{ label: "Invocation", value: reaction.invocation_id }] : []),
        { label: "Agent", value: agent?.name ?? reaction.agent, ref: reaction.agent },
        ...(agent ? [{ label: "Backend", value: agent.backend }] : []),
        { label: "Team", value: reaction.instance || snapshot.team, ref: instanceRef(snapshot, reaction.instance) },
        { label: "Order", value: String(reaction.order) },
        ...(reaction.within !== null ? [{ label: "Within", value: formatNanos(reaction.within) }] : []),
        ...(reaction.contract ? [{ label: "Contract", value: reaction.contract }] : []),
        ...reaction.triggers.map((trigger) => {
          const timerHit = snapshot.timers.find((candidate) => candidate.id === trigger);
          if (timerHit) return { label: `Trigger ${timerHit.name}`, value: `timer · last ${formatTag(timerHit.last_tag)}`, ref: timerHit.id };
          const row = portValue(trigger);
          return { label: `Trigger ${row.label}`, value: row.value, ref: row.ref };
        }),
        ...reaction.effects.map((effect) => {
          const row = portValue(effect);
          return { label: `Effect ${row.label}`, value: row.value, ref: row.ref };
        }),
      ],
    };
  }
  const agent = snapshot.agents.find((candidate) => candidate.id === id);
  if (agent) {
    const reactions = snapshot.reactions.filter((candidate) => candidate.agent === agent.id);
    return {
      id,
      kind: "agent",
      title: agent.name,
      rows: [
        { label: "Activity", value: activityOf(reactions) },
        { label: "Backend", value: agent.backend },
        { label: "Team", value: agent.instance || snapshot.team, ref: instanceRef(snapshot, agent.instance) },
        ...reactions.map((reaction) => ({ label: `Reaction ${reaction.name}`, value: reaction.status, ref: reaction.id })),
      ],
    };
  }
  const instance = snapshot.instances.find((candidate) => candidate.id === id);
  if (instance) {
    const agents = snapshot.agents.filter((candidate) => candidate.instance === instance.name);
    const children = snapshot.instances.filter((candidate) => candidate.parent === instance.id);
    return {
      id,
      kind: "instance",
      title: instance.name,
      rows: [
        { label: "Team", value: instance.team },
        ...(instance.parent ? [{ label: "Inside", value: instance.parent.replace(/^instance::/, ""), ref: instance.parent }] : []),
        ...agents.map((member) => ({ label: `Agent ${member.name}`, value: member.backend, ref: member.id })),
        ...children.map((child) => ({ label: `Instance ${child.name}`, value: child.team, ref: child.id })),
      ],
    };
  }
  return null;
}

function instanceRef(snapshot: DiagramSnapshot, name: string): string | undefined {
  return snapshot.instances.find((candidate) => candidate.name === name)?.id;
}
