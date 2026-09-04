import assert from "node:assert/strict";
import { createServer } from "node:net";
import test, { describe } from "node:test";

import { serveSpec, startServe, waitFor } from "../out/runtime/serve.js";
import { installCommandFor, isMissingBinary } from "../out/runtime/install.js";

const FAKE = new URL("./fixtures/fake-omar", import.meta.url).pathname;

async function freePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

describe("starting the runtime", () => {
  test("only a loopback address is ours to start", () => {
    assert.equal(serveSpec("http://127.0.0.1:7340", "omar", [], "omarc").address, "127.0.0.1:7340");
    assert.equal(serveSpec("http://localhost:7340", "omar", [], "omarc").address, "127.0.0.1:7340");
    assert.equal(serveSpec("http://10.0.0.5:7340", "omar", [], "omarc").address, null);
    assert.equal(serveSpec("not a url", "omar", [], "omarc").address, null);
  });

  test("hands a configured compiler path to the daemon, and a bare name to PATH", () => {
    assert.equal(serveSpec("http://127.0.0.1:1", "omar", [], "/opt/omar/omarc").omarcPath, "/opt/omar/omarc");
    assert.equal(serveSpec("http://127.0.0.1:1", "omar", [], "omarc").omarcPath, null);
  });

  test("refuses to start a runtime that is not on loopback", () => {
    assert.throws(() => startServe(serveSpec("http://10.0.0.5:7340", "omar", [], "omarc"), () => {}), /loopback/);
  });

  test("starts the daemon, waits for it to answer, relays its output, and stops it", async () => {
    const port = await freePort();
    const lines = [];
    const handle = startServe(serveSpec(`http://127.0.0.1:${port}`, FAKE, ["--no-ea"], "omarc"), (line) => lines.push(line));
    const up = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (!response.ok) throw new Error("not yet");
    }, 10_000);
    assert.equal(up, true);
    assert.ok(lines.some((line) => /OMAR serve: http/.test(line)), `the daemon's own words are relayed: ${lines.join(" | ")}`);
    assert.match(lines[0], /serve --address 127\.0\.0\.1:\d+ --no-ea/);
    handle.process.kill("SIGTERM");
    assert.match(await handle.exited, /code 0|signal SIGTERM/);
  });

  test("a daemon that cannot start is reported, not waited for", async () => {
    const lines = [];
    const handle = startServe(serveSpec("http://127.0.0.1:1", "/nonexistent/omar", [], "omarc"), (line) => lines.push(line));
    assert.match(await handle.exited, /error: .*ENOENT/);
  });

  test("waitFor gives up when nothing answers", async () => {
    assert.equal(await waitFor(async () => { throw new Error("down"); }, 300, 50), false);
  });
});

describe("installing the runtime", () => {
  test("the installer goes where it goes", () => {
    assert.match(installCommandFor("darwin"), /curl -fsSL https:\/\/omar\.rs\/install\.sh \| sh/);
    assert.equal(installCommandFor("linux"), installCommandFor("darwin"));
    assert.equal(installCommandFor("win32"), null);
  });

  test("a missing binary is told from one that would not run", () => {
    assert.equal(isMissingBinary("error: spawn omar ENOENT"), true);
    assert.equal(isMissingBinary("code 1"), false);
  });
});
