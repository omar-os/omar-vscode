import type { DiagramSnapshot } from "./client/protocol";

/**
 * The snapshot a compiled program would have before it runs.
 *
 * The daemon's `/v1/programs/check` answers with exactly this for a program
 * it compiles; when there is no daemon, the same shape is read straight off
 * the bytecode, which is a list of declarations, so the diagram draws the
 * file the way it would draw the daemon's preview. Nothing here is state:
 * every port is empty, every reaction idle, the clock unstarted.
 */

type Instruction = Record<string, unknown>;

export function fromBytecode(bytecode: unknown): DiagramSnapshot {
  const program = bytecode as { team?: string; instructions?: Instruction[] };
  const instructions = program.instructions ?? [];
  const named = (op: string) => instructions.filter((instruction) => instruction["op"] === op);
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const number = (value: unknown) => (typeof value === "number" ? value : 0);
  const timers = new Set(named("declare_timer").map((timer) => text(timer["name"])));

  const orderWithin = new Map<string, number>();
  return {
    protocol_version: 1,
    team: program.team ?? "",
    sequence: 0,
    status: "ready",
    current_tag: null,
    lag: null,
    instances: named("declare_instance").map((instance) => ({
      id: `instance::${text(instance["name"])}`,
      name: text(instance["name"]),
      team: text(instance["team"]),
      parent: instance["parent"] ? `instance::${text(instance["parent"])}` : "",
    })),
    agents: named("spawn_agent").map((agent) => ({
      id: `agent::${text(agent["name"])}`,
      name: text(agent["name"]),
      backend: text(agent["backend"]),
      instance: text(agent["instance"]),
    })),
    ports: named("define_port").map((port) => ({
      id: `port::${text(port["name"])}`,
      name: text(port["name"]),
      kind: text(port["kind"]) as "input" | "output" | "action",
      type: text(port["type"]),
      delay: null,
      value: null,
      last_tag: null,
      instance: text(port["instance"]),
    })),
    timers: named("declare_timer").map((timer) => ({
      id: `timer::${text(timer["name"])}`,
      name: text(timer["name"]),
      offset: number(timer["offset"]),
      period: number(timer["period"]),
      last_tag: null,
      instance: text(timer["instance"]),
    })),
    reactions: named("install_reaction").map((reaction) => {
      const agent = text(reaction["agent"]);
      const order = orderWithin.get(agent) ?? 0;
      orderWithin.set(agent, order + 1);
      return {
        id: `reaction::${text(reaction["id"])}`,
        name: text(reaction["id"]),
        agent: `agent::${agent}`,
        order,
        // A trigger names a port or a timer, and the two have separate ids.
        triggers: asStrings(reaction["triggers"]).map((trigger) => (timers.has(trigger) ? `timer::${trigger}` : `port::${trigger}`)),
        effects: asStrings(reaction["effects"]).map((effect) => `port::${effect}`),
        contract: text(reaction["contract"]),
        status: "idle" as const,
        invocation_id: null,
        instance: text(reaction["instance"]),
        within: typeof reaction["within"] === "number" ? reaction["within"] : null,
      };
    }),
    edges: [
      ...named("connect_ports").map((connection) => ({
        id: `connection::${text(connection["source"])}::${text(connection["target"])}`,
        kind: "connection" as const,
        source: `port::${text(connection["source"])}`,
        target: `port::${text(connection["target"])}`,
        delay: typeof connection["delay"] === "number" ? connection["delay"] : null,
      })),
      ...named("install_reaction").flatMap((reaction) => {
        const id = text(reaction["id"]);
        return [
          ...asStrings(reaction["triggers"]).map((trigger) => ({
            id: `trigger::${trigger}::${id}`,
            kind: "trigger" as const,
            source: timers.has(trigger) ? `timer::${trigger}` : `port::${trigger}`,
            target: `reaction::${id}`,
            delay: null,
          })),
          ...asStrings(reaction["effects"]).map((effect) => ({
            id: `effect::${id}::${effect}`,
            kind: "effect" as const,
            source: `reaction::${id}`,
            target: `port::${effect}`,
            delay: null,
          })),
        ];
      }),
    ],
  };
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}
