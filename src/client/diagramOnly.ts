import { DiagramClient } from "./OmarClient";
import type { RunSource } from "./follow";
import type { DiagramSnapshot, RunRecord } from "./protocol";

/**
 * One diagram server with no daemon behind it, as `omar run --diagram-server`
 * exposes it. There is no run list and no record, so a record is read off the
 * snapshot: the team it names, and its status. Nothing here can change the
 * run.
 */
export function diagramOnlySource(url: string): { client: DiagramClient; recordOf: (snapshot: DiagramSnapshot) => RunRecord; source: RunSource } {
  const client = new DiagramClient(url);
  const recordOf = (snapshot: DiagramSnapshot): RunRecord => ({
    run_id: `diagram:${client.url}`,
    team: snapshot.team,
    status: snapshot.status === "completed" ? "completed" : snapshot.status === "failed" ? "failed" : "running",
    diagram_address: client.url.replace(/^https?:\/\//, ""),
    started_at: 0,
    finished_at: null,
    error: null,
  });
  return {
    client,
    recordOf,
    source: {
      record: async (signal) => recordOf(await client.snapshot(signal)),
      snapshot: (signal) => client.snapshot(signal),
      events: (signal, onOpen) => client.events(signal, onOpen),
    },
  };
}
