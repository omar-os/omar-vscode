import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test, { after, before, describe } from "node:test";

import { ChatClient, parseChatMessage } from "../out/client/chat.js";
import { Thread } from "../out/chat/thread.js";
import { CONTEXT_BEGIN, CONTEXT_END, deploymentContext, withoutContext } from "../out/chat/context.js";
import { parseDiagramSnapshot } from "../out/client/protocol.js";

const SNAPSHOT = JSON.parse(readFileSync(new URL("./fixtures/depths.v1.json", import.meta.url), "utf8"));

/** A daemon's chat: a thread, replayed to every subscriber, and a scripted assistant. */
function stubChat() {
  const messages = [];
  const streams = new Set();
  let sequence = 0;
  let refuse = null;
  const write = (stream, entry) =>
    stream.write(`id: ${entry.sequence}\nevent: ${entry.design ? "design_proposed" : "message"}\ndata: ${JSON.stringify(entry)}\n\n`);
  const publish = (message) => {
    const entry = { sequence: ++sequence, progress: false, design: null, selection: [], ...message };
    messages.push(entry);
    for (const stream of streams) write(stream, entry);
    return entry;
  };
  const server = createServer((request, response) => {
    const json = (status, body) => {
      response.writeHead(status, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify(body));
    };
    if (request.url === "/v1/chat/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": connected\n\n");
      for (const entry of messages) write(response, entry);
      streams.add(response);
      request.on("close", () => streams.delete(response));
      return;
    }
    if (request.url === "/v1/chat" && request.method === "GET") return json(200, { messages });
    if (request.url === "/v1/agent") return json(200, { backend: "claude", available: ["claude"] });
    if (request.url === "/v1/chat" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        if (refuse) return json(502, { error: refuse });
        const { text, selection } = JSON.parse(body);
        json(202, publish({ role: "operator", text, selection }));
      });
      return;
    }
    json(404, { error: "not found" });
  });
  return {
    server,
    publish,
    messages,
    set refuse(value) {
      refuse = value;
    },
    dropStreams() {
      for (const stream of streams) stream.destroy();
      streams.clear();
    },
  };
}

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the thread with the assistant", () => {
  const daemon = stubChat();
  let url;
  before(async () => {
    await new Promise((resolve) => daemon.server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${daemon.server.address().port}`;
  });
  after(() => daemon.server.close());

  test("reads a message, and a proposal with its compiled preview", () => {
    const message = parseChatMessage({ sequence: 3, role: "assistant", text: "Here.", progress: false, design: { program: "team T {}", inputs: { a: 1 }, preview: SNAPSHOT }, selection: ["x"] });
    assert.equal(message.design.preview.team, "program");
    assert.deepEqual(message.design.inputs, { a: 1 });
    assert.deepEqual(parseChatMessage({ sequence: 1, role: "operator", text: "hi" }).selection, []);
    assert.throws(() => parseChatMessage({ sequence: 1, role: "system", text: "x" }), /Unsupported chat role/);
  });

  test("replays the backlog, places each message once, and follows what comes next", async () => {
    daemon.publish({ role: "assistant", text: "Hello." });
    const states = [];
    const thread = new Thread(new ChatClient(url), (state) => states.push(state), 10);
    thread.start();
    await settle();
    assert.equal(thread.current.connection, "live");
    assert.deepEqual(thread.current.messages.map((message) => message.text), ["Hello."]);

    assert.equal(await thread.send("Make me a workflow.", ["src.go"]), true);
    assert.equal(thread.current.drafting, true, "waiting for the assistant");
    daemon.publish({ role: "assistant", text: "Thinking…", progress: true });
    await settle();
    assert.equal(thread.current.drafting, true, "commentary does not end the wait");
    daemon.publish({ role: "assistant", text: "Here you are.", design: { program: "team T {}", inputs: {}, preview: SNAPSHOT } });
    await settle();
    assert.equal(thread.current.drafting, false, "a proposal does");
    assert.equal(thread.current.messages.length, 4);

    // The stream breaks; the daemon replays everything on reconnect, and
    // nothing is shown twice.
    daemon.dropStreams();
    await settle(30);
    assert.equal(thread.current.connection === "stale" || thread.current.connection === "connecting" || thread.current.connection === "live", true);
    await settle(100);
    assert.equal(thread.current.connection, "live");
    assert.equal(thread.current.messages.length, 4, "the replay changed nothing");
    assert.deepEqual(thread.current.messages.map((message) => message.sequence), [1, 2, 3, 4]);
    thread.stop();
    assert.equal(thread.current.connection, "off");
  });

  test("a refusal is kept in the daemon's words", async () => {
    daemon.refuse = "the executive assistant is not running; start it with `omar` first";
    const thread = new Thread(new ChatClient(url), () => {}, 10);
    assert.equal(await thread.send("hello", []), false);
    assert.match(thread.current.problem, /executive assistant is not running/);
    daemon.refuse = null;
  });

  test("names the assistant's backend", async () => {
    assert.deepEqual(await new ChatClient(url).assistant(), { backend: "claude", available: ["claude"] });
  });
});

describe("what the assistant is told about a deployment", () => {
  const snapshot = parseDiagramSnapshot(SNAPSHOT);
  const run = { run_id: "run-1", team: "program", status: "running", diagram_address: "127.0.0.1:1", started_at: 1000, finished_at: null, error: null };
  const live = {
    record: run,
    snapshot: { ...snapshot, reactions: snapshot.reactions.map((reaction, index) => ({ ...reaction, status: index === 0 ? "running" : "completed" })) },
    connection: "live",
    sequence: 10,
    detail: null,
    log: [
      { at: 1, kind: "event", event: { protocol_version: 1, sequence: 9, team: "program", tag: { timestamp: 0, microstep: 0 }, kind: "reaction_started", payload: { reaction: "reaction::watch.reaction.0" } } },
      { at: 2, kind: "note", text: "Connection lost: reset" },
    ],
  };
  const guarantees = [{ id: "a", name: "Connections are typed", status: "enforced" }, { id: "b", name: "Teams are isolated", status: "unchecked" }];
  const listing = { directory: "/x/topologies/program", revision: "abc", caveat: null, groups: [{ label: "Agent logs", artifacts: [{ name: "watch_agent.txt" }] }] };

  test("says what the runtime says, and nothing it does not", () => {
    const text = deploymentContext({ run, live, guarantees, listing, inspected: "port::src.go", nowSeconds: 1030 });
    assert.ok(text.startsWith(CONTEXT_BEGIN) && text.endsWith(CONTEXT_END));
    assert.match(text, /Deployment program \(run run-1\): RUNNING, elapsed 30s, picture LIVE, logical time 0:0/);
    assert.match(text, /far\.reaction\.0 — running; agent far\.agent \(Stub\); contract far\.relayed/);
    assert.match(text, /Port values:\n {2}src\.go = 1 \(written at 0:0\)/);
    assert.match(text, /#9 reaction_started watch\.reaction\.0 at 0:0/);
    assert.match(text, /note: Connection lost/);
    assert.match(text, /Guarantees: 1 enforced, 1 unchecked\. Connections are typed: enforced; Teams are isolated: unchecked/);
    assert.match(text, /Files on this machine: \/x\/topologies\/program \(agent logs: watch_agent\.txt\)/);
    assert.match(text, /inspecting: port::src\.go/);
  });

  test("says when there is no picture", () => {
    const text = deploymentContext({ run: { ...run, status: "completed" }, live: null, guarantees: [], listing: null, inspected: null, nowSeconds: 1030 });
    assert.match(text, /COMPLETED/);
    assert.match(text, /No picture of this deployment/);
  });

  test("is bounded, and says so", () => {
    const wide = { ...live, snapshot: { ...live.snapshot, ports: Array.from({ length: 400 }, (_, index) => ({ id: `port::p${index}`, name: `p${index}`, kind: "output", type: "string", value: "x".repeat(70), last_tag: null, delay: null, instance: "" })) } };
    const text = deploymentContext({ run, live: wide, guarantees: [], listing: null, inspected: null, nowSeconds: 1030 });
    assert.ok(text.length <= 6000);
    assert.match(text, /context cut at 6000/);
    assert.ok(text.endsWith(CONTEXT_END));
  });

  test("the operator's own words come back out", () => {
    const text = deploymentContext({ run, live, guarantees: [], listing: null, inspected: null, nowSeconds: 1030 });
    assert.deepEqual(withoutContext(`${text}\n\nWhy is watch idle?`), { text: "Why is watch idle?", hadContext: true });
    assert.deepEqual(withoutContext("plain"), { text: "plain", hadContext: false });
  });
});
