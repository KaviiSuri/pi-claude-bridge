// In-process MCP server that exposes pi tools to Claude Code.
//
// Pi declares tool parameters as TypeBox objects, which are already JSON
// Schema at runtime — the same thing MCP puts on the wire. This serves them
// verbatim instead of going through the SDK's `createSdkMcpServer`, which only
// accepts Zod and therefore forces a JSON Schema → Zod → JSON Schema round
// trip. That round trip is lossy below the top level (nested objects collapse
// to open records, `anyOf`/`const` to nothing), and its argument validation is
// actively harmful here: pi executes the tools and validates their arguments,
// so a rejection would skip the handler and desync the toolCallId cursor.
//
// Handlers go on the underlying protocol server rather than through
// `McpServer.registerTool`, which is the Zod-only path. The wrapper is kept
// because the SDK's `mcpServers` option is typed against `McpServer`.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpResult } from "./extract-tool-results.js";

export interface McpToolDef {
	name: string;
	description: string;
	inputSchema: unknown;
	handler: () => Promise<McpResult>;
}

const EMPTY_SCHEMA = { type: "object", properties: {} };

// Tool parameters come from arbitrary pi extensions; MCP requires an object schema.
function toInputSchema(schema: unknown): Record<string, unknown> {
	const s = schema as Record<string, unknown> | undefined;
	return s && s.type === "object" && s.properties ? s : EMPTY_SCHEMA;
}

export function createToolServer(name: string, tools: McpToolDef[]) {
	const server = new McpServer({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
	const byName = new Map(tools.map((tool) => [tool.name, tool]));

	server.server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: toInputSchema(tool.inputSchema),
		})),
	}));

	server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const tool = byName.get(request.params.name);
		if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
		return await tool.handler();
	});

	return { type: "sdk" as const, name, instance: server };
}
