#!/usr/bin/env node
// Unit tests for per-agent system prompt captures (prompt-capture.ts).
//
// The bug this guards: pi fires before_agent_start once per agent loop and
// sub-agents run in their own AgentSession, so holding the capture in a single
// slot was last-writer-wins. A sub-agent overwrote the parent's and nothing put it
// back, so every later parent turn carried the sub-agent's <sub_agent_context> —
// telling the main agent it was a sub-agent — and lost its own context files for
// the rest of the session. Nothing surfaced it.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PromptCaptures } from "../src/prompt-capture.js";

const PARENT = "parent prompt\n<project_context>AGENTS.md</project_context>";
const SUBAGENT = "sub-agent prompt\n<sub_agent_context>you are a sub-agent</sub_agent_context>";
const parentCapture = { custom: "parent custom", contextFiles: [{ path: "/AGENTS.md", content: "rules" }] };
const subCapture = { custom: "sub custom", contextFiles: [] };

describe("PromptCaptures", () => {
	it("a sub-agent starting does not disturb the parent's capture", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT, parentCapture);
		captures.record(SUBAGENT, subCapture);

		// The regression: this used to return the sub-agent's capture.
		assert.deepEqual(captures.resolve(PARENT), parentCapture);
		assert.deepEqual(captures.resolve(SUBAGENT), subCapture);
	});

	it("the parent keeps its context files after a sub-agent runs", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT, parentCapture);
		captures.record(SUBAGENT, subCapture);
		// ctxFiles went 1 -> 0 and stayed there for the rest of the session.
		assert.equal(captures.resolve(PARENT).contextFiles.length, 1);
	});

	it("resolves to nothing rather than to another agent's capture", () => {
		const captures = new PromptCaptures();
		captures.record(SUBAGENT, subCapture);
		// A prompt never seen must not inherit whatever was recorded last.
		assert.equal(captures.resolve("some other agent's prompt"), undefined);
		assert.equal(captures.resolve(undefined), undefined);
	});

	it("re-recording the same prompt replaces rather than duplicates", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT, parentCapture);
		captures.record(PARENT, subCapture);
		assert.equal(captures.size, 1);
		assert.deepEqual(captures.resolve(PARENT), subCapture);
	});

	it("is bounded, evicting least-recently-recorded first", () => {
		const captures = new PromptCaptures(3);
		captures.record("a", { contextFiles: [] });
		captures.record("b", { contextFiles: [] });
		captures.record("c", { contextFiles: [] });
		captures.record("a", { contextFiles: [], custom: "refreshed" });  // a becomes newest
		captures.record("d", { contextFiles: [] });                      // evicts b

		assert.equal(captures.size, 3);
		assert.equal(captures.resolve("b"), undefined);
		assert.equal(captures.resolve("a").custom, "refreshed");
		assert.ok(captures.resolve("c") && captures.resolve("d"));
	});
});
