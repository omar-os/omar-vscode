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
  const started = [];
  // The chat: the thread in memory, replayed to every subscriber, and an
  // assistant that answers at once — with a proposal when asked to propose.
  const chat = [];
  const subscribers = new Set();
  let sequence = 0;
  const publish = (message) => {
    const entry = { sequence: ++sequence, progress: false, design: null, selection: [], ...message };
    chat.push(entry);
    for (const stream of subscribers) writeChat(stream, entry);
    return entry;
  };
  const writeChat = (stream, entry) => {
    stream.write(`id: ${entry.sequence}\nevent: ${entry.design ? "design_proposed" : "message"}\ndata: ${JSON.stringify(entry)}\n\n`);
  };
  const server = createServer((request, response) => {
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const parsed = JSON.parse(body);
        if (request.url === "/v1/programs/check") {
          if (!parsed.program.includes("team")) return json(200, { ok: false, errors: ["expected a team"] });
          return json(200, { ok: true, open_inputs: ["src.go"], preview: JSON.parse(SNAPSHOT) });
        }
        if (request.url === "/v1/runs") {
          started.push(parsed);
          return json(201, { ...record, run_id: "run-2", started_at: record.started_at + 1 });
        }
        if (request.url === "/v1/chat") {
          if (!parsed.text || !parsed.text.trim()) return json(400, { error: "empty message" });
          const operator = publish({ role: "operator", text: parsed.text, selection: parsed.selection ?? [] });
          setTimeout(() => {
            publish({ role: "assistant", text: "Looking at it.", progress: true });
            if (/propose/i.test(parsed.text)) {
              publish({
                role: "assistant",
                text: "Here is a program that does that.",
                design: { program: "team T {}", inputs: { "src.go": 1 }, preview: JSON.parse(SNAPSHOT) },
              });
            } else {
              publish({ role: "assistant", text: `You said: ${parsed.text.split("\n").pop()}` });
            }
          }, 50);
          return json(202, operator);
        }
        if (request.url === "/v1/agent/backend") return json(200, { backend: parsed.backend, session: "ea-0" });
        json(404, { error: "not found" });
      });
      return;
    }
    switch (request.url) {
      case "/health":
        return json(200, { status: "ok", protocol_version: 1 });
      case "/v1/runs":
        return json(200, { runs: [record, ...started.map((_, index) => ({ ...record, run_id: `run-${index + 2}`, started_at: record.started_at + 1 }))] });
      case "/v1/runs/run-1":
        return json(200, record);
      case "/v1/chat":
        return json(200, { messages: chat });
      case "/v1/agent":
        return json(200, { backend: "claude", available: ["claude", "codex"] });
      case "/v1/chat/events": {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": connected\n\n");
        for (const entry of chat) writeChat(response, entry);
        subscribers.add(response);
        request.on("close", () => subscribers.delete(response));
        return;
      }
      case "/v1/runs/run-2":
        return json(200, { ...record, run_id: "run-2", started_at: record.started_at + 1 });
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
      resolve({ url, started, chat, close: () => { for (const stream of subscribers) stream.end(); server.close(); } });
    });
  });
}

module.exports = { start };
