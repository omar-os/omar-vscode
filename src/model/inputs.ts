/**
 * What an operator typed, as a value of the port's type.
 *
 * The runtime checks a value against its port and wants JSON: a number for
 * `int`, a boolean for `bool`, null for a `signal`. Sending the raw text
 * would fail every port that is not a string, with an error about a type the
 * operator never chose. `undefined` means the text cannot be read as the
 * type, which the prompt shows as a problem with that field rather than
 * sending and being refused.
 */
export function parseInputValue(type: string, text: string): unknown | undefined {
  const trimmed = text.trim();
  switch (type) {
    case "string":
    case "path":
    case "bytes":
      // Not trimmed: whitespace can be part of what was meant.
      return text;
    case "signal":
      return null;
    case "bool":
      if (trimmed === "true") return true;
      if (trimmed === "false") return false;
      return undefined;
    case "int":
      return /^-?\d+$/.test(trimmed) ? Number(trimmed) : undefined;
    case "float": {
      const value = Number(trimmed);
      return trimmed !== "" && Number.isFinite(value) ? value : undefined;
    }
    default:
      // `list<int>`, `option<string>` and friends are given as JSON.
      try {
        return JSON.parse(trimmed);
      } catch {
        return undefined;
      }
  }
}
