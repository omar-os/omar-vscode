import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";

import {
  applyDiagramEvent,
  isRunFinished,
  parseDiagramEvent,
  parseDiagramSnapshot,
  parseHealth,
  parseRunList,
  parseRunRecord,
} from "../out/client/protocol.js";

// Captured from a real `omar serve` run of tests/topology/src/Depths.omar.
const DEPTHS = JSON.parse(readFileSync(new URL("./fixtures/depths.v1.json", import.meta.url), "utf8"));

describe("reading what omar serve says", () => {
  test("accepts the daemon's health", () => {
    assert.deepEqual(parseHealth({ status: "ok", protocol_version: 1 }), {
      status: "ok",
      protocol_version: 1,
    });
  });

  test("refuses a protocol it does not speak", () => {
    assert.throws(() => parseHealth({ status: "ok", protocol_version: 2 }), /Unsupported serve protocol 2/);
    assert.throws(() => parseHealth({ hello: "world" }), /not from an OMAR runtime/);
  });

  test("accepts every status a run can have, stopped included", () => {
    // `omar stop` leaves a run "stopped". The web client's validator does not
    // know the word and throws; a stopped run has to draw here.
    for (const status of ["starting", "running", "completed", "stopped", "failed"]) {
      const record = parseRunRecord({ run_id: "r", team: "T", status });
      assert.equal(record.status, status);
    }
    assert.throws(() => parseRunRecord({ run_id: "r", team: "T", status: "paused" }), /Unsupported run status/);
  });

  test("knows which statuses are the end", () => {
    assert.deepEqual(
      ["starting", "running", "completed", "stopped", "failed"].map(isRunFinished),
      [false, false, true, true, true],
    );
  });

  test("fills in what an older daemon leaves out", () => {
    const record = parseRunRecord({ run_id: "r", team: "T", status: "running" });
    assert.deepEqual(record, {
      run_id: "r",
      team: "T",
      status: "running",
      diagram_address: null,
      started_at: 0,
      finished_at: null,
      error: null,
    });
  });

  test("reads the run list", () => {
    assert.equal(parseRunList({ runs: [{ run_id: "a", team: "T", status: "running" }] }).length, 1);
    assert.throws(() => parseRunList({}), /missing its runs/);
  });
});

describe("reading a diagram snapshot", () => {
  test("takes a real snapshot whole", () => {
    const snapshot = parseDiagramSnapshot(DEPTHS);
    assert.equal(snapshot.team, "program");
    assert.equal(snapshot.status, "running");
    assert.equal(snapshot.sequence, 10);
    assert.equal(snapshot.instances.length, 4);
    assert.equal(snapshot.agents.length, 4);
    assert.equal(snapshot.ports.length, 9);
    assert.equal(snapshot.reactions.length, 4);
    assert.equal(snapshot.edges.length, 13);
    assert.deepEqual(snapshot.current_tag, { timestamp: 0, microstep: 0 });
    assert.equal(typeof snapshot.lag, "number");
  });

  test("fills in what an older runtime leaves out, as null rather than zero", () => {
    // Unmeasured is not the same as none: a runtime that does not report lag
    // has not said the run is on time.
    const snapshot = parseDiagramSnapshot({
      protocol_version: 1,
      team: "T",
      ports: [{ id: "port::a", name: "a", kind: "input", type: "string" }],
      reactions: [{ id: "reaction::r", name: "r", agent: "agent::x", triggers: ["port::a"], effects: [] }],
      edges: [],
    });
    assert.equal(snapshot.lag, null);
    assert.deepEqual(snapshot.instances, []);
    assert.deepEqual(snapshot.timers, []);
    assert.equal(snapshot.ports[0].delay, null);
    assert.equal(snapshot.ports[0].last_tag, null);
    assert.equal(snapshot.reactions[0].within, null);
    assert.equal(snapshot.reactions[0].status, "idle");
    assert.equal(snapshot.reactions[0].invocation_id, null);
  });

  test("refuses a diagram protocol it does not speak", () => {
    assert.throws(() => parseDiagramSnapshot({ ...DEPTHS, protocol_version: 7 }), /Unsupported diagram protocol 7/);
  });
});

describe("folding events into the picture", () => {
  const snapshot = parseDiagramSnapshot(DEPTHS);
  const reaction = (state, id) => state.reactions.find((candidate) => candidate.id === id);
  const port = (state, name) => state.ports.find((candidate) => candidate.name === name);
  const event = (sequence, kind, payload, tag = { timestamp: 0, microstep: 0 }) =>
    parseDiagramEvent({ protocol_version: 1, sequence, team: "program", tag, kind, payload });

  test("a reaction starts, then completes with what it wrote", () => {
    const started = applyDiagramEvent(
      snapshot,
      event(11, "reaction_started", { reaction: "reaction::src.reaction.0", invocation_id: "inv-1" }),
    );
    assert.equal(reaction(started, "reaction::src.reaction.0").status, "running");
    assert.equal(reaction(started, "reaction::src.reaction.0").invocation_id, "inv-1");
    assert.equal(started.sequence, 11);

    const completed = applyDiagramEvent(
      started,
      event(12, "reaction_completed", { reaction: "reaction::src.reaction.0", invocation_id: "inv-1", writes: { "src.value": 7 } }),
    );
    assert.equal(reaction(completed, "reaction::src.reaction.0").status, "completed");
    assert.equal(reaction(completed, "reaction::src.reaction.0").invocation_id, null);
    assert.equal(port(completed, "src.value").value, 7);
  });

  test("a tag advance moves the clock and the ports it delivered to", () => {
    const tag = { timestamp: 2_000_000_000, microstep: 0 };
    const advanced = applyDiagramEvent(snapshot, event(11, "tag_advanced", { ports: { "near.value": 3 }, lag: 42 }, tag));
    assert.deepEqual(advanced.current_tag, tag);
    assert.equal(advanced.lag, 42);
    assert.equal(port(advanced, "near.value").value, 3);
    assert.deepEqual(port(advanced, "near.value").last_tag, tag);
  });

  test("a completed run has nothing still running", () => {
    const running = applyDiagramEvent(snapshot, event(11, "reaction_started", { reaction: "reaction::watch.reaction.0" }));
    const done = applyDiagramEvent(running, event(12, "run_completed", { outputs: {} }, null));
    assert.equal(done.status, "completed");
    assert.equal(reaction(done, "reaction::watch.reaction.0").status, "completed");
  });

  test("a failed run puts an interrupted reaction back to idle", () => {
    // It produced nothing, so claiming it completed would be a lie.
    const running = applyDiagramEvent(snapshot, event(11, "reaction_started", { reaction: "reaction::watch.reaction.0" }));
    const failed = applyDiagramEvent(running, event(12, "run_failed", { message: "boom" }, null));
    assert.equal(failed.status, "failed");
    assert.equal(reaction(failed, "reaction::watch.reaction.0").status, "idle");
  });

  test("does not touch the snapshot it was given", () => {
    const before = JSON.stringify(snapshot);
    applyDiagramEvent(snapshot, event(11, "reaction_started", { reaction: "reaction::src.reaction.0" }));
    assert.equal(JSON.stringify(snapshot), before);
  });

  test("refuses an event kind it does not know", () => {
    assert.throws(() => parseDiagramEvent({ sequence: 1, kind: "agent.teleported" }), /Unknown diagram event/);
  });
});
