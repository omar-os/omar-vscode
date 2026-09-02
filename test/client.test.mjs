import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test, { after, before, describe } from "node:test";

import { DiagramClient, ServeClient, diagramUrlFor, normalizeRuntimeUrl } from "../out/client/OmarClient.js";
import { RuntimeRefused, RuntimeUnreachable } from "../out/client/OmarClient.js";

const DEPTHS = readFileSync(new URL("./fixtures/depths.v1.json", import.meta.url), "utf8");

/** A stand-in for both servers, answering the way the real ones do. */
function stubRuntime() {
  const RECORD = { run_id: "run-1", team: "program", status: "running", diagram_address: "127.0.0.1:9", started_at: 1, finished_at: null, error: null };
  const server = createServer((request, response) => {
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify(body));
    };
    if (request.url === "/health") return json(200, { status: "ok", protocol_version: 1 });
    if (request.url === "/v1/runs" && request.method === "GET") return json(200, { runs: [RECORD] });
    if (request.url === "/v1/runs" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const { program } = JSON.parse(body);
        if (!program.includes("team")) return json(400, { error: "not a program" });
        json(201, { ...RECORD, run_id: "run-2" });
      });
      return;
    }
    if (request.url === "/v1/runs/run-1") return json(200, RECORD);
    if (request.url?.startsWith("/v1/runs/")) return json(404, { error: "unknown run" });
    if (request.url === "/v1/diagram") {
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(DEPTHS);
    }
    if (request.url === "/v1/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": connected\n\n");
      response.write('id: 11\nevent: reaction_started\ndata: {"protocol_version":1,"sequence":11,"team":"program","tag":null,"kind":"reaction_started","payload":{"reaction":"reaction::src.reaction.0"}}\n\n');
      response.write(": keepalive\n\n");
      response.write('id: 12\nevent: run_completed\ndata: {"protocol_version":1,"sequence":12,"team":"program","tag":null,"kind":"run_completed","payload":{"outputs":{}}}\n\n');
      return response.end();
    }
    json(404, { error: "not found" });
  });
  return server;
}

describe("talking to the runtime", () => {
  const server = stubRuntime();
  let url;
  before(async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test("normalises the address it is given", () => {
    assert.equal(normalizeRuntimeUrl(" http://127.0.0.1:7340/ "), "http://127.0.0.1:7340");
    assert.throws(() => normalizeRuntimeUrl("ftp://x"), /http or https/);
    assert.throws(() => normalizeRuntimeUrl("not a url"));
  });

  test("turns a run's diagram address into a URL", () => {
    assert.equal(diagramUrlFor({ diagram_address: "127.0.0.1:41903" }), "http://127.0.0.1:41903");
    assert.equal(diagramUrlFor({ diagram_address: null }), null);
  });

  test("reads health, runs and a record", async () => {
    const serve = new ServeClient(url);
    assert.equal((await serve.health()).protocol_version, 1);
    assert.equal((await serve.listRuns())[0].run_id, "run-1");
    assert.equal((await serve.getRun("run-1")).team, "program");
  });

  test("passes the daemon's refusal on, with its words", async () => {
    const serve = new ServeClient(url);
    await assert.rejects(serve.getRun("nope"), (error) => error instanceof RuntimeRefused && error.status === 404 && /unknown run/.test(error.message));
    await assert.rejects(serve.startRun({ program: "nonsense", inputs: {} }), /not a program/);
  });

  test("starts a run", async () => {
    const serve = new ServeClient(url);
    const record = await serve.startRun({ program: "team T {}", inputs: {}, fast: true });
    assert.equal(record.run_id, "run-2");
  });

  test("says when nothing is listening", async () => {
    const serve = new ServeClient("http://127.0.0.1:1");
    await assert.rejects(serve.health(), (error) => error instanceof RuntimeUnreachable);
  });

  test("reads the diagram and its events until the server closes the stream", async () => {
    const diagram = new DiagramClient(url);
    const snapshot = await diagram.snapshot();
    assert.equal(snapshot.reactions.length, 4);

    const kinds = [];
    for await (const event of diagram.events()) kinds.push(`${event.sequence}:${event.kind}`);
    assert.deepEqual(kinds, ["11:reaction_started", "12:run_completed"]);
  });

  test("stops reading when told to", async () => {
    const diagram = new DiagramClient(url);
    const abort = new AbortController();
    abort.abort();
    const kinds = [];
    for await (const event of diagram.events(abort.signal)) kinds.push(event.kind);
    assert.deepEqual(kinds, []);
  });
});
