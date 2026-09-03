import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";

import { symbolsOf } from "../out/language/symbols.js";

const PIPELINE = readFileSync(new URL("../examples/Pipeline.omar", import.meta.url), "utf8");

describe("the outline of a program", () => {
  test("lists teams and the main block, with what each declares", () => {
    const roots = symbolsOf(PIPELINE);
    assert.deepEqual(roots.map((symbol) => `${symbol.kind} ${symbol.name}`), ["team Step", "team Judge", "main Pipeline"]);
    const step = roots[0];
    assert.equal(step.detail, "agent : Stub");
    assert.deepEqual(step.children.map((child) => `${child.kind} ${child.name}: ${child.detail}`), ["input inp: int", "output out: int", "prompt agent: (inp) -> out"]);
    const main = roots[2];
    assert.deepEqual(main.children.map((child) => `${child.kind} ${child.name}`), ["instance first", "instance second", "instance third", "instance judge"]);
  });

  test("puts each name where it is in the text", () => {
    const lines = PIPELINE.split("\n");
    for (const root of symbolsOf(PIPELINE)) {
      assert.equal(lines[root.line].slice(root.from, root.to), root.name);
      for (const child of root.children) assert.equal(lines[child.line].slice(child.from, child.to), child.name);
      assert.ok(root.end >= root.line, "a block ends after it begins");
      assert.equal(lines[root.end].trim(), "}", "a block ends at its closing brace");
    }
  });

  test("a brace inside a prompt's text does not close the team", () => {
    const roots = symbolsOf('team T[a : Stub]\n{\n    input x : int\n    prompt a(x) -> y\n    "\n        Return { } braces.\n    "\n    output y : int\n}\n');
    assert.equal(roots.length, 1);
    assert.deepEqual(roots[0].children.map((child) => child.name), ["x", "a", "y"]);
    assert.equal(roots[0].end, 8);
  });

  test("a timer and an unnamed main", () => {
    const roots = symbolsOf("team Pulse[a : Stub]\n{\n    timer t(0s, 10s)\n    output note : string\n}\n\nmain {\n    beacon = Pulse()\n}\n");
    assert.deepEqual(roots[0].children[0], { name: "t", kind: "timer", detail: "(0s, 10s)", line: 2, from: 10, to: 11, end: 2, children: [] });
    assert.equal(roots[1].name, "main");
    assert.equal(roots[1].children[0].detail, "Pulse");
  });
});
