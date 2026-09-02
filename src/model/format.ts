/** Numbers as a reader wants them; the runtime gives nanoseconds and Unix seconds. */

const UNITS: [number, string][] = [
  [3_600_000_000_000, "h"],
  [60_000_000_000, "min"],
  [1_000_000_000, "s"],
  [1_000_000, "ms"],
  [1_000, "µs"],
  [1, "ns"],
];

/**
 * Nanoseconds in the largest unit that divides them exactly. `1500ms` rather
 * than `1.5s`: exact, so nothing is rounded away from a delay the program
 * declared.
 */
export function formatNanos(nanos: number | null): string {
  if (nanos === null || !Number.isFinite(nanos)) return "—";
  if (nanos === 0) return "0";
  if (nanos < 0) return `-${formatNanos(-nanos)}`;
  const [scale, unit] = UNITS.find(([size]) => nanos % size === 0) ?? UNITS[UNITS.length - 1]!;
  return `${nanos / scale}${unit}`;
}

/** A span of seconds as `17m 42s`, `1h 03m`, or `8s`. */
export function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  return `${rest}s`;
}

/** Unix seconds as local `HH:MM:SS`. */
export function formatClock(unixSeconds: number): string {
  if (!unixSeconds) return "—";
  const date = new Date(unixSeconds * 1000);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

/** A logical tag as `2s:0`. */
export function formatTag(tag: { timestamp: number; microstep: number } | null): string {
  return tag ? `${formatNanos(tag.timestamp)}:${tag.microstep}` : "—";
}
