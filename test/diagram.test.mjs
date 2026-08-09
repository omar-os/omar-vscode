import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { fromBytecode, fromSnapshot, layout } from "../out/diagram.js";

const BYTECODE = {
  version: 1,
  team: "Flow",
  instructions: [
    { op: "begin_plan", team: "Flow" },
    { op: "declare_instance", name: "flow", parent: "", team: "Flow" },
    { op: "spawn_agent", instance: "flow", name: "flow.writer", backend: "Codex" },
    { op: "define_port", instance: "flow", kind: "input", name: "flow.topic", type: "string" },
    { op: "define_port", instance: "flow", kind: "output", name: "flow.blurb", type: "string" },
    { op: "declare_timer", instance: "flow", name: "flow.tick", offset: 1, period: 0 },
    {
      op: "install_reaction", instance: "flow", id: "flow.reaction.0", agent: "flow.writer",
      triggers: ["flow.topic", "flow.tick"], effects: ["flow.blurb"],
      contract: "flow.blurb", prompt: "p",
    },
    { op: "connect_ports", source: "flow.blurb", target: "flow.topic", delay: 2 },
    { op: "commit_plan" },
  ],
};

describe("reading a topology out of bytecode", () => {
  const topology = fromBytecode(BYTECODE);

  test("takes the structure from the declarations", () => {
    assert.equal(topology.team, "Flow");
    const kinds = topology.nodes.reduce((counts, node) => {
      counts[node.kind] = (counts[node.kind] ?? 0) + 1;
      return counts;
    }, {});
    assert.deepEqual(kinds, { port: 2, timer: 1, agent: 1, reaction: 1 });
  });

  test("a trigger points at a timer when the name is one", () => {
    // Ports and timers have separate id spaces, so which one a trigger names
    // has to be decided here rather than guessed from the string.
    const triggers = topology.edges.filter((edge) => edge.kind === "trigger");
    const sources = triggers.map((edge) => edge.source).sort();
    assert.deepEqual(sources, ["port::flow.topic", "timer::flow.tick"]);
  });

  test("keeps the delay a connection carries", () => {
    const connection = topology.edges.find((edge) => edge.kind === "connection");
    assert.equal(connection.delay, 2);
  });
});

describe("placing it", () => {
  test("puts a node right of everything that reaches it", () => {
    const topology = layout({
      team: "T",
      nodes: ["a", "b", "c"].map((id) => ({
        id, kind: "port", label: id, instance: "", x: 0, y: 0, width: 0, height: 0,
      })),
      edges: [
        { id: "1", kind: "connection", source: "a", target: "b", delay: 0 },
        { id: "2", kind: "connection", source: "b", target: "c", delay: 0 },
      ],
      width: 0,
      height: 0,
    });
    const at = (id) => topology.nodes.find((node) => node.id === id).x;

    assert.ok(at("a") < at("b"), "b is right of a");
    assert.ok(at("b") < at("c"), "c is right of b");
    assert.ok(topology.width > at("c"), "the drawing is wide enough to hold it");
  });

  test("a ring is finite", () => {
    // A feedback loop has no furthest source. Without a guard this never
    // returns, so the test is that it does.
    const topology = layout({
      team: "Ring",
      nodes: ["a", "b"].map((id) => ({
        id, kind: "port", label: id, instance: "", x: 0, y: 0, width: 0, height: 0,
      })),
      edges: [
        { id: "1", kind: "connection", source: "a", target: "b", delay: 0 },
        { id: "2", kind: "connection", source: "b", target: "a", delay: 0 },
      ],
      width: 0,
      height: 0,
    });
    assert.equal(topology.nodes.length, 2);
    assert.ok(topology.width > 0);
  });
});

describe("following a run", () => {
  test("carries what is happening on top of what exists", () => {
    const topology = fromSnapshot({
      team: "Flow",
      status: "running",
      current_tag: { timestamp: 3, microstep: 1 },
      ports: [
        { id: "port::flow.topic", name: "flow.topic", kind: "input", instance: "flow", value: "hi" },
      ],
      timers: [],
      agents: [{ id: "agent::flow.writer", name: "flow.writer", instance: "flow" }],
      reactions: [
        {
          id: "reaction::flow.reaction.0", name: "flow.reaction.0",
          agent: "agent::flow.writer", instance: "flow", status: "running",
        },
      ],
      edges: [],
    });

    assert.equal(topology.status, "running");
    assert.deepEqual(topology.tag, { timestamp: 3, microstep: 1 });
    assert.equal(topology.nodes.find((node) => node.kind === "port").value, "hi");
    assert.equal(topology.nodes.find((node) => node.kind === "reaction").status, "running");
  });
});
