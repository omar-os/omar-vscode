import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { parseCheckResult } from "../out/client/protocol.js";
import { parseInputValue } from "../out/model/inputs.js";

describe("turning typed text into a port's value", () => {
  test("keeps a string as typed, whitespace and all", () => {
    assert.equal(parseInputValue("string", "  hello "), "  hello ");
  });

  test("reads numbers and booleans, and refuses what is not one", () => {
    assert.equal(parseInputValue("int", " 42 "), 42);
    assert.equal(parseInputValue("int", "4.2"), undefined);
    assert.equal(parseInputValue("float", "4.2"), 4.2);
    assert.equal(parseInputValue("float", ""), undefined);
    assert.equal(parseInputValue("bool", "true"), true);
    assert.equal(parseInputValue("bool", "yes"), undefined);
  });

  test("a signal carries nothing", () => {
    assert.equal(parseInputValue("signal", "anything"), null);
  });

  test("anything else is JSON", () => {
    assert.deepEqual(parseInputValue("list<int>", "[1, 2]"), [1, 2]);
    assert.equal(parseInputValue("list<int>", "[1, 2"), undefined);
  });
});

describe("reading a check result", () => {
  test("a refused program carries the runtime's errors", () => {
    assert.deepEqual(parseCheckResult({ ok: false, errors: ["unknown port 'x'"] }), { ok: false, errors: ["unknown port 'x'"] });
  });

  test("an accepted one carries its open inputs and a preview", () => {
    const result = parseCheckResult({
      ok: true,
      open_inputs: ["run.request"],
      preview: { protocol_version: 1, team: "T", ports: [{ id: "port::run.request", name: "run.request", kind: "input", type: "string" }], reactions: [], edges: [] },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.openInputs, ["run.request"]);
    assert.equal(result.preview.ports[0].type, "string");
  });

  test("refuses something that is not a check result", () => {
    assert.throws(() => parseCheckResult({ hello: 1 }), /not from an OMAR runtime/);
  });
});
