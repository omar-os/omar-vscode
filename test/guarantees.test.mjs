import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";

import { parseDiagramSnapshot } from "../out/client/protocol.js";
import { countGuarantees, guaranteesFor, withRevision } from "../out/model/guarantees.js";

const DEPTHS = parseDiagramSnapshot(
  JSON.parse(readFileSync(new URL("./fixtures/depths.v1.json", import.meta.url), "utf8")),
);
const RUN = { run_id: "r", team: "program", status: "running", diagram_address: null, started_at: 1, finished_at: null, error: null };

describe("what the runtime guarantees, and what it does not", () => {
  test("nothing is proven, because nothing is", () => {
    const guarantees = guaranteesFor(RUN, DEPTHS, null);
    assert.equal(guarantees.filter((guarantee) => guarantee.status === "proven").length, 0);
    assert.ok(guarantees.every((guarantee) => guarantee.source === "catalogue"));
  });

  test("admission checks are enforced once a run exists", () => {
    const byId = Object.fromEntries(guaranteesFor(RUN, DEPTHS, "/x/program.omar").map((guarantee) => [guarantee.id, guarantee]));
    assert.equal(byId["typed-connections"].status, "enforced");
    assert.equal(byId["no-causality-loop"].status, "enforced");
    assert.ok(byId["typed-connections"].evidence.some((evidence) => evidence.type === "artifact" && evidence.uri === "/x/program.omar"));
    // But not before: a starting run has not been admitted yet.
    const starting = guaranteesFor({ ...RUN, status: "starting" }, DEPTHS, null);
    assert.equal(starting.find((guarantee) => guarantee.id === "typed-connections").status, "unchecked");
  });

  test("contracts are listed per reaction, and only when there are any", () => {
    const contracts = guaranteesFor(RUN, DEPTHS, null).find((guarantee) => guarantee.id === "effect-contracts");
    assert.equal(contracts.status, "enforced");
    assert.equal(contracts.details.length, 4);
    assert.deepEqual(contracts.subjects.sort(), DEPTHS.reactions.map((reaction) => reaction.id).sort());
    const none = guaranteesFor(RUN, { ...DEPTHS, reactions: DEPTHS.reactions.map((reaction) => ({ ...reaction, contract: "" })) }, null);
    assert.equal(none.find((guarantee) => guarantee.id === "effect-contracts"), undefined);
  });

  test("a deadline is monitored, not enforced: the runtime cannot make an agent answer", () => {
    const bounded = { ...DEPTHS, reactions: DEPTHS.reactions.map((reaction, index) => ({ ...reaction, within: index === 0 ? 5_000_000_000 : null })) };
    const deadlines = guaranteesFor(RUN, bounded, null).find((guarantee) => guarantee.id === "deadlines");
    assert.equal(deadlines.status, "monitored");
    assert.equal(deadlines.enforced, false);
    assert.deepEqual(deadlines.details, [["far.reaction.0", "within 5s"]]);
    assert.equal(guaranteesFor(RUN, DEPTHS, null).find((guarantee) => guarantee.id === "deadlines"), undefined);
  });

  test("isolation and termination are unchecked, and say what is actually the case", () => {
    const byId = Object.fromEntries(guaranteesFor(RUN, DEPTHS, null).map((guarantee) => [guarantee.id, guarantee]));
    assert.equal(byId["team-isolation"].status, "unchecked");
    assert.ok(byId["team-isolation"].details.some(([label, value]) => label === "Filesystem" && /shared/.test(value)));
    assert.ok(byId["team-isolation"].details.some(([label, value]) => label === "Credentials" && /disabled/.test(value)));
    assert.equal(byId["termination"].status, "unchecked");
  });

  test("counts by status", () => {
    const counts = countGuarantees(guaranteesFor(RUN, DEPTHS, null));
    assert.equal(counts.enforced, 4);
    assert.equal(counts.unchecked, 2);
    assert.equal(counts.proven, 0);
  });

  test("a proof for another revision makes the guarantee stale, not proven", () => {
    const proven = {
      id: "x", name: "x", status: "proven", property: "", how: "", source: "runtime", enforced: false, subjects: [], details: [],
      evidence: [{ type: "lean-proof", uri: "/proofs/x.lean", workflowRevision: "a93fc21", checker: "Lean" }],
    };
    assert.equal(withRevision(proven, "a93fc21").status, "proven");
    assert.equal(withRevision(proven, "bd2038f").status, "stale");
    assert.equal(withRevision(proven, null).status, "stale");
    // Only proofs go stale; an enforced guarantee has no revision to be stale against.
    assert.equal(withRevision({ ...proven, status: "enforced", evidence: [] }, "bd2038f").status, "enforced");
  });

  test("works without a snapshot", () => {
    const guarantees = guaranteesFor(RUN, null, null);
    assert.ok(guarantees.length >= 3);
  });
});
