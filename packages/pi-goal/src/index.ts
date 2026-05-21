/**
 * pi-goal — autonomous goal-completion loop for pi.
 *
 * Inspired by Claude Code's `/goal` and OpenCode's `/goal` (separate
 * completion-evaluator model) and informed by openai/codex's lifecycle
 * (token budget, kickoff/continue/budget_limit messages). The primary agent
 * does NOT decide whether the goal is complete; a separate small/cheap
 * checker model is the sole arbiter.
 *
 * Lifecycle:
 *   1. /goal <objective>     — enable goal mode, send kickoff message, trigger turn.
 *   2. agent_end              — render recent transcript, run completion checker.
 *      - checker says "complete"   → disable goal mode, post status pill.
 *      - checker says "incomplete" → send continuation message, trigger next turn.
 *      - tokens over budget        → switch to budget_limit message for one
 *                                    final wrap-up turn, then disable.
 *      - iterations over cap       → disable goal mode (safety net).
 *      - checker error / no model  → fail open, continue the loop.
 *   3. interactive input      — user typing cancels goal mode immediately and
 *      aborts any in-flight checker call.
 *   4. session_start          — restore persisted state on resume.
 */

import { completeSimple, getModel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

import {
	createCompletionChecker,
	type CompletionChecker,
} from "./checker.js";
import { buildCheckerTranscript, formatSuccessNotify, formatTerminationNotify, formatTerminationStatus } from "./helpers.js";
import {
	buildBudgetLimitMessage,
	buildContinuationMessage,
	buildKickoffMessage,
	CONTINUE_MESSAGE_TYPE,
	GOAL_CONTEXT_MARKER,
	KICKOFF_MESSAGE_TYPE,
} from "./prompt.js";
import {
	DEFAULT_MAX_ITERATIONS,
	DEFAULT_TOKEN_BUDGET,
	loadGoalConfig,
	pickLatestGoalState,
	STATE_CUSTOM_TYPE,
	type GoalStateCandidateEntry,
	type PersistedGoalState,
} from "./state.js";

const STATUS_KEY = "pi-goal";
const STATUS_MESSAGE_TYPE = "pi-goal:status";

export default function piGoal(pi: ExtensionAPI): void {
	// ---- Persisted goal state (mirrored as plain locals for fast access) ----

	let goalEnabled = false;
	let goalObjective = "";
	let goalIterations = 0;
	let maxIterations = DEFAULT_MAX_ITERATIONS;
	let tokenBudget = DEFAULT_TOKEN_BUDGET;
	let tokenBaseline = 0;
	let goalStartTime = 0;
	/** True after the previous turn pushed us over budget; the next turn is the wrap-up. */
	let budgetExhausted = false;

	/** AbortController for the in-flight checker call (if any). */
	let activeCheckerController: AbortController | undefined;
	/** Lazily-instantiated checker; depends on ctx so we build it inside event handlers. */
	let checker: CompletionChecker | undefined;

	// ---- helpers -----------------------------------------------------------

	function persistState(): void {
		const state: PersistedGoalState = {
			enabled: goalEnabled,
			objective: goalObjective,
			iterations: goalIterations,
			maxIterations,
			tokenBudget,
			tokenBaseline,
		};
		pi.appendEntry(STATE_CUSTOM_TYPE, state);
	}

	function tokensUsedSinceStart(ctx: ExtensionContext): number {
		const usage = ctx.getContextUsage();
		if (!usage || usage.tokens == null) return 0;
		return Math.max(0, usage.tokens - tokenBaseline);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!goalEnabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const used = tokensUsedSinceStart(ctx);
		const remaining = Math.max(0, tokenBudget - used);
		ctx.ui.setStatus(
			STATUS_KEY,
			`◎ goal ${goalIterations}/${maxIterations} · ${remaining.toLocaleString()} tokens left`,
		);
	}

	function getOrCreateChecker(ctx: ExtensionContext): CompletionChecker {
		if (!checker) {
			const config = loadGoalConfig();
			checker = createCompletionChecker({
				completeSimple,
				getModel,
				ctx,
				config: {
					modelOverride: () => config.checkerModel,
					maxTranscriptChars: () => config.checkerTranscriptChars ?? 8_000,
				},
				onError: (err) => {
					if (ctx.hasUI) {
						const msg = err instanceof Error ? err.message : String(err);
						ctx.ui.notify(`pi-goal: checker error — ${msg}`, "warning");
					}
				},
			});
		}
		return checker;
	}

	function disableGoal(ctx: ExtensionContext): void {
		// Abort any in-flight checker call so we don't leak it.
		if (activeCheckerController) {
			activeCheckerController.abort();
			activeCheckerController = undefined;
		}
		goalEnabled = false;
		goalObjective = "";
		goalIterations = 0;
		budgetExhausted = false;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	function enableGoal(objective: string, ctx: ExtensionContext): void {
		const config = loadGoalConfig();
		goalEnabled = true;
		goalObjective = objective;
		goalIterations = 0;
		maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
		tokenBudget = config.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
		tokenBaseline = ctx.getContextUsage()?.tokens ?? 0;
		goalStartTime = Date.now();
		budgetExhausted = false;
		updateStatus(ctx);
		persistState();

		ctx.ui.notify(
			`Goal mode enabled: "${objective}" ` +
				`(budget ${tokenBudget.toLocaleString()} tokens, max ${maxIterations} turns)`,
			"info",
		);

		pi.sendMessage(
			{
				customType: KICKOFF_MESSAGE_TYPE,
				content: buildKickoffMessage(objective),
				display: true,
			},
			{ triggerTurn: true },
		);
	}

	function endGoalSuccess(
		objective: string,
		iterations: number,
		reason: string,
		ctx: ExtensionContext,
	): void {
		const tokensUsed = tokensUsedSinceStart(ctx);
		disableGoal(ctx);
		persistState();
		ctx.ui.notify(formatSuccessNotify(iterations, tokensUsed), "info");
		pi.sendMessage(
			{
				customType: STATUS_MESSAGE_TYPE,
				content:
					`Goal complete: "${objective}" — ` +
					`${iterations} turn(s), ${tokensUsed.toLocaleString()} tokens used.\n${reason}`,
				display: true,
			},
			{ deliverAs: "followUp" },
		);
	}

	function endGoalAborted(reason: string, ctx: ExtensionContext): void {
		const objective = goalObjective;
		const iterations = goalIterations;
		const tokensUsed = tokensUsedSinceStart(ctx);
		disableGoal(ctx);
		persistState();
		ctx.ui.notify(formatTerminationNotify(reason, iterations, tokensUsed), "warning");
		pi.sendMessage(
			{
				customType: STATUS_MESSAGE_TYPE,
				content: formatTerminationStatus(objective, reason, iterations, tokensUsed),
				display: true,
			},
			{ deliverAs: "followUp" },
		);
	}

	// ---- /goal command -----------------------------------------------------

	pi.registerCommand("goal", {
		description:
			"Set a goal and let pi work autonomously across turns. Usage: /goal <objective> | /goal stop | /goal status",
		// eslint-disable-next-line @typescript-eslint/require-await -- registerCommand requires Promise<void>; we have no async work in this handler today, but the contract is async.
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			if (trimmed === "stop") {
				if (!goalEnabled) {
					ctx.ui.notify("Goal mode is not active.", "warning");
					return;
				}
				endGoalAborted("Goal mode cancelled (/goal stop).", ctx);
				return;
			}

			if (trimmed === "status") {
				const used = tokensUsedSinceStart(ctx);
				const remaining = Math.max(0, tokenBudget - used);
				const content = goalEnabled
					? `Goal mode: active\n` +
						`Objective: "${goalObjective}"\n` +
						`Turns: ${goalIterations}/${maxIterations}\n` +
						`Tokens used: ${used.toLocaleString()}/${tokenBudget.toLocaleString()} ` +
						`(remaining: ${remaining.toLocaleString()})`
					: "Goal mode: inactive";
				pi.sendMessage(
					{ customType: STATUS_MESSAGE_TYPE, content, display: true },
					{ deliverAs: "followUp" },
				);
				return;
			}

			if (!trimmed) {
				ctx.ui.notify(
					"Usage: /goal <objective> | /goal stop | /goal status",
					"warning",
				);
				return;
			}

			if (goalEnabled) {
				ctx.ui.notify(
					`Goal mode already active for "${goalObjective}". Use /goal stop first.`,
					"warning",
				);
				return;
			}

			enableGoal(trimmed, ctx);
		},
	});

	// ---- Ctrl+Alt+G shortcut ----------------------------------------------

	pi.registerShortcut(Key.ctrlAlt("g"), {
		description: "Toggle goal mode",
		handler: async (ctx) => {
			if (goalEnabled) {
				endGoalAborted("Goal mode cancelled (Ctrl+Alt+G).", ctx);
				return;
			}
			const objective = await ctx.ui.input("Enter goal objective:", "");
			if (objective?.trim()) {
				enableGoal(objective.trim(), ctx);
			}
		},
	});

	// ---- context filter: drop stale goal-mode messages when goal is off ----

	pi.on("context", (event) => {
		if (goalEnabled) return undefined;
		const filtered = event.messages.filter((m) => {
			const msg = m as typeof m & { customType?: string };
			if (msg.customType === KICKOFF_MESSAGE_TYPE) return false;
			if (msg.customType === CONTINUE_MESSAGE_TYPE) return false;
			if (msg.role !== "user") return true;
			const content = msg.content as unknown;
			if (typeof content === "string") return !content.startsWith(GOAL_CONTEXT_MARKER);
			if (Array.isArray(content)) {
				return !content.some(
					(c) =>
						c != null &&
						typeof c === "object" &&
						(c as { type?: unknown }).type === "text" &&
						typeof (c as { text?: unknown }).text === "string" &&
						(c as { text: string }).text.startsWith(GOAL_CONTEXT_MARKER),
				);
			}
			return true;
		});
		return { messages: filtered };
	});

	// ---- agent_end: run checker, decide loop control -----------------------

	pi.on("agent_end", async (event, ctx) => {
		if (!goalEnabled) return;

		goalIterations += 1;
		updateStatus(ctx);

		// Iteration safety net.
		if (goalIterations >= maxIterations) {
			endGoalAborted(
				`Max turns reached (${goalIterations}/${maxIterations}).`,
				ctx,
			);
			return;
		}

		// Token-budget wrap-up: previous turn was the budget_limit turn.
		if (budgetExhausted) {
			endGoalAborted(
				`Token budget exhausted ` +
					`(${tokensUsedSinceStart(ctx).toLocaleString()}/${tokenBudget.toLocaleString()}).`,
				ctx,
			);
			return;
		}

		// Run completion checker on the fresh transcript we just got from this
		// turn (event.messages is the post-turn snapshot — using sessionManager
		// gave a stale view in earlier iterations).
		const transcript = buildCheckerTranscript(event.messages, GOAL_CONTEXT_MARKER);

		// Cancel any prior in-flight check (defensive — shouldn't normally happen).
		if (activeCheckerController) activeCheckerController.abort();
		const controller = new AbortController();
		activeCheckerController = controller;

		ctx.ui.setStatus(
			STATUS_KEY,
			`◎ goal ${goalIterations}/${maxIterations} · checking…`,
		);

		const result = await getOrCreateChecker(ctx).run({
			objective: goalObjective,
			transcript,
			signal: controller.signal,
		});

		// If we were cancelled mid-flight (user typed input, /goal stop, etc.)
		// the controller is no longer ours and goalEnabled is already false.
		if (activeCheckerController !== controller) return;
		activeCheckerController = undefined;
		if (!goalEnabled) return;

		updateStatus(ctx);

		if (result?.verdict === "complete") {
			endGoalSuccess(
				goalObjective,
				goalIterations,
				`Checker (${result.confidence} confidence): ${result.reason}`,
				ctx,
			);
			return;
		}

		// Token-budget transition: if this turn pushed us over budget, send the
		// wrap-up message instead of a normal continuation. The NEXT agent_end
		// will see budgetExhausted=true and end the loop.
		const tokensUsed = tokensUsedSinceStart(ctx);
		if (tokensUsed >= tokenBudget) {
			budgetExhausted = true;
			persistState();
			pi.sendMessage(
				{
					customType: CONTINUE_MESSAGE_TYPE,
					content: buildBudgetLimitMessage(goalObjective, tokensUsed, tokenBudget),
					display: true,
				},
				{ triggerTurn: true },
			);
			return;
		}

		// Otherwise: normal continuation.
		persistState();
		pi.sendMessage(
			{
				customType: CONTINUE_MESSAGE_TYPE,
				content: buildContinuationMessage(
					goalObjective,
					goalIterations,
					maxIterations,
					tokensUsed,
					tokenBudget,
				),
				display: true,
			},
			{ triggerTurn: true },
		);
		void goalStartTime; // (reserved for future "time-budget" feature)
	});

	// ---- input: cancel on interactive user input --------------------------

	pi.on("input", (event, ctx) => {
		if (!goalEnabled) return undefined;
		// Only interactive input cancels — extension-injected messages
		// (kickoff / continue) and RPC drivers must not cancel themselves.
		if (event.source !== "interactive") return undefined;
		endGoalAborted("Goal mode cancelled (user typed input).", ctx);
		return undefined;
	});

	// ---- session_shutdown: abort in-flight checker -----------------------

	pi.on("session_shutdown", () => {
		if (activeCheckerController) {
			activeCheckerController.abort();
			activeCheckerController = undefined;
		}
	});

	// ---- session_start: restore persisted state ---------------------------

	pi.on("session_start", (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries() as readonly GoalStateCandidateEntry[];
		const state = pickLatestGoalState(entries);

		if (state?.enabled) {
			goalEnabled = true;
			goalObjective = state.objective;
			goalIterations = state.iterations;
			maxIterations = state.maxIterations;
			tokenBudget = state.tokenBudget;
			tokenBaseline = state.tokenBaseline;
			goalStartTime = Date.now(); // wall-clock baseline does not survive restart
		}
		updateStatus(ctx);
	});
}
