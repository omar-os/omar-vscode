import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What omarc said about a program, located in the file it was given. */
export type Problem = {
  message: string;
  /** Zero-based line the message points at. */
  line: number;
  /** Zero-based column range within that line. */
  from: number;
  to: number;
};

export type CompileResult =
  | { ok: true; bytecode: unknown; team: string }
  | { ok: false; problems: Problem[] };

/**
 * omarc reports `<path>: <message>` and nothing else — no line, no column.
 *
 * So the position has to be recovered from the message. Most of them name the
 * thing they are complaining about in quotes, and that name appears in the
 * source: finding it is a guess, but it is a guess that puts the squiggle under
 * the word the compiler is talking about rather than on line one. When there is
 * nothing to find, the whole first line carries it, which is at least honest
 * about not knowing.
 */
export function locate(message: string, source: string): Problem {
  const named = /'([^']+)'/.exec(message);
  const lines = source.split("\n");

  if (named?.[1]) {
    const needle = named[1];
    // The last segment: a qualified name like `flow.topic` is reported whole,
    // but the source says `topic` inside the team that declares it.
    const local = needle.slice(needle.lastIndexOf(".") + 1);
    for (const candidate of [needle, local]) {
      for (let line = 0; line < lines.length; line += 1) {
        const at = (lines[line] ?? "").indexOf(candidate);
        if (at >= 0) {
          return { message, line, from: at, to: at + candidate.length };
        }
      }
    }
  }

  return { message, line: 0, from: 0, to: (lines[0] ?? "").length };
}

/** Strip the path omarc echoes back, which the editor already knows. */
export function stripPath(raw: string, path: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith(`${path}: `) ? trimmed.slice(path.length + 2) : trimmed;
}

/**
 * Compile a program the way `omar run` would.
 *
 * The compiler is given a real file because it insists on a `.omar` extension
 * and names that file in its errors. Unsaved text is written to a scratch copy
 * so an editor can report on what is on screen rather than on what was last
 * saved.
 */
export async function compile(
  compilerPath: string,
  source: string,
  filename: string,
): Promise<CompileResult> {
  const directory = await mkdtemp(join(tmpdir(), "omar-vscode-"));
  const input = join(directory, filename.endsWith(".omar") ? filename : "program.omar");
  const output = join(directory, "bytecode.json");

  try {
    await writeFileAtomic(input, source);
    const failure = await run(compilerPath, [input, output]);
    if (failure !== null) {
      return {
        ok: false,
        problems: failure
          .split("\n")
          .map((line) => stripPath(line, input))
          .filter((line) => line.length > 0)
          .map((line) => locate(line, source)),
      };
    }
    const bytecode = JSON.parse(await readFile(output, "utf8")) as { team?: string };
    return { ok: true, bytecode, team: bytecode.team ?? "" };
  } catch (cause) {
    return {
      ok: false,
      problems: [locate(cause instanceof Error ? cause.message : String(cause), source)],
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, contents, "utf8");
}

/** Returns stderr when omarc rejected the program, or null when it did not. */
function run(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30_000 }, (error, _stdout, stderr) => {
      if (!error) return resolve(null);
      // A missing compiler is not a problem with the program, and saying so as
      // if it were would send someone looking in the wrong place.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return reject(
          new Error(
            `Could not run '${command}'. Set omar.compilerPath, or put omarc on PATH.`,
          ),
        );
      }
      resolve(stderr.trim() || error.message);
    });
  });
}
