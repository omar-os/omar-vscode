import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";

import { followRun } from "../out/client/follow.js";
import { applyDiagramEvent, parseDiagramSnapshot } from "../out/client/protocol.js";

const DEPTHS = JSON.parse(readFileSync(new URL("./fixtures/depths.v1.json", import.meta.url), "utf8"));
const REACTIONS = ["src", "near", "far", "watch"].map((name) => `reaction::${name}.reaction.0`);

/**
 * A runtime that can be scripted: a run that emits N events, a stream that can
 * be cut at a chosen sequence, and a record that turns finished when told to.
 */
function fakeRuntime({ cutAt = Infinity, total = 8 } = {}) {
  const base = { ...parseDiagramSnapshot(DEPTHS), sequence: 1, status: "running" };
  for (const reaction of base.reactions) reaction.status = "idle";
  const events = [];
  let sequence = 1;
  for (let round = 0; round < total / 2; round += 1) {
    const reaction = REACTIONS[round % REACTIONS.length];
    events.push({ protocol_version: 1, sequence: ++sequence, team: "program", tag: { timestamp: 0, microstep: 0 }, kind: "reaction_started", payload: { reaction, invocation_id: `inv-${round}` } });
    events.push({ protocol_version: 1, sequence: ++sequence, team: "program", tag: { timestamp: 0, microstep: 0 }, kind: "reaction_completed", payload: { reaction, invocation_id: `inv-${round}`, writes: {} } });
  }
  events.push({ protocol_version: 1, sequence: ++sequence, team: "program", tag: null, kind: "run_completed", payload: { outputs: {} } });

  const runtime = {
    /** How far the runtime has actually got; the snapshot is built up to here. */
    reached: 1,
    record: { run_id: "run-1", team: "program", status: "running", diagram_address: "127.0.0.1:1", started_at: 1, finished_at: null, error: null },
    disconnects: 0,
    streamOpens: 0,
    snapshotFetches: 0,
    cut: cutAt,
    advanceTo(target) {
      runtime.reached = target;
    },
    source: {
      async record() {
        return runtime.record;
      },
      async snapshot() {
        runtime.snapshotFetches += 1;
        let snapshot = base;
        for (const event of events) {
          if (event.sequence > runtime.reached) break;
          snapshot = applyDiagramEvent(snapshot, event);
        }
        return snapshot;
      },
      async *events() {
        runtime.streamOpens += 1;
        // Everything already reached is not replayed: the stream carries only
        // what happens after it was opened.
        const from = runtime.reached;
        for (const event of events) {
          if (event.sequence <= from) continue;
          if (event.sequence > runtime.cut) {
            runtime.cut = Infinity;
            runtime.disconnects += 1;
            throw new Error("connection reset");
          }
          runtime.reached = event.sequence;
          if (event.kind === "run_completed") runtime.record = { ...runtime.record, status: "completed", finished_at: 2 };
          yield event;
        }
      },
    },
  };
  return runtime;
}

