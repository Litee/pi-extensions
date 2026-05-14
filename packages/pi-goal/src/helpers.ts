/**
 * Pure helpers for pi-goal: transcript rendering for the checker.
 *
 * Kept dependency-free so they unit-test trivially with vitest.
 *
 * `pi-agent-core`'s `AgentMessage` is a broad union that includes tool-result
 * messages, branch summaries, compaction summaries, etc. We don't care about
 * the full discriminated shape — we duck-type on `{ role, content }` and
 * ignore anything else. This keeps the helper resilient to future additions
 * to the `AgentMessage` union without forcing a dependency on the agent-core
 * type re-exports.
 */

/** Minimum shape we read off any message-like value. Intentionally permissive. */
export interface MessageLike {
	role?: unknown;
	content?: unknown;
}

/**
 * Render the most recent N turns of `messages` into a plain-text transcript
 * suitable for the checker LLM. Goal-mode injected user messages (kickoff,
 * continue, budget_limit) are stripped — the checker should judge the
 * agent's actual output, not our own loop control prompts.
 *
 * `marker` is the prefix string added to every goal-mode user message
 * (`GOAL_CONTEXT_MARKER` from prompt.ts). Any user message whose text starts
 * with the marker is dropped from the rendered transcript.
 */
export function buildCheckerTranscript(
	messages: readonly MessageLike[],
	marker: string,
	maxTurns = 4,
): string {
	const filtered: MessageLike[] = [];
	for (const m of messages) {
		if (m.role === "user") {
			const text = extractText(m.content);
			if (text.startsWith(marker)) continue;
		}
		filtered.push(m);
	}

	// Take the last `maxTurns * 2` messages as a rough proxy for "the last few
	// exchanges". Goal mode is auto-driven, so we usually only need the most
	// recent assistant turn — but a wider window helps the checker see the
	// original user request when goal mode was kicked off interactively.
	const tail = filtered.slice(-Math.max(2, maxTurns * 2));

	return tail
		.map((m) => {
			const text = extractText(m.content).trim();
			if (!text) return undefined;
			return `${roleLabel(m.role)}:\n${text}`;
		})
		.filter((s): s is string => s !== undefined)
		.join("\n\n");
}

function roleLabel(role: unknown): string {
	if (role === "assistant") return "ASSISTANT";
	if (role === "user") return "USER";
	if (role === "system") return "SYSTEM";
	return "MESSAGE";
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const c of content) {
		if (c == null || typeof c !== "object") continue;
		const obj = c as { type?: unknown; text?: unknown };
		if (obj.type === "text" && typeof obj.text === "string") parts.push(obj.text);
	}
	return parts.join("\n");
}
