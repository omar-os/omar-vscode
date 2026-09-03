/**
 * The outline of an `.omar` file: teams and main blocks, and inside them the
 * ports, timers, instances and prompts they declare.
 *
 * Read off the text by line, which is enough for an outline: the compiler
 * decides what the program means, this only says where things are. Nothing
 * here imports vscode, so it is tested with node.
 */

export type Symbol = {
  name: string;
  /** team, main, input, output, action, timer, instance, prompt */
  kind: string;
  detail: string;
  /** Zero-based line. */
  line: number;
  /** Zero-based columns of the name on that line. */
  from: number;
  to: number;
  /** Last line of the block, for a team or main; the same line otherwise. */
  end: number;
  children: Symbol[];
};

const BLOCK = /^\s*(team|main)\s+([A-Za-z_][\w]*)?/;
const PORT = /^\s*(input|output|action)\s+([A-Za-z_][\w.]*)\s*:\s*([^\s{]+)/;
const TIMER = /^\s*timer\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)/;
const INSTANCE = /^\s*([A-Za-z_][\w]*)\s*=\s*([A-Za-z_][\w]*)\s*\(/;
const PROMPT = /^\s*prompt\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)\s*->\s*([^\s"]+)/;

export function symbolsOf(text: string): Symbol[] {
  const lines = text.split("\n");
  const roots: Symbol[] = [];
  let block: Symbol | null = null;
  let depth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = BLOCK.exec(line);
    if (heading && depth === 0) {
      const name = heading[2] ?? (heading[1] === "main" ? "main" : "");
      const from = heading[2] ? line.indexOf(heading[2], heading[0].indexOf(heading[1]!)) : line.indexOf(heading[1]!);
      block = { name, kind: heading[1]!, detail: heading[1] === "team" ? agents(line) : "", line: index, from, to: from + name.length, end: index, children: [] };
      roots.push(block);
    } else if (block && depth > 0) {
      const child = childOf(line, index);
      if (child) block.children.push(child);
    }
    // Braces, outside strings: a prompt's body is a string and may hold any.
    for (const character of line.replace(/"[^"]*"?/g, "")) {
      if (character === "{") depth += 1;
      if (character === "}") {
        depth = Math.max(0, depth - 1);
        if (depth === 0 && block) {
          block.end = index;
          block = null;
        }
      }
    }
  }
  if (block) block.end = lines.length - 1;
  return roots;
}

function childOf(line: string, index: number): Symbol | null {
  // The name is looked for after the keyword, or `timer t` finds the t in
  // timer.
  const at = (name: string, keyword: string | null) => {
    const start = line.indexOf(name, keyword ? line.indexOf(keyword) + keyword.length : 0);
    return { line: index, from: start, to: start + name.length, end: index, children: [] as Symbol[] };
  };
  let match = PORT.exec(line);
  if (match) return { name: match[2]!, kind: match[1]!, detail: match[3]!, ...at(match[2]!, match[1]!) };
  match = TIMER.exec(line);
  if (match) return { name: match[1]!, kind: "timer", detail: `(${match[2]!.trim()})`, ...at(match[1]!, "timer") };
  match = PROMPT.exec(line);
  if (match) return { name: match[1]!, kind: "prompt", detail: `(${match[2]!.trim()}) -> ${match[3]!}`, ...at(match[1]!, "prompt") };
  match = INSTANCE.exec(line);
  if (match) return { name: match[1]!, kind: "instance", detail: match[2]!, ...at(match[1]!, null) };
  return null;
}

/** `team Review[editor : Codex, writer : Claude]` → `editor : Codex, writer : Claude`. */
function agents(line: string): string {
  const open = line.indexOf("[");
  const close = line.indexOf("]", open);
  return open >= 0 && close > open ? line.slice(open + 1, close).trim() : "";
}
