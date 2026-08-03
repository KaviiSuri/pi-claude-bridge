import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractAgentsAppend, formatProjectContext } from "../src/agents-md.js";

describe("project context forwarding", () => {
	it("uses Pi's global and hierarchical context-file discovery", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-agent-"));
		const projectRoot = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		const cwd = join(projectRoot, "nested");
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			mkdirSync(cwd);
			writeFileSync(join(agentDir, "AGENTS.md"), "global instructions");
			writeFileSync(join(projectRoot, "CLAUDE.md"), "parent instructions");
			writeFileSync(join(cwd, "AGENTS.md"), "nested pi instructions");

			const prompt = extractAgentsAppend(cwd);
			assert.ok(prompt);
			assert.match(prompt, /^<project_context>\n\nProject-specific instructions and guidelines:/);
			assert.ok(prompt.indexOf("global instructions") < prompt.indexOf("parent instructions"));
			assert.ok(prompt.indexOf("parent instructions") < prompt.indexOf("nested pi instructions"));
			assert.match(prompt, /<project_instructions path=".*CLAUDE\.md">/);
			assert.match(prompt, /nested pi instructions/);
			assert.ok(!prompt.includes("nested environment instructions"));
		} finally {
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	it("returns undefined when Pi finds no context files", () => {
		assert.equal(formatProjectContext([]), undefined);
	});
});
