import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { assistantSessionFor, flattenAgentName, sessionFor } from "../out/tmux.js";

describe("finding an agent's tmux session", () => {
  const listed = ["1", "omar-agent-ea-0", "omar-agent-0-first_agent", "omar-agent-0-second_agent", "omar-agent-1-first_agent"];

  test("flattens a name the way the runtime does", () => {
    assert.equal(flattenAgentName("first.agent"), "first_agent");
    assert.equal(flattenAgentName("agent::run.draft.worker"), "run_draft_worker");
  });

  test("takes the deployment record's word first", () => {
    assert.equal(sessionFor("agent::first.agent", { "first.agent": "custom-session" }, listed, "0"), "custom-session");
  });

  test("otherwise matches tmux's list, preferring this EA", () => {
    assert.equal(sessionFor("first.agent", {}, listed, "0"), "omar-agent-0-first_agent");
    assert.equal(sessionFor("first.agent", {}, listed, "1"), "omar-agent-1-first_agent");
    assert.equal(sessionFor("second.agent", {}, listed, "7"), "omar-agent-0-second_agent");
    assert.equal(sessionFor("nobody", {}, listed, "0"), null);
  });

  test("finds the assistant's session", () => {
    assert.equal(assistantSessionFor(listed, "0"), "omar-agent-ea-0");
    assert.equal(assistantSessionFor(["omar-agent-ea-3"], "0"), "omar-agent-ea-3");
    assert.equal(assistantSessionFor(["1"], "0"), null);
  });
});
