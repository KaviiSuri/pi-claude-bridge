/**
 * Tool schemas the bridge advertises to Claude Code must survive the trip
 * verbatim, including below the top level.
 *
 * Drives the MCP server the same way the Agent SDK does — `instance.connect()`
 * with a transport, then raw JSON-RPC — so the assertions cover what Claude
 * actually receives rather than an intermediate representation.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { createToolServer } from "../src/mcp-server.js";

const NESTED_TOOL_SCHEMA = {
	type: "object",
	properties: {
		question: { type: "string", description: "Question to ask" },
		options: {
			type: "array",
			description: "Choices to offer",
			items: {
				type: "object",
				properties: {
					label: { type: "string", description: "Short label" },
					detail: { type: "string" },
				},
				required: ["label"],
			},
		},
		config: {
			type: "object",
			properties: {
				mode: { type: "string", enum: ["single", "multi"] },
				retries: { type: "integer" },
			},
			required: ["mode"],
		},
		either: { anyOf: [{ type: "string" }, { type: "number" }] },
	},
	required: ["question", "options"],
};

// Mirrors the SDK's connectSdkMcpServer: hand the instance a transport, push
// requests into transport.onmessage, read replies out of transport.send.
async function connectClient(server) {
	const pending = new Map();
	const transport = {
		start: async () => {},
		close: async () => {},
		send: async (msg) => pending.get(msg.id)?.(msg),
	};
	await server.instance.connect(transport);

	let nextId = 0;
	const request = (method, params) =>
		new Promise((resolve) => {
			const id = ++nextId;
			pending.set(id, resolve);
			transport.onmessage({ jsonrpc: "2.0", id, method, params });
		});

	await request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "test", version: "1.0.0" },
	});
	transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
	return request;
}

describe("MCP tool schema advertisement", () => {
	let listed;

	before(async () => {
		const server = createToolServer("custom-tools", [
			{
				name: "ask_user_question",
				description: "Ask the user a question",
				inputSchema: NESTED_TOOL_SCHEMA,
				handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
			},
		]);
		const request = await connectClient(server);
		listed = (await request("tools/list", {})).result.tools[0].inputSchema;
	});

	it("preserves top-level properties and required", () => {
		assert.deepStrictEqual(Object.keys(listed.properties).sort(), ["config", "either", "options", "question"]);
		assert.deepStrictEqual(listed.required, ["question", "options"]);
		assert.strictEqual(listed.properties.question.description, "Question to ask");
	});

	it("preserves object properties nested in an array", () => {
		const item = listed.properties.options.items;
		assert.deepStrictEqual(Object.keys(item.properties).sort(), ["detail", "label"]);
		assert.deepStrictEqual(item.required, ["label"]);
		assert.strictEqual(item.properties.label.description, "Short label");
	});

	it("preserves nested object properties, enums and required", () => {
		const config = listed.properties.config;
		assert.deepStrictEqual(Object.keys(config.properties).sort(), ["mode", "retries"]);
		assert.deepStrictEqual(config.required, ["mode"]);
		assert.deepStrictEqual(config.properties.mode.enum, ["single", "multi"]);
		assert.strictEqual(config.properties.retries.type, "integer");
	});

	it("preserves anyOf branches", () => {
		assert.deepStrictEqual(listed.properties.either.anyOf, [{ type: "string" }, { type: "number" }]);
	});
});

describe("MCP tool invocation", () => {
	it("routes tools/call to the matching handler", async () => {
		const calls = [];
		const server = createToolServer("custom-tools", [
			{
				name: "alpha",
				description: "a",
				inputSchema: { type: "object", properties: {} },
				handler: async () => {
					calls.push("alpha");
					return { content: [{ type: "text", text: "from alpha" }] };
				},
			},
			{
				name: "beta",
				description: "b",
				inputSchema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
				handler: async () => {
					calls.push("beta");
					return { content: [{ type: "text", text: "from beta" }], isError: true };
				},
			},
		]);
		const request = await connectClient(server);

		const beta = await request("tools/call", { name: "beta", arguments: { x: "hi" } });
		assert.deepStrictEqual(calls, ["beta"]);
		assert.strictEqual(beta.result.content[0].text, "from beta");
		assert.strictEqual(beta.result.isError, true);
	});

	// A schema-validation rejection would skip the handler entirely, desyncing
	// the toolCallId cursor that pairs later results with their calls.
	it("invokes the handler even when arguments do not match the schema", async () => {
		let called = false;
		const server = createToolServer("custom-tools", [
			{
				name: "strict",
				description: "s",
				inputSchema: {
					type: "object",
					properties: { count: { type: "number" } },
					required: ["count"],
					additionalProperties: false,
				},
				handler: async () => {
					called = true;
					return { content: [{ type: "text", text: "ran" }] };
				},
			},
		]);
		const request = await connectClient(server);

		const res = await request("tools/call", { name: "strict", arguments: { count: "not-a-number", extra: 1 } });
		assert.ok(called, "handler must run — pi validates and executes tools, not the MCP layer");
		assert.strictEqual(res.result.content[0].text, "ran");
	});
});
