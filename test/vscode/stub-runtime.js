// A stand-in for `omar serve` and one run's diagram server, on one port.
//
// Answers the way the real ones do, from a snapshot captured off a real run,
// so the extension under test talks to something shaped like the runtime
// without needing tmux, a compiler, or a model. CommonJS, because the
// extension host requires it.
const { createServer } = require("node:http");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const SNAPSHOT = readFileSync(join(__dirname, "..", "fixtures", "depths.v1.json"), "utf8");

function start() {
  const record = {
    run_id: "run-1",
    team: "program",
    status: "running",
    diagram_address: null,
    started_at: Math.floor(Date.now() / 1000) - 5,
    finished_at: null,
    error: null,
  };
  const server = createServer((request, response) => {
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify(body));
    };
    switch (request.url) {
      case "/health":
        return json(200, { status: "ok", protocol_version: 1 });
      case "/v1/runs":
        return json(200, { runs: [record] });
      case "/v1/runs/run-1":
        return json(200, record);
      case "/v1/diagram":
        response.writeHead(200, { "content-type": "application/json" });
        return response.end(SNAPSHOT);
      case "/v1/events":
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": connected\n\n");
        response.write(
          'id: 11\nevent: reaction_started\ndata: {"protocol_version":1,"sequence":11,"team":"program","tag":{"timestamp":0,"microstep":0},"kind":"reaction_started","payload":{"reaction":"reaction::watch.reaction.0","invocation_id":"inv-live"}}\n\n',
        );
        // Held open: the run is still going as far as this stub is concerned,
        // and the test wants to see the extension call the picture live.
        return;
      default:
        return json(404, { error: "not found" });
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      record.diagram_address = `127.0.0.1:${server.address().port}`;
      resolve({ url, close: () => server.close() });
    });
  });
}

module.exports = { start };
