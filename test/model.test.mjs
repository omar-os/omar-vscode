import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";

import { parseDiagramSnapshot } from "../out/client/protocol.js";
import { activityOf, agentViews, countsOf, elapsedOf, statusOf, teamViews } from "../out/model/deployment.js";
import { formatClock, formatElapsed, formatNanos, formatTag } from "../out/model/format.js";

const DEPTHS = parseDiagramSnapshot(
  JSON.parse(readFileSync(new URL("./fixtures/depths.v1.json", import.meta.url), "utf8")),
);

describe("arranging a run for reading", () => {
  test("puts each agent in the instance it names, with its reactions under it", () => {
    const teams = teamViews(DEPTHS);
    assert.deepEqual(teams.map((team) => team.name).sort(), ["far", "near", "src", "watch"]);
    const watch = teams.find((team) => team.name === "watch");
    assert.equal(watch.team, "Watcher");
    assert.equal(watch.agents.length, 1);
    assert.equal(watch.agents[0].reactions[0].id, "reaction::watch.reaction.0");
  });

  test("nests an instance inside its parent", () => {
    const nested = {
      ...DEPTHS,
      instances: [
        { id: "instance::outer", name: "outer", team: "Outer", parent: "" },
        { id: "instance::outer.inner", name: "outer.inner", team: "Inner", parent: "instance::outer" },
      ],
      agents: [{ id: "agent::outer.inner.a", name: "outer.inner.a", backend: "Stub", instance: "outer.inner" }],
      reactions: [],
    };
    const teams = teamViews(nested);
    assert.equal(teams.length, 1);
    assert.equal(teams[0].children[0].name, "outer.inner");
    assert.equal(teams[0].children[0].agents[0].name, "outer.inner.a");
  });

  test("a runtime without instances gives one team named after the program", () => {
    const flat = { ...DEPTHS, instances: [] };
    const teams = teamViews(flat);
    assert.equal(teams.length, 1);
    assert.equal(teams[0].name, "program");
    assert.equal(teams[0].agents.length, 4);
  });

  test("an agent's activity summarises its reactions and nothing else", () => {
    const reaction = (status) => ({ status });
    assert.equal(activityOf([]), "idle");
    assert.equal(activityOf([reaction("idle")]), "idle");
    assert.equal(activityOf([reaction("running"), reaction("completed")]), "running");
    assert.equal(activityOf([reaction("completed"), reaction("completed")]), "completed");
    assert.equal(activityOf([reaction("completed"), reaction("idle")]), "idle");
  });

  test("counts what the snapshot holds", () => {
    const counts = countsOf(DEPTHS);
    assert.deepEqual(counts, { teams: 4, agents: 4, reactions: 4, running: 0, completed: 4, idle: 0 });
    assert.equal(countsOf(null).agents, 0);
    assert.equal(agentViews(DEPTHS).every((agent) => agent.activity === "completed"), true);
  });

  test("takes the run's status from the daemon, and from the picture when it is ahead", () => {
    const record = { run_id: "r", team: "T", status: "running", diagram_address: null, started_at: 1, finished_at: null, error: null };
    assert.equal(statusOf(record, null), "running");
    assert.equal(statusOf(record, { snapshot: { status: "completed" } }), "completed");
    assert.equal(statusOf(record, { snapshot: { status: "failed" } }), "failed");
    // But never the other way: a daemon that says stopped is not overruled.
    assert.equal(statusOf({ ...record, status: "stopped" }, { snapshot: { status: "running" } }), "stopped");
  });

  test("measures elapsed to the end when there is one, to now when there is not", () => {
    const record = { started_at: 100, finished_at: 160 };
    assert.equal(elapsedOf(record, 1000), 60);
    assert.equal(elapsedOf({ started_at: 100, finished_at: null }, 130), 30);
  });
});

describe("formatting numbers", () => {
  test("nanoseconds in the largest exact unit", () => {
    assert.equal(formatNanos(0), "0");
    assert.equal(formatNanos(1_500_000_000), "1500ms");
    assert.equal(formatNanos(2_000_000_000), "2s");
    assert.equal(formatNanos(120_000_000_000), "2min");
    assert.equal(formatNanos(null), "—");
  });

  test("elapsed seconds as a reader wants them", () => {
    assert.equal(formatElapsed(8), "8s");
    assert.equal(formatElapsed(1062), "17m 42s");
    assert.equal(formatElapsed(3780), "1h 03m");
    assert.equal(formatElapsed(-1), "—");
  });

  test("a tag as time and microstep", () => {
    assert.equal(formatTag({ timestamp: 2_000_000_000, microstep: 1 }), "2s:1");
    assert.equal(formatTag(null), "—");
  });

  test("a clock with no start is a dash", () => {
    assert.equal(formatClock(0), "—");
    assert.match(formatClock(1_700_000_000), /^\d\d:\d\d:\d\d$/);
  });
});
