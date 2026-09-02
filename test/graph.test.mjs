import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";

import { parseDiagramSnapshot } from "../out/client/protocol.js";
import { inspect } from "../out/model/inspect.js";
import { buildGraph } from "../out/topology/graph.js";

const load = (name) =>
  parseDiagramSnapshot(JSON.parse(readFileSync(new URL(`./fixtures/${name}.v1.json`, import.meta.url), "utf8")));

const inside = (node, box) =>
  node.x >= box.x && node.y >= box.y && node.x + node.width <= box.x + box.width && node.y + node.height <= box.y + box.height;
const overlap = (a, b) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("laying the picture out", () => {
  test("every node sits inside the box of its instance", () => {
    const graph = buildGraph(load("depths"));
    assert.equal(graph.boxes.length, 4);
    for (const node of graph.nodes) {
      const instance = node.id.split("::")[1].split(".")[0];
      const box = graph.boxes.find((candidate) => candidate.label === instance);
      assert.ok(inside(node, box), `${node.id} is inside ${box.label}`);
    }
  });

  test("a box inside a box is drawn inside it, and siblings do not overlap", () => {
    const graph = buildGraph(load("nested"));
    const run = graph.boxes.find((box) => box.label === "run");
    const draft = graph.boxes.find((box) => box.label === "run.draft");
    const refine = graph.boxes.find((box) => box.label === "run.refine");
    assert.equal(run.depth, 1);
    assert.equal(draft.depth, 2);
    assert.ok(inside(draft, run), "draft is inside run");
    assert.ok(inside(refine, run), "refine is inside run");
    assert.ok(!overlap(draft, refine), "draft and refine do not overlap");
    // brief -> draft -> refine -> reporter: left to right.
    assert.ok(draft.x < refine.x, "draft is left of refine");
    const brief = graph.nodes.find((node) => node.id === "port::run.brief");
    const reporter = graph.nodes.find((node) => node.id === "reaction::run.reaction.0");
    assert.ok(brief.x < draft.x, "the input is left of the first stage");
    assert.ok(refine.x + refine.width <= reporter.x, "the reporter is right of the last stage");
  });

  test("nodes in one box do not overlap each other", () => {
    for (const name of ["depths", "nested", "timer"]) {
      const graph = buildGraph(load(name));
      for (const a of graph.nodes) {
        for (const b of graph.nodes) {
          if (a !== b) assert.ok(!overlap(a, b), `${name}: ${a.id} overlaps ${b.id}`);
        }
      }
      assert.ok(graph.width > 0 && graph.height > 0);
      for (const node of graph.nodes) {
        assert.ok(node.x + node.width <= graph.width && node.y + node.height <= graph.height, `${name}: ${node.id} is within the drawing`);
      }
    }
  });

  test("a reaction is labelled by its agent and carries its status", () => {
    const graph = buildGraph(load("depths"));
    const watch = graph.nodes.find((node) => node.id === "reaction::watch.reaction.0");
    assert.equal(watch.label, "agent");
    assert.equal(watch.sublabel, "reaction.0");
    assert.equal(watch.status, "completed");
  });

  test("a timer is a node of its own, and a port with a value carries it", () => {
    const graph = buildGraph(load("timer"));
    assert.ok(graph.nodes.some((node) => node.kind === "timer" && node.label === "t"));
    const withValue = buildGraph(load("depths")).nodes.find((node) => node.id === "port::src.go");
    assert.equal(withValue.value, "1");
  });

  test("keeps every edge whose ends it drew", () => {
    const snapshot = load("nested");
    const graph = buildGraph(snapshot);
    assert.equal(graph.edges.length, snapshot.edges.length);
  });

  test("a runtime without instances draws everything at the top level", () => {
    const graph = buildGraph({ ...load("depths"), instances: [] });
    assert.equal(graph.boxes.length, 0);
    // Nine ports and four reactions; agents with reactions are not drawn twice.
    assert.equal(graph.nodes.length, 13);
  });
});

describe("inspecting one thing", () => {
  const snapshot = load("depths");
  const row = (inspection, label) => inspection.rows.find((candidate) => candidate.label === label)?.value;

  test("a reaction: status, agent, and what it reads and writes, with values", () => {
    const view = inspect(snapshot, "reaction::src.reaction.0");
    assert.equal(view.kind, "reaction");
    assert.equal(row(view, "Status"), "completed");
    assert.equal(row(view, "Agent"), "src.agent");
    assert.equal(row(view, "Backend"), "Stub");
    assert.equal(row(view, "Team"), "src");
    assert.equal(row(view, "Trigger src.go"), "1");
    assert.equal(row(view, "Effect src.value"), "none");
    assert.equal(row(view, "Contract"), "src.value");
    assert.equal(view.rows.find((candidate) => candidate.label === "Agent").ref, "agent::src.agent");
  });

  test("an agent: activity summarised from its reactions, which are listed", () => {
    const view = inspect(snapshot, "agent::watch.agent");
    assert.equal(row(view, "Activity"), "completed");
    assert.equal(row(view, "Reaction watch.reaction.0"), "completed");
  });

  test("a port: kind, type, value, and when it was written", () => {
    const view = inspect(snapshot, "port::src.go");
    assert.equal(row(view, "Kind"), "input");
    assert.equal(row(view, "Value"), "1");
    assert.equal(row(view, "Written at"), "0:0");
    assert.equal(row(inspect(snapshot, "port::src.value"), "Value"), "none");
  });

  test("an instance: its team, agents, and children", () => {
    const view = inspect(load("nested"), "instance::run");
    assert.equal(row(view, "Team"), "Pipeline");
    assert.equal(row(view, "Instance run.draft"), "Stage");
    assert.ok(view.rows.some((candidate) => candidate.label === "Agent run.reporter"));
    assert.equal(row(inspect(load("nested"), "instance::run.draft"), "Inside"), "run");
  });

  test("a timer: schedule and last firing", () => {
    const view = inspect(load("timer"), "timer::beacon.t");
    assert.equal(row(view, "Period"), "10ns");
    assert.equal(row(view, "Last fired"), "710ns:0");
  });

  test("something that is not there is null", () => {
    assert.equal(inspect(snapshot, "port::nope"), null);
  });
});
