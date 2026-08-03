// Pi owns context-file discovery. Reuse its public loader so Claude receives
// the same global and hierarchical AGENTS.md/CLAUDE.md instructions as Pi.

import { getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";

type ContextFile = { path: string; content: string };

export function extractAgentsAppend(cwd: string = process.cwd()): string | undefined {
	return formatProjectContext(loadProjectContextFiles({ cwd, agentDir: getAgentDir() }));
}

export function formatProjectContext(contextFiles: ContextFile[]): string | undefined {
	if (contextFiles.length === 0) return undefined;

	let prompt = "<project_context>\n\nProject-specific instructions and guidelines:\n\n";
	for (const { path, content } of contextFiles) {
		prompt += `<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n`;
	}
	return `${prompt}</project_context>`;
}
