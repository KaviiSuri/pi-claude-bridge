// Pure pi→Anthropic message conversion helpers.
// Extracted so they can be tested without pulling in the full extension runtime.

import type { Message as PiMessage } from "@earendil-works/pi-ai";
import type { Message as SessionMessage } from "cc-session-io";
import { pascalCase } from "change-case";

export const PROVIDER_ID = "claude-bridge";

export const PI_TO_SDK_TOOL_NAME: Record<string, string> = {
	read: "Read", write: "Write", edit: "Edit", bash: "Bash",
};

export function sanitizeToolId(id: string, cache: Map<string, string>): string {
	const existing = cache.get(id);
	if (existing) return existing;
	const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	cache.set(id, clean);
	return clean;
}

export function mapPiToolNameToSdk(name: string, customToolNameToSdk?: Map<string, string>): string {
	if (!name) return "";
	const normalized = name.toLowerCase();
	if (customToolNameToSdk) {
		const mapped = customToolNameToSdk.get(name) ?? customToolNameToSdk.get(normalized);
		if (mapped) return mapped;
	}
	if (PI_TO_SDK_TOOL_NAME[normalized]) return PI_TO_SDK_TOOL_NAME[normalized];
	return pascalCase(name);
}

export function messageContentToText(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	let hasText = false;
	for (const block of content) {
		if (block.type === "text" && block.text) { parts.push(block.text); hasText = true; }
		else if (block.type !== "text" && block.type !== "image") { parts.push(`[${block.type}]`); }
	}
	return hasText ? parts.join("\n") : "";
}

// Tool results are flattened to text, which is how Claude Code stores most of
// them. Images are the exception: they have no text form, so a result carrying
// one keeps the block array shape instead (also what CC writes for screenshots).
function toolResultContent(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): string | Array<Record<string, unknown>> {
	if (typeof content === "string" || !Array.isArray(content)) return messageContentToText(content) || "";
	const images = content.filter((b) => b.type === "image" && b.data && b.mimeType);
	if (!images.length) return messageContentToText(content) || "";
	const blocks: Array<Record<string, unknown>> = [];
	for (const block of content) {
		if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text });
		else if (block.type === "image" && block.data && block.mimeType) {
			blocks.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
		} else if (block.type !== "text" && block.type !== "image") {
			// Same marker messageContentToText leaves for unrecognized blocks, so the
			// text and image paths describe an extension's output the same way.
			blocks.push({ type: "text", text: `[${block.type}]` });
		}
	}
	return blocks;
}

/** Convert pi message array to Anthropic API format. */
export function convertPiMessages(
	messages: PiMessage[],
	customToolNameToSdk?: Map<string, string>,
): { anthropicMessages: SessionMessage[]; sanitizedIds: Map<string, string> } {
	const anthropicMessages = [];
	const sanitizedIds = new Map();
	// The user message collecting this assistant turn's tool results, if one has
	// been emitted yet. Cleared at every assistant message — see the toolResult branch.
	let turnResults: { role: string; content: Array<Record<string, unknown>> } | null = null;

	for (const msg of messages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				anthropicMessages.push({ role: "user", content: msg.content || "[empty]" });
			} else if (Array.isArray(msg.content)) {
				const parts = [];
				for (const block of msg.content) {
					if (block.type === "text" && block.text) parts.push({ type: "text", text: block.text });
					else if (block.type === "image" && block.data && block.mimeType) {
						parts.push({ type: "image", source: { type: "base64", media_type: block.mimeType, data: block.data } });
					}
				}
				anthropicMessages.push({ role: "user", content: parts.length ? parts : "[image]" });
			} else {
				anthropicMessages.push({ role: "user", content: "[empty]" });
			}
		} else if (msg.role === "assistant") {
			turnResults = null;
			const content = Array.isArray(msg.content) ? msg.content : [];
			const blocks = [];
			for (const block of content) {
				if (block.type === "text" && block.text) {
					blocks.push({ type: "text", text: block.text });
				} else if (block.type === "thinking") {
					// Only replay thinking Claude Code itself produced. A signature minted
					// by any other provider — including pi's own Anthropic provider — is
					// not ours to hand back, and Anthropic rejects ones it can't verify.
					const sig = block.thinkingSignature;
					if (msg.provider === PROVIDER_ID && sig) {
						blocks.push({ type: "thinking", thinking: block.thinking ?? "", signature: sig });
					}
				} else if (block.type === "toolCall") {
					const toolName = mapPiToolNameToSdk(block.name, customToolNameToSdk);
					blocks.push({ type: "tool_use", id: sanitizeToolId(block.id, sanitizedIds), name: toolName, input: block.arguments ?? {} });
				}
			}
			if (!blocks.length) blocks.push({ type: "text", text: "[incompatible content omitted]" });
			anthropicMessages.push({ role: "assistant", content: blocks });
		} else if (msg.role === "toolResult") {
			// Pi records one message per tool result; Claude Code puts every result
			// for an assistant turn in a single user message, and that is the only
			// shape repairToolPairing accepts (Session.importMessages applies it
			// too). Split across messages, the second and later results match no
			// pending tool_use id: they are dropped and replaced with a synthetic
			// "[no tool result recorded]", so every rebuild silently destroyed the
			// output of parallel tool calls.
			//
			// Collecting into the turn's first result message rather than the
			// immediately preceding one also handles a steer landing mid-execution,
			// which pi records between the results (see extractAllToolResults).
			// Hoisting the later results in front of it is what CC writes for the
			// same turn anyway: all results, then the steer as its own user message.
			const block = { type: "tool_result", tool_use_id: sanitizeToolId(msg.toolCallId, sanitizedIds), content: toolResultContent(msg.content), is_error: msg.isError };
			if (turnResults) {
				turnResults.content.push(block);
			} else {
				turnResults = { role: "user", content: [block] };
				anthropicMessages.push(turnResults);
			}
		}
	}

	return { anthropicMessages, sanitizedIds };
}
