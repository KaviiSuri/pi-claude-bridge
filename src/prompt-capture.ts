// What pi assembled for one agent, kept so the bridge can append it after Claude
// Code's own preset.
//
// Extracted from index.ts so tests can import it without activating the extension.

/**
 * The user's own customisation (`--system-prompt`, `--append-system-prompt`) and
 * pi's context-file list, captured from `before_agent_start` rather than
 * rediscovered so the bridge cannot disagree with pi about what applies.
 *
 * pi's `context.systemPrompt` can't be forwarded wholesale — it describes pi's
 * tools and harness and would fight Claude Code's preset — but the user's text is
 * theirs and has to reach the model.
 */
export type PromptCapture = {
	custom?: string;
	append?: string;
	contextFiles: { path: string; content: string }[];
};

export const EMPTY_PROMPT_CAPTURE: PromptCapture = { contextFiles: [] };

/**
 * Captures keyed by the assembled system prompt, rather than held in one slot.
 *
 * pi fires `before_agent_start` once per agent loop and sub-agents run in their
 * own `AgentSession`, so a single slot is last-writer-wins: a sub-agent overwrote
 * the parent's capture and nothing restored it, leaving every later parent turn
 * carrying the sub-agent's `<sub_agent_context>` — telling the main agent it was a
 * sub-agent — and none of its own context files, for the rest of the session.
 *
 * Keying makes that mismatch impossible rather than unlikely: agent-session
 * assigns `agent.state.systemPrompt` the same string the event carries, so a query
 * resolves to its own agent's capture or to none at all.
 */
export class PromptCaptures {
	private readonly captures = new Map<string, PromptCapture>();

	/** pi rebuilds the prompt whenever the tool set changes, so keys accumulate
	 *  within a session; only the most recent are kept. */
	constructor(private readonly limit = 16) {}

	record(systemPrompt: string, capture: PromptCapture): void {
		// Re-inserted rather than overwritten so Map iteration order tracks recency.
		this.captures.delete(systemPrompt);
		this.captures.set(systemPrompt, capture);
		for (const key of this.captures.keys()) {
			if (this.captures.size <= this.limit) break;
			this.captures.delete(key);
		}
	}

	/**
	 * The capture for this prompt, or `undefined` when none was recorded — which
	 * means the query's prompt never came through `before_agent_start`. Appending
	 * nothing is correct there, since appending another agent's text is exactly what
	 * the keying prevents, but the caller should say so: it also means the user's own
	 * instructions did not reach Claude for that turn.
	 */
	resolve(systemPrompt?: string): PromptCapture | undefined {
		if (!systemPrompt) return undefined;
		return this.captures.get(systemPrompt);
	}

	/** Number of captures held. Exposed for the bound check in tests. */
	get size(): number {
		return this.captures.size;
	}
}
