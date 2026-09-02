import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";

import { parseDiagramSnapshot } from "../out/client/protocol.js";
import { fromBytecode } from "../out/diagram.js";

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

/** Sorted by id, and without the ordering the daemon assigns, so two sources compare. */
function normalise(snapshot) {
  const byId = (list) => [...list].sort((a, b) => a.id.localeCompare(b.id));
  return {
    team: snapshot.team,
    status: snapshot.status,
    instances: byId(snapshot.instances),
    agents: byId(snapshot.agents),
    ports: byId(snapshot.ports),
    timers: byId(snapshot.timers),
    reactions: byId(snapshot.reactions).map((reaction) => {
      const copy = { ...reaction };
      delete copy.order;
      return copy;
    }),
    edges: byId(snapshot.edges),
  };
}

describe("reading a snapshot out of bytecode", () => {
  // omarc compiled these; the daemon's /v1/programs/check drew the previews
  // from the same sources. The file must draw as the daemon would.
  for (const name of ["pipeline", "timer"]) {
    test(`${name}: the same picture the daemon previews`, () => {
      const mine = normalise(parseDiagramSnapshot(fromBytecode(load(`${name}.bytecode.json`))));
      const daemon = normalise(parseDiagramSnapshot(load(`${name}.preview.v1.json`)));
      assert.deepEqual(mine, daemon);
    });
  }

  test("a trigger points at a timer when the name is one", () => {
    const snapshot = fromBytecode(load("timer.bytecode.json"));
    const reaction = snapshot.reactions[0];
    assert.deepEqual(reaction.triggers, ["timer::beacon.t"]);
    assert.ok(snapshot.edges.some((edge) => edge.kind === "trigger" && edge.source === "timer::beacon.t"));
  });

  test("keeps the delay a connection carries, and none for a plain one", () => {
    const edges = fromBytecode(load("pipeline.bytecode.json")).edges.filter((edge) => edge.kind === "connection");
    assert.deepEqual(edges.map((edge) => edge.delay).sort(), [4_000_000_000, 8_000_000_000, null, null].sort());
  });

  test("numbers a reaction within its agent", () => {
    const snapshot = fromBytecode({
      team: "T",
      instructions: [
        { op: "spawn_agent", instance: "a", name: "a.x", backend: "Stub" },
        { op: "install_reaction", instance: "a", id: "a.reaction.0", agent: "a.x", triggers: [], effects: [] },
        { op: "install_reaction", instance: "a", id: "a.reaction.1", agent: "a.x", triggers: [], effects: [] },
      ],
    });
    assert.deepEqual(snapshot.reactions.map((reaction) => reaction.order), [0, 1]);
  });
});
