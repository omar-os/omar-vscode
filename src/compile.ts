import { ServeClient } from "./client/OmarClient";
import type { DiagramSnapshot } from "./client/protocol";
import { fromBytecode } from "./diagram";
import { compile as omarc, locate, type Problem } from "./omarc";

/**
 * A program compiled, by whoever can.
 *
 * The daemon compiles and verifies a program on `POST /v1/programs/check`
 * and answers with the preview it would draw, so when one is connected it
 * does the work and nothing else needs to be installed beside the editor.
 * Without a daemon the compiler is run directly, and its bytecode read into
 * the same shape. Either way an error is positioned by the same guess.
 */

export type Compiled =
  | { ok: true; snapshot: DiagramSnapshot; by: "daemon" | "omarc" }
  | { ok: false; problems: Problem[]; by: "daemon" | "omarc" };

export async function compileProgram(
  source: string,
  filename: string,
  daemonUrl: string | null,
  compilerPath: string,
): Promise<Compiled> {
  const named = filename.endsWith(".omar") ? filename : "program.omar";
  if (daemonUrl) {
    try {
      const result = await new ServeClient(daemonUrl).checkProgram(source, named);
      if (result.ok) return { ok: true, snapshot: result.preview, by: "daemon" };
      return { ok: false, problems: result.errors.map((error) => locate(error, source)), by: "daemon" };
    } catch (cause) {
      // The daemon could not be asked; the compiler beside the editor, if any,
      // is the next best thing, and its own complaint stands if it is missing.
      const fallback = await omarc(compilerPath, source, named);
      if (fallback.ok) return { ok: true, snapshot: fromBytecode(fallback.bytecode), by: "omarc" };
      const why = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, problems: [locate(`The runtime could not check the program (${why}); ${fallback.problems[0]?.message ?? "and omarc is not available"}`, source)], by: "omarc" };
    }
  }
  const result = await omarc(compilerPath, source, named);
  if (result.ok) return { ok: true, snapshot: fromBytecode(result.bytecode), by: "omarc" };
  return { ok: false, problems: result.problems, by: "omarc" };
}
