import type { DiagramSnapshot, ReactionStatus } from "../client/protocol";

/**
 * The topology laid out for drawing, containers and all.
 *
 * A snapshot is flat: every port, timer, reaction and instance in its own
 * list, with names saying what belongs where. The picture is nested — an
 * instance is a box, and a team that instantiates teams is a box of boxes —
 * so the nesting is rebuilt here and each box is laid out on its own, in the
 * order values travel through it. Coordinates are absolute once done, so the
 * webview only draws.
 */

export type GraphNode = {
  id: string;
  kind: "port" | "timer" | "reaction" | "agent";
  label: string;
  /** Second line on a reaction: which reaction of the agent it is. */
  sublabel?: string;
  /** input, output, action — ports only. */
  role?: string;
  status?: ReactionStatus;
  /** A port carrying a value, as a short string; absent when it carries none. */
  value?: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type GraphBox = {
  id: string;
  label: string;
  /** The team declaration, shown after the name. */
  team: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Nesting depth, for shading. */
  depth: number;
};

export type GraphEdge = {
  id: string;
  kind: "connection" | "trigger" | "effect";
  source: string;
  target: string;
  delay: number | null;
};

export type Graph = {
  team: string;
  nodes: GraphNode[];
  boxes: GraphBox[];
  edges: GraphEdge[];
  width: number;
  height: number;
};

const NODE_HEIGHT = 28;
const PORT_WIDTH = 120;
const REACTION_WIDTH = 150;
const REACTION_HEIGHT = 40;
const GAP_X = 60;
const GAP_Y = 16;
const BOX_PADDING = 16;
const BOX_HEADER = 22;

/** Something a box lays out: a node of its own, or a child box. */
type Item =
  | { kind: "node"; node: GraphNode }
  | { kind: "box"; box: GraphBox; items: Item[]; edges: GraphEdge[] };

export function buildGraph(snapshot: DiagramSnapshot): Graph {
  const nodes = new Map<string, GraphNode>();
  for (const port of snapshot.ports) {
    nodes.set(port.id, {
      id: port.id,
      kind: "port",
      label: local(port.name),
      role: port.kind,
      ...(port.value !== null && port.value !== undefined ? { value: brief(port.value) } : {}),
      x: 0,
      y: 0,
      width: PORT_WIDTH,
      height: NODE_HEIGHT,
    });
  }
  for (const timer of snapshot.timers) {
    nodes.set(timer.id, {
      id: timer.id,
      kind: "timer",
      label: local(timer.name),
      x: 0,
      y: 0,
      width: PORT_WIDTH,
      height: NODE_HEIGHT,
    });
  }
  const agentName = new Map(snapshot.agents.map((agent) => [agent.id, agent.name]));
  const reacted = new Set<string>();
  for (const reaction of snapshot.reactions) {
    reacted.add(reaction.agent);
    nodes.set(reaction.id, {
      id: reaction.id,
      kind: "reaction",
      label: local(agentName.get(reaction.agent) ?? reaction.agent),
      sublabel: within(reaction.name, reaction.instance),
      status: reaction.status,
      x: 0,
      y: 0,
      width: REACTION_WIDTH,
      height: REACTION_HEIGHT,
    });
  }
  // An agent nothing prompts is still part of the team; it is drawn so the
  // picture matches the program, dashed because it never runs.
  for (const agent of snapshot.agents) {
    if (reacted.has(agent.id)) continue;
    nodes.set(agent.id, {
      id: agent.id,
      kind: "agent",
      label: local(agent.name),
      x: 0,
      y: 0,
      width: REACTION_WIDTH,
      height: NODE_HEIGHT,
    });
  }

  const edges: GraphEdge[] = snapshot.edges
    .filter((edge) => nodes.has(edge.source) && nodes.has(edge.target))
    .map((edge) => ({ id: edge.id, kind: edge.kind, source: edge.source, target: edge.target, delay: edge.delay }));

  // Which instance each node lives in, by name, and each instance's parent.
  const instanceOf = new Map<string, string>();
  for (const port of snapshot.ports) instanceOf.set(port.id, port.instance);
  for (const timer of snapshot.timers) instanceOf.set(timer.id, timer.instance);
  for (const agent of snapshot.agents) instanceOf.set(agent.id, agent.instance);
  for (const reaction of snapshot.reactions) instanceOf.set(reaction.id, reaction.instance);

  const root = assemble(snapshot, nodes, edges, instanceOf);
  const size = place(root, 0, 0);
  const graph: Graph = { team: snapshot.team, nodes: [], boxes: [], edges, width: size.width, height: size.height };
  collect(root, graph);
  return graph;
}

/** Build the tree of boxes, each holding its own nodes and its child boxes. */
function assemble(
  snapshot: DiagramSnapshot,
  nodes: Map<string, GraphNode>,
  edges: GraphEdge[],
  instanceOf: Map<string, string>,
): Item & { kind: "box" } {
  const byName = new Map(snapshot.instances.map((instance) => [instance.name, instance]));
  const boxes = new Map<string, Item & { kind: "box" }>();
  const rootBox: Item & { kind: "box" } = {
    kind: "box",
    box: { id: "instance::", label: snapshot.team, team: "", x: 0, y: 0, width: 0, height: 0, depth: 0 },
    items: [],
    edges: [],
  };
  for (const instance of snapshot.instances) {
    boxes.set(instance.id, {
      kind: "box",
      box: { id: instance.id, label: instance.name, team: instance.team, x: 0, y: 0, width: 0, height: 0, depth: 0 },
      items: [],
      edges: [],
    });
  }
  for (const instance of snapshot.instances) {
    const parent = (instance.parent && boxes.get(instance.parent)) || rootBox;
    const child = boxes.get(instance.id)!;
    child.box.depth = parent.box.depth + 1;
    parent.items.push(child);
  }
  // Nodes go in the box named by their instance; an unknown or empty name
  // goes at the top level, which is where a runtime without instances puts
  // everything.
  const containing = new Map<string, Item & { kind: "box" }>();
  for (const node of nodes.values()) {
    const name = instanceOf.get(node.id) ?? "";
    const instance = byName.get(name);
    const box = (instance && boxes.get(instance.id)) || rootBox;
    box.items.push({ kind: "node", node });
    containing.set(node.id, box);
  }
  // A box orders its items by the edges between them. An edge whose ends are
  // in different boxes is charged to the nearest box holding both, between
  // the two children that hold each end.
  const ancestors = (box: Item & { kind: "box" }): (Item & { kind: "box" })[] => {
    const chain: (Item & { kind: "box" })[] = [];
    let current: (Item & { kind: "box" }) | undefined = box;
    while (current) {
      chain.unshift(current);
      current = parentOf.get(current.box.id);
    }
    return chain;
  };
  const parentOf = new Map<string, Item & { kind: "box" }>();
  const index = (box: Item & { kind: "box" }) => {
    for (const item of box.items) {
      if (item.kind === "box") {
        parentOf.set(item.box.id, box);
        index(item);
      }
    }
  };
  index(rootBox);
  for (const edge of edges) {
    const from = ancestors(containing.get(edge.source)!);
    const to = ancestors(containing.get(edge.target)!);
    let shared = 0;
    while (shared < from.length && shared < to.length && from[shared] === to[shared]) shared += 1;
    const host = from[shared - 1]!;
    const sourceItem = shared < from.length ? from[shared]!.box.id : edge.source;
    const targetItem = shared < to.length ? to[shared]!.box.id : edge.target;
    if (sourceItem !== targetItem) {
      host.edges.push({ ...edge, source: sourceItem, target: targetItem });
    }
  }
  return rootBox;
}

/**
 * Lay a box out at (x, y): its items in columns by longest path from a
 * source, child boxes laid out first so their size is known. Returns the
 * box's size.
 */
function place(box: Item & { kind: "box" }, x: number, y: number): { width: number; height: number } {
  const ids = box.items.map((item) => (item.kind === "node" ? item.node.id : item.box.id));
  const incoming = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of box.edges) {
    // A reaction's effect edge points back at a port that may have fed it;
    // only connections and triggers order the columns, so a reaction lands
    // right of its triggers and an output port right of its reaction.
    incoming.get(edge.target)?.push(edge.source);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const sources = incoming.get(id) ?? [];
    const value = sources.length === 0 ? 0 : Math.max(...sources.map(depthOf)) + 1;
    visiting.delete(id);
    depth.set(id, value);
    return value;
  };
  for (const id of ids) depthOf(id);

  const columns = new Map<number, Item[]>();
  for (const item of box.items) {
    const id = item.kind === "node" ? item.node.id : item.box.id;
    const column = depth.get(id) ?? 0;
    if (!columns.has(column)) columns.set(column, []);
    columns.get(column)!.push(item);
  }

  const isRoot = box.box.depth === 0;
  const left = x + (isRoot ? BOX_PADDING : BOX_PADDING);
  const top = y + (isRoot ? BOX_PADDING : BOX_HEADER + BOX_PADDING);
  let cursorX = left;
  let width = 0;
  let height = 0;
  for (const [, members] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    members.sort((a, b) => label(a).localeCompare(label(b)));
    let cursorY = top;
    let columnWidth = 0;
    for (const item of members) {
      if (item.kind === "node") {
        item.node.x = cursorX;
        item.node.y = cursorY;
        cursorY += item.node.height + GAP_Y;
        columnWidth = Math.max(columnWidth, item.node.width);
      } else {
        const size = place(item, cursorX, cursorY);
        cursorY += size.height + GAP_Y;
        columnWidth = Math.max(columnWidth, size.width);
      }
    }
    height = Math.max(height, cursorY - GAP_Y - top);
    cursorX += columnWidth + GAP_X;
    width = cursorX - GAP_X - left;
  }
  box.box.x = x;
  box.box.y = y;
  box.box.width = width + 2 * BOX_PADDING;
  box.box.height = height + BOX_PADDING + (isRoot ? BOX_PADDING : BOX_HEADER + BOX_PADDING);
  return { width: box.box.width, height: box.box.height };
}

function collect(box: Item & { kind: "box" }, graph: Graph): void {
  if (box.box.depth > 0) graph.boxes.push(box.box);
  for (const item of box.items) {
    if (item.kind === "node") graph.nodes.push(item.node);
    else collect(item, graph);
  }
}

function label(item: Item): string {
  return item.kind === "node" ? item.node.label : item.box.label;
}

/** `run.draft.reaction.0` is `reaction.0` inside the `run.draft` box. */
function within(name: string, instance: string): string {
  return instance && name.startsWith(`${instance}.`) ? name.slice(instance.length + 1) : name;
}

/** `review.evidence.finding` is `finding` inside its box. */
function local(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1);
}

function brief(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}
