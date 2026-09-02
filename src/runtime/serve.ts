import { spawn, type ChildProcess } from "node:child_process";

/**
 * Starting `omar serve` when nothing is listening.
 *
 * The daemon is the runtime's; the extension only runs it, as a child, with
 * the address the extension will then connect to, and hands whatever it
 * prints to a log. It is started only for a loopback address — a daemon on
 * another machine is not this extension's to start — and stopped when the
 * extension is. Nothing here imports vscode, so it is tested with node.
 */

export type ServeSpec = {
  cliPath: string;
  /** `host:port` for `--address`, or null when the URL is not loopback. */
  address: string | null;
  args: string[];
  /** Set as OMARC_BIN so the daemon finds the compiler the extension is configured with. */
  omarcPath: string | null;
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** What to run for a runtime URL; `address` is null when it is not ours to start. */
export function serveSpec(url: string, cliPath: string, args: string[], compilerPath: string): ServeSpec {
  let address: string | null = null;
  try {
    const parsed = new URL(url);
    if (LOOPBACK.has(parsed.hostname)) {
      address = `${parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
    }
  } catch {
    address = null;
  }
  // A bare name is found on PATH by the daemon itself; a path is handed over.
  const omarcPath = compilerPath.includes("/") ? compilerPath : null;
  return { cliPath, address, args, omarcPath };
}

export type ServeHandle = {
  process: ChildProcess;
  /** Resolves when the daemon exits, with its code or the signal that ended it. */
  exited: Promise<string>;
};

export function startServe(spec: ServeSpec, log: (line: string) => void): ServeHandle {
  if (!spec.address) throw new Error("Only a runtime on a loopback address is started here.");
  const env = { ...process.env, ...(spec.omarcPath ? { OMARC_BIN: spec.omarcPath } : {}) };
  const child = spawn(spec.cliPath, ["serve", "--address", spec.address, ...spec.args], { env, stdio: ["ignore", "pipe", "pipe"] });
  log(`$ ${spec.cliPath} serve --address ${spec.address} ${spec.args.join(" ")}`.trim());
  const relay = (stream: NodeJS.ReadableStream | null) => {
    let rest = "";
    stream?.on("data", (chunk: Buffer) => {
      rest += chunk.toString();
      const lines = rest.split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) log(line);
    });
    stream?.on("end", () => {
      if (rest) log(rest);
    });
  };
  relay(child.stdout);
  relay(child.stderr);
  const exited = new Promise<string>((resolve) => {
    child.on("error", (error) => {
      log(`could not start: ${error.message}`);
      resolve(`error: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      const how = signal ? `signal ${signal}` : `code ${code}`;
      log(`omar serve exited with ${how}`);
      resolve(how);
    });
  });
  return { process: child, exited };
}

/** Poll `health` until it answers or the time is up. */
export async function waitFor(health: () => Promise<unknown>, timeoutMs: number, stepMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await health();
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
  }
  return false;
}
