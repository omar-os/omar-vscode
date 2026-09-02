import type { DiagramSnapshot } from "../client/protocol";

/**
 * The diagram selects by component name — an id without its kind prefix —
 * because that is what the operator and the EA both call a thing. The
 * inspector works by id. These go between.
 */

/** `port::n1.out` is the component `n1.out`. */
export function componentName(id: string): string {
  const separator = id.indexOf("::");
  return separator === -1 ? id : id.slice(separator + 2);
}

/** The id behind a component name, looked up in the picture it came from. */
export function idOf(snapshot: DiagramSnapshot, component: string): string | null {
  const ids = [
    ...snapshot.reactions.map((reaction) => reaction.id),
    ...snapshot.ports.map((port) => port.id),
    ...snapshot.timers.map((timer) => timer.id),
    ...snapshot.agents.map((agent) => agent.id),
    ...snapshot.instances.map((instance) => instance.id),
  ];
  return ids.find((id) => componentName(id) === component) ?? null;
}