describe("following a run", () => {
  test("goes live after the snapshot, and final when the run ends", async () => {
    const runtime = fakeRuntime();
    const seen = [];
    const final = await followRun(runtime.record, runtime.source, { onChange: (state) => seen.push(state), retryMs: 1, settleMs: 1 }, new AbortController().signal);

    assert.equal(final.connection, "final");
    assert.equal(final.record.status, "completed");
    assert.equal(final.snapshot.status, "completed");
    assert.ok(seen.some((state) => state.connection === "live"), "was live at some point");
    assert.equal(seen[0].connection, "connecting");
  });

  test("reconciles after a disconnect without repeating or inventing a transition", async () => {
    // connected → events up to 5 → disconnect → the runtime reaches 7 while
    // nobody is listening → reconnect → the picture is right and nothing
    // that already happened is shown happening again.
    const runtime = fakeRuntime({ cutAt: 5, total: 8 });
    const seen = [];
    const transitions = [];
    let previous = null;
    const onChange = (state) => {
      seen.push(state);
      if (previous?.snapshot && state.snapshot) {
        for (const reaction of state.snapshot.reactions) {
          const before = previous.snapshot.reactions.find((candidate) => candidate.id === reaction.id);
          if (before.status !== reaction.status) transitions.push(`${reaction.id}:${before.status}->${reaction.status}`);
        }
      }
      previous = state;
    };
    const original = runtime.source.record;
    runtime.source.record = async () => {
      // While the client is away the run moves on.
      if (runtime.disconnects === 1 && runtime.reached < 7) runtime.advanceTo(7);
      return original();
    };

    const final = await followRun(runtime.record, runtime.source, { onChange, retryMs: 1, settleMs: 1 }, new AbortController().signal);

    assert.equal(runtime.disconnects, 1);
    assert.equal(runtime.streamOpens, 2);
    assert.ok(seen.some((state) => state.connection === "stale"), "said so while disconnected");
    assert.equal(final.connection, "final");
    assert.equal(final.snapshot.status, "completed");
    // Every reaction ran exactly once in the script, so each one goes idle →
    // running → completed at most once and never backwards.
    for (const id of REACTIONS) {
      const own = transitions.filter((entry) => entry.startsWith(id));
      assert.ok(own.length <= 2, `${id}: ${own.join(", ")}`);
      assert.ok(!own.includes(`${id}:completed->running`), `${id} went backwards`);
      assert.ok(!own.includes(`${id}:completed->idle`), `${id} was un-completed`);
    }
    const sequences = seen.map((state) => state.sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b), "the sequence never went backwards");

    // The log has every event that was seen, once, and says where it broke.
    const logged = final.log.filter((entry) => entry.kind === "event").map((entry) => entry.event.sequence);
    assert.deepEqual(logged, [...new Set(logged)], "no event is logged twice");
    assert.deepEqual(logged, [...logged].sort((a, b) => a - b), "the log is in order");
    assert.ok(final.log.some((entry) => entry.kind === "note" && /Connection lost/.test(entry.text)), "the break is noted");
  });

  test("a run that is already over is final at once, with no diagram to fetch", async () => {
    const runtime = fakeRuntime();
    runtime.record = { ...runtime.record, status: "stopped", finished_at: 2 };
    const seen = [];
    const final = await followRun(runtime.record, runtime.source, { onChange: (state) => seen.push(state) }, new AbortController().signal);
    assert.equal(final.connection, "final");
    assert.equal(final.snapshot, null);
    assert.equal(runtime.snapshotFetches, 0);
    assert.match(final.detail, /stopped/);
  });

  test("a stream that ends while the daemon still calls the run live is stale, not final", async () => {
    const runtime = fakeRuntime({ total: 4 });
    runtime.source.events = async function* () {
      // The server closed the stream with no terminal event.
    };
    const seen = [];
    const final = await followRun(runtime.record, runtime.source, { onChange: (state) => seen.push(state), settleMs: 1 }, new AbortController().signal);
    assert.equal(final.connection, "stale");
    assert.match(final.detail, /ended before the run did/);
  });

  test("stays stale while the runtime is unreachable and stops when told to", async () => {
    const runtime = fakeRuntime();
    runtime.source.snapshot = async () => {
      throw new Error("ECONNREFUSED");
    };
    runtime.source.record = async () => {
      throw new Error("ECONNREFUSED");
    };
    const seen = [];
    const abort = new AbortController();
    const done = followRun(runtime.record, runtime.source, { onChange: (state) => seen.push(state), retryMs: 1 }, abort.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    abort.abort();
    const final = await done;
    assert.equal(final.connection, "stale");
    assert.ok(seen.every((state) => state.connection !== "live"), "never claimed to be live");
    assert.match(final.detail, /ECONNREFUSED/);
  });

  test("gives up after the retries it was allowed", async () => {
    const runtime = fakeRuntime();
    let attempts = 0;
    runtime.source.snapshot = async () => {
      attempts += 1;
      throw new Error("down");
    };
    const final = await followRun(runtime.record, runtime.source, { onChange: () => {}, retryMs: 1, maxRetries: 3 }, new AbortController().signal);
    assert.equal(attempts, 3);
    assert.equal(final.connection, "stale");
  });
});
