#!/usr/bin/env node
// Does a git-status change in the working tree bust the prompt cache?
//
// Issue #73 asserts that CC's `claude_code` preset embeds a git-status block in
// the cached system block, so any working-tree edit invalidates the cached
// prefix. This probe settles it against the installed CC/SDK instead of by
// reading the source or the debug log.
//
//   node diag/capture-proxy.mjs --port 8787 --out /tmp/gitcache-capture &
//   node diag/probe-git-cache.mjs /tmp/gitcache-repo
//   node diag/probe-git-cache.mjs --report /tmp/gitcache-capture
//
// Each turn is a fresh one-shot query() with no resume, which is what a bridge
// turn is: CC re-invoked from scratch. That isolates the system prompt from the
// ~25% cold-resume finding in diag/AUDIT.md, which would otherwise swamp it.
//
// Turn 2 is the control. It changes nothing, so it must read cache; if it does
// not, something else in the preset churns per invocation and the probe cannot
// see a git effect at all.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const PROXY = "http://127.0.0.1:8787";
const MODEL = "claude-haiku-4-5";
const GIT_ANCHOR = "gitStatus:";

async function turn(repo, label) {
	const q = query({
		prompt: "Reply with exactly: OK",
		options: {
			cwd: repo,
			model: MODEL,
			tools: [],
			permissionMode: "bypassPermissions",
			env: {
				...process.env,
				ANTHROPIC_BASE_URL: PROXY,
				ENABLE_CLAUDEAI_MCP_SERVERS: "0",
				DISABLE_AUTO_COMPACT: "1",
			},
			systemPrompt: { type: "preset", preset: "claude_code" },
		},
	});
	for await (const message of q) if (message.type === "result") break;
	console.error(`turn ${label}: done`);
}

const git = (repo, ...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

/** Does a *new* path appearing in `git status` break the cache? */
async function phase1(repo) {
	await turn(repo, "1 baseline (writes cache)");
	await turn(repo, "2 control (no git change)");

	writeFileSync(join(repo, "probe-new-file.txt"), "created between turn 2 and 3\n");
	console.error(`--- created probe-new-file.txt: ${git(repo, "status", "--short")}`);

	await turn(repo, "3 test (untracked file added)");
	await turn(repo, "4 control (no further change)");
}

/** Does editing an *already-dirty* file break it? The status line does not move,
 *  which separates "any edit" from "a status transition". */
async function phase2(repo) {
	await turn(repo, "5 baseline");

	appendFileSync(join(repo, "a.txt"), "more content, file was already modified\n");
	console.error(`--- appended to already-dirty a.txt: ${JSON.stringify(git(repo, "status", "--short"))}`);
	await turn(repo, "6 test (edit to already-dirty file)");

	git(repo, "add", "a.txt");
	console.error(`--- staged a.txt: ${JSON.stringify(git(repo, "status", "--short"))}`);
	await turn(repo, "7 test (staged, ' M' -> 'M ')");

	git(repo, "commit", "-qm", "probe commit");
	console.error(`--- committed: ${JSON.stringify(git(repo, "log", "--oneline", "-n", "1"))}`);
	await turn(repo, "8 test (new commit)");
}

/** The preset's system prompt, as a single string, across all system blocks. */
function systemText(request) {
	const system = request.system;
	if (typeof system === "string") return system;
	return (system ?? []).map((block) => block.text ?? "").join("\n");
}

function gitBlock(text) {
	const at = text.indexOf(GIT_ANCHOR);
	return at === -1 ? null : text.slice(at);
}

/** First byte offset at which two strings differ, or -1 when identical. */
function firstDivergence(a, b) {
	const limit = Math.min(a.length, b.length);
	let i = 0;
	while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	if (i === limit && a.length === b.length) return -1;
	return i;
}

function report(dir) {
	const index = readFileSync(join(dir, "index.jsonl"), "utf8")
		.trim().split("\n").map((line) => JSON.parse(line))
		.filter((entry) => entry.path.startsWith("/v1/messages") && entry.usage);

	let previous = null;
	for (const entry of index) {
		const request = JSON.parse(readFileSync(join(dir, `req-${String(entry.n).padStart(4, "0")}.json`), "utf8"));
		const text = systemText(request);
		const git = gitBlock(text);
		const { cacheRead, cacheWrite, input } = entry.usage;

		const cached = request.system?.filter?.((b) => b.cache_control).length ?? 0;
		console.log(`\n#${entry.n}  cacheRead=${cacheRead}  cacheWrite=${cacheWrite}  input=${input}`);
		console.log(`  system blocks=${Array.isArray(request.system) ? request.system.length : "string"} cache_control on ${cached}`);
		console.log(`  gitStatus block: ${git ? `present, ${git.length} chars` : "ABSENT"}`);

		if (previous) {
			const divergence = firstDivergence(previous.text, text);
			console.log(`  vs #${previous.n}: system ${divergence === -1 ? "IDENTICAL" : `diverges at byte ${divergence} of ${previous.text.length}`}`);
			if (divergence !== -1) {
				const gitAt = text.indexOf(GIT_ANCHOR);
				console.log(`    gitStatus starts at byte ${gitAt} → divergence is ${divergence >= gitAt ? "INSIDE the git block" : "BEFORE the git block"}`);
				console.log(`    prev: ${JSON.stringify(previous.text.slice(divergence, divergence + 70))}`);
				console.log(`    curr: ${JSON.stringify(text.slice(divergence, divergence + 70))}`);
			}
		}
		previous = { n: entry.n, text };
	}
}

const args = process.argv.slice(2);
if (args[0] === "--report") report(args[1]);
else if (args[0] === "--phase2") await phase2(args[1]);
else await phase1(args[0]);
