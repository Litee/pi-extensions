/**
 * Inline prompts for the pi-goal extension.
 *
 * Two LLMs are involved:
 *
 * - The PRIMARY agent (whatever model the user has selected). It receives a
 *   simple "work toward the goal" message each turn. It does NOT decide when
 *   the goal is done; it just produces the next concrete step. Lessons from
 *   our Codex experiment: a single user message per turn (no
 *   `before_agent_start` injection) avoids Bedrock Claude's "model does not
 *   support assistant message prefill" error, and keeping the prompt minimal
 *   prevents the agent from getting trapped in self-audit loops.
 *
 * - The CHECKER (a small/cheap model — Haiku-class by default). It receives
 *   the objective + the most recent transcript and replies with strict JSON.
 *   It is the SOLE arbiter of completion.
 *
 * Both prompts live in source rather than `.md` files so they ship without
 * runtime file I/O and can be unit-tested with plain string assertions.
 */

/** Marker prefix on every goal-mode user message; used by the context filter to strip stale ones once goal mode is disabled. */
export const GOAL_CONTEXT_MARKER = "[goal-mode]";

/** Custom-message types used for goal-mode messages in pi's session log. */
export const KICKOFF_MESSAGE_TYPE = "pi-goal:kickoff";
export const CONTINUE_MESSAGE_TYPE = "pi-goal:continue";

// ---------------------------------------------------------------------------
// Primary-agent messages (all user-role; one per turn)
// ---------------------------------------------------------------------------

/**
 * The very first message after `/goal <objective>` enables goal mode. We
 * announce the goal explicitly so the agent can act on it from turn 1, but we
 * keep the wording minimal so the agent treats this as "answer the request"
 * rather than "audit yourself and emit a special signal".
 */
export function buildKickoffMessage(objective: string): string {
	return (
		`${GOAL_CONTEXT_MARKER}\n` +
		`Goal: ${objective}\n\n` +
		"Make concrete progress on this goal. " +
		"A separate completion-checker model will read your output and decide " +
		"when the goal is done — you do not need to declare completion yourself, " +
		"just produce the next real step or final answer."
	);
}

/**
 * Sent by `agent_end` when the checker decided the goal is not yet complete.
 * Keeps the agent oriented without rehashing audit instructions: the checker
 * already filtered for partial progress.
 */
export function buildContinuationMessage(
	objective: string,
	iteration: number,
	maxIterations: number,
	tokensUsed: number,
	tokenBudget: number,
): string {
	return (
		`${GOAL_CONTEXT_MARKER}\n` +
		`Continue working toward goal: ${objective}\n\n` +
		`Progress: turn ${iteration}/${maxIterations}, ` +
		`${tokensUsed.toLocaleString()}/${tokenBudget.toLocaleString()} tokens used.\n\n` +
		"The completion-checker decided the goal is not yet satisfied. " +
		"Take the next concrete step. Do not stall, ask for confirmation, or " +
		"describe what you would do — just do it."
	);
}

/**
 * Sent on the turn AFTER the token budget has been exceeded, to give the
 * agent one final wrap-up turn before goal mode disables itself. Wording is
 * inspired by Codex's `budget_limit.md` but rewritten to not mention any
 * `update_goal` tool (we don't have one).
 */
export function buildBudgetLimitMessage(
	objective: string,
	tokensUsed: number,
	tokenBudget: number,
): string {
	return (
		`${GOAL_CONTEXT_MARKER}\n` +
		`Goal: ${objective}\n\n` +
		`The token budget for this goal has been exhausted ` +
		`(${tokensUsed.toLocaleString()}/${tokenBudget.toLocaleString()} tokens). ` +
		"This is the FINAL turn of goal mode.\n\n" +
		"Do not start new work. Wrap up cleanly: state the current status, " +
		"hand off whatever has been produced so far, and call out anything that " +
		"still needs to happen so the user can pick it up manually. After this " +
		"turn, goal mode will disable itself automatically."
	);
}

// ---------------------------------------------------------------------------
// Checker messages
// ---------------------------------------------------------------------------

/**
 * System prompt for the checker LLM. We keep it short and direct: the checker
 * has one job — JSON verdict on whether the goal is done. We explicitly
 * carve out the trivial-Q&A case (lesson from the Codex audit prompt: it was
 * too strict for "Calculate 2+2+2+2", which has no command output to cite).
 */
export const CHECKER_SYSTEM_PROMPT =
	"You are a strict completion checker for a coding-agent goal loop. " +
	"Your only job is to decide whether the agent's most recent work satisfies the user's goal. " +
	"Reply with strict JSON only — no prose, no markdown fences.\n\n" +
	"Schema:\n" +
	'{ "verdict": "complete" | "incomplete", ' +
	'"confidence": "low" | "medium" | "high", ' +
	'"reason": "<one sentence, ≤ 200 chars>" }\n\n' +
	"Rules:\n" +
	'- Mark "complete" ONLY when the transcript shows concrete evidence the goal has been satisfied.\n' +
	"- For trivial Q&A, calculation, or explanation goals, the assistant's clear stated answer in the transcript IS the evidence — do not demand command output for these.\n" +
	"- For code-modification goals (edit file X, fix bug Y, add feature Z), require evidence of actual changes: file edits, test runs, or command output cited in the transcript.\n" +
	'- Mark "incomplete" if work remains, the answer is missing or wrong, the agent only described what it would do, or the evidence is too weak to be sure.\n' +
	"- Do NOT shrink, paraphrase, or partially redefine the goal to fit what was done. Judge against the goal as written.";

/**
 * Build the checker's user-message prompt. The transcript is whatever recent
 * agent output is relevant — we deliberately leave selection of the window
 * to the caller so the orchestrator can decide how much history is enough.
 */
export function buildCheckerUserPrompt(objective: string, transcript: string): string {
	return (
		`GOAL: ${objective}\n\n` +
		"--- recent transcript ---\n" +
		`${transcript}\n` +
		"--- end transcript ---\n\n" +
		"Evaluate whether the goal has been satisfied. Reply with strict JSON only."
	);
}
