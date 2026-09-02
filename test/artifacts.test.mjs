import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";

import { parseDiagramSnapshot } from "../out/client/protocol.js";
import { activeEa, agentForLog, listArtifacts, programPath, topologyDir } from "../out/artifacts/store.js";

const DEPTHS = parseDiagramSnapshot(
  JSON.parse(readFileSync(new URL("./fixtures/depths.v1.json", import.meta.url), "utf8")),
);
const RUN = { run_id: "run-1", team: "program", status: "completed", diagram_address: null, started_at: 1000, finished_at: 1010, error: null };

/** A disk in a map: path to contents, directories implied by their files. */
function disk(entries) {
  const files = new Map(Object.entries(entries));
  return {
    async readDirectory(path) {
      const seen = new Map();
      for (const key of files.keys()) {
        if (!key.startsWith(`${path}/`)) continue;
        const rest = key.slice(path.length + 1);
        const head = rest.split("/")[0];
        seen.set(head, rest.includes("/") ? "directory" : "file");
      }
      return [...seen.entries()];
    },
    async stat(path) {
      const contents = files.get(path);
      return contents === undefined ? null : { mtime: 1005, size: contents.length };
    },
    async readFile(path) {
      return files.get(path) ?? null;
    },
  };
}

const D = "/home/x/.omar";
const T = `${D}/ea/0/topologies/program`;

describe("finding what a run wrote", () => {
  test("knows where the runtime keeps things", () => {
    assert.equal(topologyDir(D, "0", "program"), `${T}`);
    assert.equal(programPath(D, "0", "run-1"), `${D}/ea/0/serve/run-1/program.omar`);
  });

  test("reads the active EA, and takes 0 when nothing says", async () => {
    assert.equal(await activeEa(disk({ [`${D}/active_ea`]: "3\n" }), D), "3");
    assert.equal(await activeEa(disk({}), D), "0");
    assert.equal(await activeEa(disk({ [`${D}/active_ea`]: "garbage" }), D), "0");
  });

  test("matches a log to its agent by the runtime's own flattening", () => {
    assert.equal(agentForLog("watch_agent.txt", DEPTHS.agents), "agent::watch.agent");
    assert.equal(agentForLog("nobody.txt", DEPTHS.agents), null);
  });

  test("lists the program, results, logs and instructions, each with its producer", async () => {
    const files = disk({
      [`${D}/active_ea`]: "0",
      [`${D}/ea/0/serve/run-1/program.omar`]: "team T {}",
      [`${T}/deployment.json`]: JSON.stringify({ started_at: 1000 }),
      [`${T}/outputs.json`]: "{}",
      [`${T}/state.json`]: "{}",
      [`${T}/logs/watch_agent.txt`]: "log",
      [`${T}/logs/src_agent.txt`]: "log",
      [`${T}/agents/watch.agent/system.md`]: "You are",
    });
    const listing = await listArtifacts(files, D, RUN, DEPTHS);
    assert.equal(listing.directory, T);
    assert.equal(listing.caveat, null);
    assert.deepEqual(listing.groups.map((group) => group.label), ["Program", "Results", "Agent logs", "Agent instructions"]);
    const logs = listing.groups[2].artifacts;
    assert.deepEqual(logs.map((artifact) => artifact.name), ["src_agent.txt", "watch_agent.txt"]);
    assert.equal(logs[1].producer, "agent::watch.agent");
    assert.equal(listing.groups[3].artifacts[0].producer, "agent::watch.agent");
    assert.equal(listing.groups[0].artifacts[0].kind, "program");
    assert.equal(listing.groups[1].artifacts.length, 3);
  });

  test("says when nothing has been written yet", async () => {
    const listing = await listArtifacts(disk({}), D, RUN, DEPTHS);
    assert.equal(listing.directory, null);
    assert.deepEqual(listing.groups, []);
    assert.match(listing.caveat, /written nothing/);
  });

  test("warns when the directory belongs to a later run of the same team", async () => {
    // One directory per team: a rerun overwrites it, and the files then
    // describe the rerun, not the run being looked at.
    const files = disk({
      [`${T}/deployment.json`]: JSON.stringify({ started_at: 2000 }),
      [`${T}/outputs.json`]: "{}",
    });
    const listing = await listArtifacts(files, D, RUN, DEPTHS);
    assert.match(listing.caveat, /later run/);
    assert.equal(listing.groups[0].label, "Results");
  });

  test("still lists what it can without a snapshot", async () => {
    const files = disk({
      [`${T}/deployment.json`]: JSON.stringify({ started_at: 1000 }),
      [`${T}/logs/watch_agent.txt`]: "log",
    });
    const listing = await listArtifacts(files, D, RUN, null);
    assert.equal(listing.groups[0].artifacts[0].producer, null);
  });
});
