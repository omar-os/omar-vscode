import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";

import { parseDiagramSnapshot } from "../out/client/protocol.js";
import { inspect } from "../out/model/inspect.js";
import { componentName, idOf } from "../out/topology/components.js";

const load = (name) =>
  parseDiagramSnapshot(JSON.parse(readFileSync(new URL(`./fixtures/${name}.v1.json`, import.meta.url), "utf8")));

describe("naming what the diagram selects", () => {
  test("a component is its id without the kind", () => {
    assert.equal(componentName("port::n1.out"), "n1.out");
    assert.equal(componentName("n1.out"), "n1.out");
  });

  test("and the id is found again in the picture", () => {
    const snapshot = load("depths");
    assert.equal(idOf(snapshot, "watch.reaction.0"), "reaction::watch.reaction.0");
    assert.equal(idOf(snapshot, "src.go"), "port::src.go");
    assert.equal(idOf(snapshot, "far"), "instance::far");
    assert.equal(idOf(snapshot, "nobody"), null);
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
