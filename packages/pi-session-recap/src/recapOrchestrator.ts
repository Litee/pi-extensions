/**
 * State machine for generating and revealing session recaps.
 *
 * Extracted from `src/index.ts` so the four interacting concerns —
 * active-request ownership, the leaf-id snapshot-before-await, the idle
 * timer, and the focus-out/focus-in parking slot — can be unit-tested
 * with a plain deps object and no pi-tui / pi-ai / terminal dependencies.
 *
 * See src/index.ts for upstream attribution.
 */

import type { completeSimple as completeSimpleFn, getModel as getModelFn } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	buildRecentTranscript,
	type Entry,
	firstLine,
	hasMeaningfulActivity,
	splitModel,
} from "./helpers.js";
import { buildRecapPrompt, RECAP_SYSTEM_PROMPT } from "./prompt.js";

export type RecapReason = "idle" | "manual" | "resume" | "focus";

type Model = Parameters<typeof completeSimpleFn>[0];

export interface RecapOrchestratorConfig {
	isDisabled: () => boolean;
	/** Unused by the orchestrator itself; surfaced so the outer index.ts keeps a single config object. */
	isFocusDisabled?: () => boolean;
	idleMs: () => number;
	focusMinMs: () => number;
	/** Spec string for --recap-model override, or undefined to use ctx.model. */
	modelOverride: () => string | undefined;
}

export interface RecapOrchestratorDeps {
	completeSimple: typeof completeSimpleFn;
	getModel: typeof getModelFn;
	ctx: ExtensionContext;
	config: RecapOrchestratorConfig;
	/** Optional status-line + widget keys; defaulted in index.ts. */
	widgetKey?: string;
	statusKey?: string;
	/** Called with unexpected errors from the model call (non-abort). */
	onError?: (err: unknown) => void;
	/** Called each time a recap is triggered (before the model call). */
	onTrigger?: () => void;
	/** Called after each successful model call with the token usage. */
	onUsage?: (usage: { input: number; output: number }) => void;
}

const DEFAULT_WIDGET_KEY = "pi-session-recap";
const DEFAULT_STATUS_KEY = "pi-session-recap";

/**
 * pi's ExtensionRunner throws from every ctx getter once the session has
 * been replaced or reloaded (see runner.assertActive). The error message is
 * stable; we match on a prefix so a minor wording change doesn't silently
 * re-expose the crash.
 */
const STALE_CTX_MESSAGE_PREFIX = "This extension ctx is stale";

function isStaleCtxError(err: unknown): boolean {
	return err instanceof Error && err.message.startsWith(STALE_CTX_MESSAGE_PREFIX);
}

/**
 * Internal: resolve the target model, fetch auth, fire `completeSimple`,
 * and return the first line of the response. Mirrors the original
 * `generateRecap` inline function byte-for-byte except the prompt text
 * now lives in `./prompt.ts`.
 */
async function runModelCall(
	transcript: string,
	deps: RecapOrchestratorDeps,
	signal: AbortSignal,
): Promise<{ text: string; usage: { input: number; output: number } } | undefined> {
	const { completeSimple, getModel, ctx, config } = deps;

	let model: Model | undefined = ctx.model;
	const overrideSpec = config.modelOverride();
	if (overrideSpec) {
		const parsed = splitModel(overrideSpec);
		if (parsed) {
			const found = (getModel as (provider: string, id: string) => Model | undefined)(
				parsed.provider,
				parsed.id,
			);
			if (found) model = found;
		}
	}
	if (!model) return undefined;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok || !auth.apiKey) return undefined;

	const response = await completeSimple(
		model,
		{
			systemPrompt: RECAP_SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: buildRecapPrompt(transcript) }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			...(auth.headers ? { headers: auth.headers } : {}),
			signal,
			// Recaps are tiny, throwaway UI hints — don't pay for prompt-cache
			// entries and don't spend reasoning tokens on them. For reasoning
			// models we still have to set the field; "minimal" is the lowest
			// value SimpleStreamOptions.reasoning accepts (there is no "off"
			// at request time).
			//
			// We deliberately do NOT cap maxTokens here. On AWS Bedrock,
			// adaptive-thinking Claude (Sonnet 4.6, Opus 4.6/4.7) does not run
			// `adjustMaxTokensForThinking`, so a tight cap is shared between
			// thinking and visible text — thinking consumes the budget and the
			// response contains only thinking blocks (which the orchestrator
			// filters out), so the recap widget never renders. The recap
			// prompt asks for a single line, so the model stops itself well
			// before any reasonable provider default.
			...(model.reasoning ? { reasoning: "minimal" as const } : {}),
			cacheRetention: "none" as const,
		},
	);

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();

	return { text: firstLine(text) ?? "", usage: { input: response.usage?.input ?? 0, output: response.usage?.output ?? 0 } };
}

