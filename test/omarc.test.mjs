import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test, { describe } from "node:test";

import { compile, locate, stripPath } from "../out/omarc.js";

describe("locating what omarc complained about", () => {
  test("puts the squiggle under the name in the message", () => {
    // omarc reports no line and no column, so the position is recovered from
    // the message. Without this every error lands on line one.
    const source = "team T[a : Codex]\n{\n    input topic : string\n}\n";
    const problem = locate("unknown input/action dependency 'topic'", source);

    assert.equal(problem.line, 2);
    assert.equal(source.split("\n")[problem.line].slice(problem.from, problem.to), "topic");
  });

  test("finds a qualified name by its last segment", () => {
    // The compiler reports `flow.topic`; the source says `topic`, inside the
    // team that declares it.
    const source = "team T[a : Codex]\n{\n    input topic : string\n}\n";
    const problem = locate("missing input 'flow.topic'", source);

    assert.equal(problem.line, 2);
    assert.equal(source.split("\n")[2].slice(problem.from, problem.to), "topic");
  });

  test("falls back to the first line rather than guessing", () => {
    const problem = locate("expected identifier, found none", "team T[a : Codex]\n{}\n");
    assert.deepEqual({ line: problem.line, from: problem.from }, { line: 0, from: 0 });
    assert.ok(problem.to > 0);
  });

  test("drops the path the editor already knows", () => {
    assert.equal(
      stripPath("/tmp/x/Review.omar: expected identifier", "/tmp/x/Review.omar"),
      "expected identifier",
    );
    assert.equal(stripPath("  something else  ", "/tmp/x/Review.omar"), "something else");
  });
});

// Needs the real compiler. Skips rather than fails so a checkout without a
// built runtime still runs everything else.
const OMARC = process.env.OMARC_BIN ?? resolve("../omar/lang/.lake/build/bin/omarc");
const AVAILABLE = existsSync(OMARC);

describe("against the real compiler", { skip: AVAILABLE ? false : "omarc not built" }, () => {
  const GOOD = `team Flow[writer : Codex]
{
    input topic : string
    output blurb : string

    prompt writer(topic) -> blurb "Write about $(topic)."
}

main Flow { flow = Flow() }`;

  test("compiles a program and names its team", async () => {
    const result = await compile(OMARC, GOOD, "Flow.omar");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.team, "Flow");
    assert.ok(Array.isArray(result.bytecode.instructions));
  });

  test("reports a program it rejects, positioned", async () => {
    const broken = GOOD.replace("prompt writer(topic)", "prompt writer(nope)");
    const result = await compile(OMARC, broken, "Flow.omar");

    assert.equal(result.ok, false);
    assert.match(result.problems[0].message, /nope/);
    // On the line that says `nope`, not on line one.
    assert.equal(broken.split("\n")[result.problems[0].line].includes("nope"), true);
    // And without the scratch path it was compiled at.
    assert.doesNotMatch(result.problems[0].message, /omar-vscode-/);
  });

  test("says so when the compiler is not there", async () => {
    const result = await compile("definitely-not-omarc", GOOD, "Flow.omar");
    assert.equal(result.ok, false);
    assert.match(result.problems[0].message, /omar\.compilerPath|PATH/);
  });
});
