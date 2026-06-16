/**
 * The `update_goal` pi tool — issue #0004.
 *
 * The only thing this tool does is let the agent signal a genuine blocker:
 * a persistent impasse it cannot resolve without external input (missing
 * credentials, external service outage, contradictory requirements).
 *
 * Calling it pauses the goal loop and surfaces the blocker to the user via
 * a warning notification and a follow-up status message.
 *
 * Completion is NOT signalled through this tool — the verifier checks each
 * turn automatically and exits the loop when the objective is satisfied.
 *
 * The tool is registered by `index.ts` when `/goal <objective>` enables
 * the loop, and removed from the active set when goal mode ends — so it is
 * invisible to the LLM outside a goal run.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const UpdateGoalParams = Type.Object({
	status: Type.Literal("blocked", {
		description: "Must be \"blocked\". Signals a genuine, persistent impasse — see Blocked audit rules.",
	}),
	summary: Type.String({
		description:
			"Concrete description of the blocker. Name what is missing and what the user needs to do or provide so progress can resume.",
	}),
});

export type UpdateGoalArgs = Static<typeof UpdateGoalParams>;

// ---------------------------------------------------------------------------
// Tool result shape
// ---------------------------------------------------------------------------

export interface UpdateGoalResult {
	content: Array<{ type: "text"; text: string }>;
	details: {
		ok: boolean;
		message: string;
	};
}

// ---------------------------------------------------------------------------
// Action handler — pure function, dependency-injected callback
// ---------------------------------------------------------------------------

export interface UpdateGoalCallbacks {
	/** Called with the agent's `summary` to pause the loop on a blocker. */
	onBlocked: (summary: string) => void;
}

/**
 * Execute the action. Pure (apart from invoking the supplied callback) so
 * it can be unit-tested with vi.fn() stubs without spinning up an
 * ExtensionContext.
 */
export function handleUpdateGoal(
	params: UpdateGoalArgs,
	cbs: UpdateGoalCallbacks,
): Promise<UpdateGoalResult> {
	const summary = (params.summary ?? "").trim();
	cbs.onBlocked(summary);
	const message = `update_goal: blocked — ${summary || "(no summary)"}`;
	return Promise.resolve({
		content: [{ type: "text", text: message }],
		details: { ok: true, message },
	});
}

// ---------------------------------------------------------------------------
// Tool registration — lazy & idempotent
// ---------------------------------------------------------------------------

let toolRegistered = false;

/** Reset the module-level registration flag. Test-only. */
export function resetUpdateGoalToolRegisteredForTests(): void {
	toolRegistered = false;
}

/**
 * Register the `update_goal` tool with pi. Safe to call multiple times —
 * subsequent calls are no-ops.
 *
 * `resolveCallbacks(ctx)` is called fresh on every `execute` so the loop's
 * mutable state (current iteration count, token baseline) is read late
 * rather than captured at registration time.
 */
export function registerUpdateGoalTool(
	pi: ExtensionAPI,
	resolveCallbacks: (ctx: ExtensionContext) => UpdateGoalCallbacks,
): void {
	if (toolRegistered) return;
	toolRegistered = true;
	pi.registerTool({
		name: "update_goal",
		label: "Update Goal",
		description:
			"Signal a genuine, persistent blocker that prevents you from completing the goal. " +
			"Set status='blocked' and describe the impasse in summary. " +
			"See the Blocked audit rules in the continuation prompt. " +
			"Do NOT call this to declare success; the verifier handles completion automatically.",
		promptSnippet:
			"update_goal({status:'blocked', summary}) — signal a genuine blocker (verifier handles completion automatically)",
		parameters: UpdateGoalParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return handleUpdateGoal(params, resolveCallbacks(ctx));
		},
	});
}