export interface RecapOrchestrator {
	scheduleRecap(): void;
	cancelActive(): void;
	clearTimer(): void;
	onFocusOut(): void;
	onFocusIn(): void;
	runGenerateAndShow(opts: { reason: RecapReason }): Promise<void>;
	/** Event hook: clear draft bookkeeping on new turn / input / agent_start. */
	invalidateDraft(): void;
	/** Event hook: clear all pending state + detach for session_shutdown. */
	reset(): void;
	/** Event hook: agent turn started — defer focus recaps until agent_end. */
	onAgentStart(): void;
	/** Event hook: agent turn ended — flush any deferred focus recap. */
	onAgentEnd(): void;
	/**
	 * Event hook for turn_start: clear timer, cancel active, clear pending state.
	 * More aggressive than clearTimer() alone; mirrors Claude Code's turn_start logic.
	 */
	onTurnStart(): void;
	/** Check and fire any deferred focus recap (called from turn_end). */
	checkDeferredFocus(): void;
}

/**
 * Build a new orchestrator. One instance per extension load; the outer
 * `pi.on(...)` subscriptions delegate into its methods.
 */
export function createRecapOrchestrator(deps: RecapOrchestratorDeps): RecapOrchestrator {
	const widgetKey = deps.widgetKey ?? DEFAULT_WIDGET_KEY;
	const statusKey = deps.statusKey ?? DEFAULT_STATUS_KEY;

	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let activeController: AbortController | undefined;
	let activeReason: RecapReason | undefined;
	let focusedOutAt: number | undefined;
	let pendingRecap: string | undefined;
	let lastDraftedLeafId: string | undefined;
	// Agent activity tracking: defer focus recaps that arrive while the model
	// is still running, mirroring Claude Code's away-summary pending-bit logic.
	let agentActive = false;
	let focusDraftAfterAgent = false;

	const getLeafId = (): string | undefined => {
		try {
			return deps.ctx.sessionManager.getLeafId() ?? undefined;
		} catch {
			return undefined;
		}
	};

	/**
	 * Read the current session branch through the captured ctx. Returns
	 * undefined if the ctx is stale (i.e. a session replacement or reload
	 * landed between scheduling a callback and it firing). Callers must
	 * treat `undefined` as "bail silently" — we can't recover the old
	 * session's state, and the new session has its own orchestrator.
	 */
	const safeGetBranch = (): Entry[] | undefined => {
		try {
			return deps.ctx.sessionManager.getBranch();
		} catch (err) {
			if (isStaleCtxError(err)) {
				// Drop any pending idle timer — it would hit the same stale
				// ctx on every subsequent fire.
				clearTimer();
				return undefined;
			}
			throw err;
		}
	};

	const safeHasUI = (): boolean => {
		try {
			return deps.ctx.hasUI;
		} catch (err) {
			if (isStaleCtxError(err)) return false;
			throw err;
		}
	};

	const showRecap = (recap: string) => {
		const ctx = deps.ctx;
		if (!ctx.hasUI) return;
		const theme = ctx.ui.theme;
		const header = theme.fg("accent", theme.bold("✦ recap"));
		ctx.ui.setWidget(widgetKey, [header, theme.fg("dim", recap)], { placement: "aboveEditor" });
	};

	const clearTimer = () => {
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
	};

	const cancelActive = () => {
		if (activeController) {
			activeController.abort();
			activeController = undefined;
			activeReason = undefined;
		}
	};

	const runGenerateAndShow = async (opts: { reason: RecapReason }): Promise<void> => {
		const ctx = deps.ctx;
		const entries = safeGetBranch();
		if (entries === undefined) return;
		if (!hasMeaningfulActivity(entries) && opts.reason !== "manual") return;

		const transcript = buildRecentTranscript(entries, opts.reason !== "resume");
		if (!transcript.trim()) return;

		// Snapshot the leaf we're summarising BEFORE we await.
		const startLeaf = getLeafId();

		// Take ownership of the active-request slot.
		cancelActive();
		const controller = new AbortController();
		activeController = controller;
		activeReason = opts.reason;

		const showStatus = opts.reason !== "resume" && opts.reason !== "focus";
		if (showStatus && ctx.hasUI)
			ctx.ui.setStatus(statusKey, ctx.ui.theme.fg("dim", "✦ drafting recap…"));

		deps.onTrigger?.();

		try {
			const result = await runModelCall(transcript, deps, controller.signal);
			if (!result || controller.signal.aborted) return;

			// Accumulate token usage regardless of whether recap text is empty.
			deps.onUsage?.(result.usage);

			if (!result.text) return;
			if (getLeafId() !== startLeaf) return;
			lastDraftedLeafId = startLeaf;
			clearTimer();

			const recap = result.text;
			if (opts.reason === "focus") {
				if (focusedOutAt === undefined) showRecap(recap);
				else pendingRecap = recap;
			} else {
				showRecap(recap);
			}
		} catch (err) {
			if (!controller.signal.aborted) deps.onError?.(err);
		} finally {
			if (activeController === controller) {
				activeController = undefined;
				activeReason = undefined;
				if (showStatus && ctx.hasUI) ctx.ui.setStatus(statusKey, undefined);
			}
		}
	};

	const scheduleRecap = () => {
		clearTimer();
		if (deps.config.isDisabled() || !safeHasUI()) return;
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			// The captured ctx may have been invalidated between scheduling
			// and firing (session replaced / reloaded with a dropped
			// session_shutdown). runGenerateAndShow defends its own ctx
			// reads; we additionally guard against any synchronous throw
			// escaping into Timeout._onTimeout as an unhandled rejection.
			void runGenerateAndShow({ reason: "idle" }).catch((err: unknown) => {
				if (isStaleCtxError(err)) return;
				deps.onError?.(err);
			});
		}, deps.config.idleMs());
	};

	const maybeGenerateDeferredFocusRecap = () => {
		if (!focusDraftAfterAgent) return;
		if (focusedOutAt === undefined) return;
		if (agentActive) return;
		focusDraftAfterAgent = false;
		void runGenerateAndShow({ reason: "focus" }).catch((err: unknown) => {
			if (isStaleCtxError(err)) return;
			deps.onError?.(err);
		});
	};

	const onFocusOut = () => {
		focusedOutAt = Date.now();
		// If the agent is mid-turn, don't draft against the half-written branch.
		// Park the request and flush it once agent_end (or turn_end) fires.
		if (agentActive) {
			focusDraftAfterAgent = true;
			return;
		}
		if (deps.config.isDisabled() || activeController) return;

		const leaf = getLeafId();
		if (lastDraftedLeafId && leaf === lastDraftedLeafId) return;

		const entries = safeGetBranch();
		if (entries === undefined) return;
		if (!hasMeaningfulActivity(entries)) return;
		void runGenerateAndShow({ reason: "focus" }).catch((err: unknown) => {
			if (isStaleCtxError(err)) return;
			deps.onError?.(err);
		});
	};

	const onFocusIn = () => {
		focusDraftAfterAgent = false;
		const outAt = focusedOutAt;
		focusedOutAt = undefined;
		if (outAt === undefined) return;
		const duration = Date.now() - outAt;
		if (duration < deps.config.focusMinMs()) {
			pendingRecap = undefined;
			lastDraftedLeafId = undefined;
			if (activeReason === "focus") cancelActive();
			return;
		}
		if (pendingRecap) {
			const recap = pendingRecap;
			pendingRecap = undefined;
			showRecap(recap);
		}
	};

	const invalidateDraft = () => {
		lastDraftedLeafId = undefined;
	};

	const reset = () => {
		agentActive = false;
		focusDraftAfterAgent = false;
		clearTimer();
		cancelActive();
		focusedOutAt = undefined;
		pendingRecap = undefined;
		lastDraftedLeafId = undefined;
	};

	const onAgentStart = () => {
		agentActive = true;
	};

	const onAgentEnd = () => {
		agentActive = false;
		maybeGenerateDeferredFocusRecap();
	};

	const onTurnStart = () => {
		clearTimer();
		cancelActive();
		pendingRecap = undefined;
		lastDraftedLeafId = undefined;
	};

	const checkDeferredFocus = () => {
		maybeGenerateDeferredFocusRecap();
	};

	return {
		scheduleRecap,
		cancelActive,
		clearTimer,
		onFocusOut,
		onFocusIn,
		runGenerateAndShow,
		invalidateDraft,
		reset,
		onAgentStart,
		onAgentEnd,
		onTurnStart,
		checkDeferredFocus,
	};
}
