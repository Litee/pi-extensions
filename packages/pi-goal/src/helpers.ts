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

/**
 * Format the iteration/token suffix shared by every termination message.
 * Always emits both numbers so the user can see goal cost at a glance
 * (issue #0003).
 */
function terminationStats(iterations: number, tokensUsed: number): string {
	return `${iterations} turn(s), ${tokensUsed.toLocaleString()} tokens used`;
}

/**
 * Build the notify-pill body shown when the goal completes successfully
 * (the agent called `update_goal`). Includes turns and tokens (#0003).
 */
export function formatSuccessNotify(
	iterations: number,
	tokensUsed: number,
): string {
	return `✓ Goal achieved after ${terminationStats(iterations, tokensUsed)}.`;
}

/**
 * Build the notify-pill body shown when the goal terminates for any reason
 * other than success: cap, budget, /goal stop, Ctrl+Alt+G, or interactive
 * input. The caller-supplied `reason` is shown verbatim, then turns and
 * tokens are appended in parentheses (#0003).
 */
export function formatTerminationNotify(
	reason: string,
	iterations: number,
	tokensUsed: number,
): string {
	return `${reason} (${terminationStats(iterations, tokensUsed)})`;
}

/**
 * Build the multi-line follow-up `pi-goal:status` message body shown when
 * the goal terminates (success or otherwise). Includes the objective for
 * context, turns, tokens, and the reason (#0003).
 */
export function formatTerminationStatus(
	objective: string,
	reason: string,
	iterations: number,
	tokensUsed: number,
): string {
	return (
		`Goal mode ended: "${objective}" ` +
		`(${terminationStats(iterations, tokensUsed)}).\n${reason}`
	);
}

/**
 * Build the notify-pill body shown when the goal is paused on a genuine
 * blocker (issue #0004). Mirrors the success/abort shape from #0003 — turns
 * and tokens are always included so users see goal cost regardless of how
 * the loop ended — and additionally surfaces the agent's blocker summary so
 * the user knows what to do next.
 */
export function formatBlockedNotify(
	iterations: number,
	tokensUsed: number,
	summary: string,
): string {
	const trimmed = summary.trim();
	const tail = trimmed.length > 0 ? `: ${trimmed}` : "";
	return `⏸ Goal blocked after ${terminationStats(iterations, tokensUsed)}${tail}`;
}

/**
 * Build the multi-line follow-up `pi-goal:status` message body shown when
 * `update_goal({status:"blocked"})` exits the loop (issue #0004). Same shape
 * as `formatTerminationStatus` but with a "Goal blocked" label and the
 * agent's summary appended verbatim.
 */
export function formatBlockedStatus(
	objective: string,
	summary: string,
	iterations: number,
	tokensUsed: number,
): string {
	const trimmed = summary.trim();
	const body = trimmed.length > 0 ? trimmed : "(no blocker summary provided)";
	return (
		`Goal blocked: "${objective}" ` +
		`(${terminationStats(iterations, tokensUsed)}).\n${body}`
	);
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
