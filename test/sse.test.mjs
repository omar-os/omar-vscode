import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { SseParser } from "../out/client/sse.js";

describe("cutting a stream into frames", () => {
  test("reads a frame the way the diagram server writes one", () => {
    const parser = new SseParser();
    const frames = parser.feed('id: 3\nevent: reaction_started\ndata: {"sequence":3}\n\n');
    assert.deepEqual(frames, [{ id: "3", event: "reaction_started", data: '{"sequence":3}' }]);
  });

  test("holds a frame until its blank line, across chunks", () => {
    // A chunk boundary can land anywhere, including inside a field name.
    const parser = new SseParser();
    assert.deepEqual(parser.feed("ev"), []);
    assert.deepEqual(parser.feed("ent: run_started\nda"), []);
    assert.deepEqual(parser.feed("ta: {}\n"), []);
    assert.deepEqual(parser.feed("\n"), [{ id: null, event: "run_started", data: "{}" }]);
  });

  test("drops comments, which is what keepalives are", () => {
    const parser = new SseParser();
    assert.deepEqual(parser.feed(": connected\n\n: keepalive\n\n"), []);
  });

  test("joins several data lines with newlines", () => {
    const parser = new SseParser();
    assert.deepEqual(parser.feed("data: a\ndata: b\n\n"), [{ id: null, event: null, data: "a\nb" }]);
  });

  test("accepts CRLF line endings", () => {
    const parser = new SseParser();
    assert.deepEqual(parser.feed("event: x\r\ndata: 1\r\n\r\n"), [{ id: null, event: "x", data: "1" }]);
  });

  test("ignores fields it does not know", () => {
    const parser = new SseParser();
    assert.deepEqual(parser.feed("retry: 1000\nevent: x\ndata: 1\n\n"), [{ id: null, event: "x", data: "1" }]);
  });
});
