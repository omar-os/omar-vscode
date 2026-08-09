/**
 * The topology a program describes, and where to draw it.
 *
 * Two sources, one shape. A compiled program gives the structure and nothing
 * else; a running one adds what is happening — which reaction is working, what
 * value a port carries, where logical time has reached. The webview is written
 * against the shape, so it does not care which it was handed.
 */

export type Node = {
  id: string;
  kind: "agent" | "port" | "timer" | "reaction";
  label: string;
  /** The instance this belongs to, or "" at the top level. */
  instance: string;
  /** input, output, action — ports only. */
  role?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Live only: idle, running, or done. */
  status?: string;
  /** Live only: what the port carries. */
  value?: unknown;
};

export type Edge = {
  id: string;
  kind: "connection" | "trigger" | "effect";
  source: string;
  target: string;
  delay: number;
};

export type Topology = {
  team: string;
  nodes: Node[];
  edges: Edge[];
  width: number;
  height: number;
  /** Live only. */
  status?: string;
  tag?: { timestamp: number; microstep: number } | null;
};

type Instruction = Record<string, unknown>;

const COLUMN = 210;
const ROW = 54;
const PADDING = 28;

/**
 * Build a topology from compiled bytecode.
 *
 * The bytecode is a list of declarations, so the structure is read straight off
 * it rather than inferred: instances, agents, ports, timers, reactions, and the
 * three kinds of edge — a connection between ports, and a reaction's own
 * triggers and effects.
 */
export function fromBytecode(bytecode: unknown): Topology {
  const program = bytecode as { team?: string; instructions?: Instruction[] };
  const instructions = program.instructions ?? [];
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const named = (op: string) =>
    instructions.filter((instruction) => instruction["op"] === op);

  for (const port of named("define_port")) {
    nodes.push(bare(`port::${port["name"]}`, "port", String(port["name"]), port, String(port["kind"])));
  }
  for (const timer of named("declare_timer")) {
    nodes.push(bare(`timer::${timer["name"]}`, "timer", String(timer["name"]), timer));
  }
  for (const agent of named("spawn_agent")) {
    nodes.push(bare(`agent::${agent["name"]}`, "agent", String(agent["name"]), agent));
  }
  for (const reaction of named("install_reaction")) {
    const id = `reaction::${reaction["id"]}`;
    nodes.push(bare(id, "reaction", String(reaction["agent"] ?? reaction["id"]), reaction));
    // A trigger names a port or a timer, and the two have separate id spaces.
    for (const trigger of asStrings(reaction["triggers"])) {
      const source = instructions.some(
        (candidate) => candidate["op"] === "declare_timer" && candidate["name"] === trigger,
      )
        ? `timer::${trigger}`
        : `port::${trigger}`;
      edges.push({ id: `trigger::${trigger}::${reaction["id"]}`, kind: "trigger", source, target: id, delay: 0 });
    }
    for (const effect of asStrings(reaction["effects"])) {
      edges.push({ id: `effect::${reaction["id"]}::${effect}`, kind: "effect", source: id, target: `port::${effect}`, delay: 0 });
    }
  }
  for (const connection of named("connect_ports")) {
    edges.push({
      id: `connection::${connection["source"]}::${connection["target"]}`,
      kind: "connection",
      source: `port::${connection["source"]}`,
      target: `port::${connection["target"]}`,
      delay: Number(connection["delay"] ?? 0),
    });
  }

  return layout({ team: program.team ?? "", nodes, edges, width: 0, height: 0 });
}

/** Build a topology from a diagram server's snapshot, which already has state. */
export function fromSnapshot(snapshot: unknown): Topology {
  const source = snapshot as {
    team?: string;
    status?: string;
    current_tag?: { timestamp: number; microstep: number } | null;
    agents?: { id: string; name: string; instance: string }[];
    ports?: { id: string; name: string; kind: string; instance: string; value?: unknown }[];
    timers?: { id: string; name: string; instance: string }[];
    reactions?: { id: string; name: string; agent: string; instance: string; status?: string }[];
    edges?: { id: string; kind: string; source: string; target: string; delay: number }[];
  };

  const nodes: Node[] = [
    ...(source.ports ?? []).map((port) => ({
      id: port.id, kind: "port" as const, label: port.name, instance: port.instance,
      role: port.kind, value: port.value, x: 0, y: 0, width: 0, height: 0,
    })),
    ...(source.timers ?? []).map((timer) => ({
      id: timer.id, kind: "timer" as const, label: timer.name, instance: timer.instance,
      x: 0, y: 0, width: 0, height: 0,
    })),
    ...(source.agents ?? []).map((agent) => ({
      id: agent.id, kind: "agent" as const, label: agent.name, instance: agent.instance,
      x: 0, y: 0, width: 0, height: 0,
    })),
    ...(source.reactions ?? []).map((reaction) => ({
      id: reaction.id, kind: "reaction" as const, label: reaction.name, instance: reaction.instance,
      status: reaction.status, x: 0, y: 0, width: 0, height: 0,
    })),
  ];

  const edges: Edge[] = (source.edges ?? []).map((edge) => ({
    id: edge.id,
    kind: (edge.kind as Edge["kind"]) ?? "connection",
    source: edge.source,
    target: edge.target,
    delay: edge.delay ?? 0,
  }));

  return {
    ...layout({ team: source.team ?? "", nodes, edges, width: 0, height: 0 }),
    status: source.status,
    tag: source.current_tag ?? null,
  };
}

/**
 * Place nodes in columns by how far they are from something that starts.
 *
 * Longest-path layering: a node sits one column right of the furthest thing
 * that reaches it. It is what ELK's layered algorithm does at heart, and for a
 * dataflow graph it puts the picture in the order values travel — which is the
 * only thing the drawing has to get right to be worth looking at.
 */
export function layout(topology: Topology): Topology {
  const incoming = new Map<string, string[]>();
  for (const node of topology.nodes) incoming.set(node.id, []);
  for (const edge of topology.edges) {
    if (incoming.has(edge.target)) incoming.get(edge.target)!.push(edge.source);
  }

  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    // A feedback loop has no furthest source; stopping at the first repeat
    // keeps a ring from being infinitely deep.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const sources = incoming.get(id) ?? [];
    const value = sources.length === 0 ? 0 : Math.max(...sources.map(depthOf)) + 1;
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  for (const node of topology.nodes) depthOf(node.id);

  const columns = new Map<number, Node[]>();
  for (const node of topology.nodes) {
    const column = depth.get(node.id) ?? 0;
    if (!columns.has(column)) columns.set(column, []);
    columns.get(column)!.push(node);
  }

  let width = 0;
  let height = 0;
  for (const [column, members] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    members.sort((a, b) => a.label.localeCompare(b.label));
    members.forEach((node, index) => {
      node.width = node.kind === "reaction" ? 150 : 130;
      node.height = 30;
      node.x = PADDING + column * COLUMN;
      node.y = PADDING + index * ROW;
      width = Math.max(width, node.x + node.width + PADDING);
      height = Math.max(height, node.y + node.height + PADDING);
    });
  }

  return { ...topology, width, height };
}

function bare(
  id: string,
  kind: Node["kind"],
  label: string,
  instruction: Instruction,
  role?: string,
): Node {
  return {
    id,
    kind,
    label,
    instance: String(instruction["instance"] ?? ""),
    ...(role ? { role } : {}),
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  };
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}
