/**
 * State machine for generating and revealing session recaps.
 *
 * Extracted from `src/index.ts` so the three interacting concerns —
 * the away timer + post-turn debounce, the idle fallback for terminals
 * without focus reporting, and the active-request ownership with
 * fingerprint dedupe — can be unit-tested with a plain deps object and
 * no pi-tui / pi-ai / terminal dependencies.
 *
 * Semantics follow upstream tmustier/pi-extensions session-recap v0.2.2:
 * a recap is only drafted after a *genuine* absence (continuous blur ≥
 * `--recap-away-seconds`, or a turn ending while blurred, or — on
 * terminals that never report focus — an idle timeout after turn_end).
 *
 * See src/index.ts for upstream attribution.
 */

import type { completeSimple as completeSimpleFn, getModel as getModelFn } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	buildTranscript,
	type Entry,
	hasMeaningfulActivity,
	recapStateKey,
	splitModel,
	wrapText,
} from "./helpers.js";
import { buildRecapPrompt, RECAP_SYSTEM_PROMPT } from "./prompt.js";

export type RecapReason = "idle" | "manual" | "resume" | "focus";

type Model = Parameters<typeof completeSimpleFn>[0];

// Debounce after a turn ends while blurred, so mid-loop turn_ends (which are
// immediately followed by the next turn_start) don't trigger drafts.
const POST_TURN_DEBOUNCE_MS = 3000;

// Widget body wrapping.
const WRAP_WIDTH = 100;
const MAX_BODY_LINES = 4;

export interface RecapOrchestratorConfig {
	isAutoEnabled: () => boolean;
	/** Focus reporting is off entirely — the idle fallback is never disarmed. */
	isFocusDisabled?: () => boolean;
	idleMs: () => number;
	/** Continuous-blur threshold before an away recap is drafted. */
	awayMs: () => number;
	/** Spec string for --recap-model override, or undefined to use ctx.model. */
	modelOverride: () => string | undefined;
	/**
	 * Opt-in: allow away-triggered recaps to fire while an agent turn is
	 * still running. Default (undefined or false) preserves the legacy
	 * "always defer until agent_end" behaviour. Mirrors upstream
	 * tmustier/pi-extensions session-recap v0.2.2's `--recap-during-active`.
	 */
	allowDuringActive?: () => boolean;
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
 * and return the flattened recap text. Mirrors the original upstream
 * `generateRecap` function except the prompt text lives in `./prompt.ts`.
 */
async function runModelCall(
	transcript: string,
	deps: RecapOrchestratorDeps,
	signal: AbortSignal,
): Promise<{ text: string | undefined; usage: { input: number; output: number } } | undefined> {
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

	// Note: apiKey may legitimately be absent for env/ambient-auth providers —
	// only bail when auth resolution itself failed.
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok) return undefined;

	let response;
	try {
		response = await completeSimple(
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
				...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
				...(auth.headers ? { headers: auth.headers } : {}),
				...(auth.env ? { env: auth.env } : {}),
				signal,
				// Recaps are tiny, throwaway UI hints. Do not pay to create/read
				// prompt cache entries, and do not spend reasoning tokens.
				cacheRetention: "none" as const,
				maxTokens: 256,
			},
		);
	} catch (err) {
		// Custom providers registered only with pi (e.g. via a bridge extension)
		// are unknown to pi-ai's provider registry, so completeSimple cannot
		// route the call. Skip the recap silently, matching the documented
		// "failed auth resolution → skipped silently" behavior.
		if (err instanceof Error && err.message.startsWith("No API provider registered for api:")) {
			return undefined;
		}
		throw err;
	}

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();

	return {
		text: text ? text.slice(0, 600) : undefined,
		usage: { input: response.usage?.input ?? 0, output: response.usage?.output ?? 0 },
	};
}

export interface RecapOrchestrator {
	/** Event hook: turn ended — arm the away/post-turn and idle-fallback paths. */
	onTurnEnd(): void;
	/** Event hook: turn started — any armed trigger or in-flight draft is stale. */
	onTurnStart(): void;
	/** Event hook: user typed — cancel everything and drop pending state. */
	onInput(): void;
	/** Event hook: agent turn started — defer away recaps until agent_end. */
	onAgentStart(): void;
	/** Event hook: agent turn ended — flush any deferred away recap. */
	onAgentEnd(): void;
	/** Focus reporting: terminal blurred — arm the away timer. */
	onFocusOut(): void;
	/** Focus reporting: terminal focused — cancel the away timer. */
	onFocusIn(): void;
	runGenerateAndShow(opts: { reason: RecapReason }): Promise<void>;
	/** Event hook: clear all pending state for session_shutdown / replacement. */
	reset(): void;
}

/**
 * Build a new orchestrator. One instance per extension load; the outer
 * `pi.on(...)` subscriptions delegate into its methods.
 */
export function createRecapOrchestrator(deps: RecapOrchestratorDeps): RecapOrchestrator {
	const widgetKey = deps.widgetKey ?? DEFAULT_WIDGET_KEY;
	const statusKey = deps.statusKey ?? DEFAULT_STATUS_KEY;

	let idleTimer: ReturnType<typeof setTimeout> | undefined; // fallback for no-focus-support terminals
	let awayTimer: ReturnType<typeof setTimeout> | undefined; // continuous-blur timer
	let postTurnTimer: ReturnType<typeof setTimeout> | undefined; // turn ended while blurred
	let activeController: AbortController | undefined;

	// Agent activity state. Like Claude Code's away summary, we don't draft
	// while a turn is still loading: if the away/post-turn trigger fires
	// mid-turn, we set a pending bit and generate on agent_end (if still
	// blurred). This avoids summarising a half-written branch.
	let agentActive = false;
	let focusDraftAfterAgent = false;

	// Focus reporting state.
	let focusedOutAt: number | undefined;
	// True once we've seen any ESC[I / ESC[O this session — i.e. the terminal
	// demonstrably supports focus reporting, so the idle fallback is redundant.
	let focusEventsSeen = false;

	// Fingerprint of the recap-relevant transcript we last drafted. More
	// precise than the raw branch leaf: pi appends metadata entries such as
	// session names, model/thinking changes, labels, or leaf markers that can
	// advance the leaf without changing the recap prompt at all.
	let lastDraftedStateKey: string | undefined;

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
				// Drop any pending timers — they would hit the same stale
				// ctx on every subsequent fire.
				clearIdleTimer();
				clearAwayTimer();
				clearPostTurnTimer();
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
		const body = wrapText(recap, WRAP_WIDTH, MAX_BODY_LINES).map((l) => theme.fg("dim", l));
		ctx.ui.setWidget(widgetKey, [header, ...body], { placement: "aboveEditor" });
	};

	const clearIdleTimer = () => {
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
	};
	const clearAwayTimer = () => {
		if (awayTimer) {
			clearTimeout(awayTimer);
			awayTimer = undefined;
		}
	};
	const clearPostTurnTimer = () => {
		if (postTurnTimer) {
			clearTimeout(postTurnTimer);
			postTurnTimer = undefined;
		}
	};

	const cancelActive = () => {
		if (activeController) {
			activeController.abort();
			activeController = undefined;
		}
	};

	// The idle fallback only exists for terminals that don't report focus.
	// Once we've seen a real focus event, the away/post-turn triggers own the
	// job and the idle path would just be noise while the user is watching.
	const idleFallbackEligible = (): boolean =>
		(deps.config.isFocusDisabled?.() ?? false) || !focusEventsSeen;

	const fireRecap = (reason: RecapReason) => {
		void runGenerateAndShow({ reason }).catch((err: unknown) => {
			if (isStaleCtxError(err)) return;
			deps.onError?.(err);
		});
	};

	const runGenerateAndShow = async (opts: { reason: RecapReason }): Promise<void> => {
		const ctx = deps.ctx;
		const entries = safeGetBranch();
		if (entries === undefined) return;
		if (!hasMeaningfulActivity(entries) && opts.reason !== "manual") return;

		const transcript = buildTranscript(entries);
		if (!transcript.trim()) {
			if (opts.reason === "manual" && ctx.hasUI)
				ctx.ui.notify("Nothing to recap yet — start a conversation first.", "info");
			return;
		}

		// Snapshot the exact recap prompt we're summarising BEFORE we await. If
		// recap-relevant content changes while the model call is in flight,
		// discard the stale draft; metadata-only branch changes should not
		// invalidate it.
		const startStateKey = recapStateKey(transcript);
		if (opts.reason !== "manual" && lastDraftedStateKey === startStateKey) return;

		// Take ownership of the active-request slot. Any prior request is
		// cancelled; we only clear shared state in the finally if we're still
		// the current owner, so a late-completing aborted call can't stomp on
		// a newer in-flight request.
		cancelActive();
		const controller = new AbortController();
		activeController = controller;

		const showStatus = opts.reason === "manual" || opts.reason === "idle";
		if (showStatus && ctx.hasUI)
			ctx.ui.setStatus(statusKey, ctx.ui.theme.fg("dim", "✦ drafting recap…"));

		deps.onTrigger?.();

		try {
			const result = await runModelCall(transcript, deps, controller.signal);
			if (!result || controller.signal.aborted) return;

			// Accumulate token usage regardless of whether recap text is empty.
			deps.onUsage?.(result.usage);

			if (!result.text) {
				if (opts.reason === "manual" && ctx.hasUI)
					ctx.ui.notify("Recap returned empty — the conversation may be too short.", "info");
				return;
			}

			// Discard the recap if the recap prompt changed while we were
			// drafting. If only session metadata changed, the prompt key stays
			// the same and the draft remains valid.
			const current = safeGetBranch();
			if (current === undefined) return;
			if (recapStateKey(buildTranscript(current)) !== startStateKey) return;

			// Stamp the prompt we actually summarised, not the live branch leaf.
			lastDraftedStateKey = startStateKey;
			// Another trigger has produced a recap for this content — kill the
			// other timers so we don't issue a second call later.
			clearIdleTimer();
			clearPostTurnTimer();

			// Show immediately. Away/post-turn recaps are drafted while the
			// user is away, so the widget is parked above the editor when they
			// return; if they returned mid-draft, it's still the "just got
			// back" moment.
			showRecap(result.text);
		} catch (err) {
			if (!controller.signal.aborted) deps.onError?.(err);
		} finally {
			if (activeController === controller) {
				activeController = undefined;
				if (showStatus && ctx.hasUI) ctx.ui.setStatus(statusKey, undefined);
			}
		}
	};

	// Shared gate for the away-timer / post-turn / deferred-after-agent paths.
	// Requires the terminal to still be blurred.
	const tryAwayRecap = () => {
		if (!deps.config.isAutoEnabled() || !safeHasUI()) return;
		if (focusedOutAt === undefined) return; // user came back — drop it
		if (agentActive && !(deps.config.allowDuringActive?.() ?? false)) {
			// Turn still loading: defer to agent_end (Claude Code's pending bit).
			focusDraftAfterAgent = true;
			return;
		}
		if (activeController) return; // one request at a time

		// runGenerateAndShow fingerprints the recap prompt and returns before
		// the model call when we have already drafted for the same content.
		fireRecap("focus");
	};

	const scheduleIdleRecap = () => {
		clearIdleTimer();
		if (!deps.config.isAutoEnabled() || !safeHasUI()) return;
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			// Re-check at fire time: a focus event may have arrived since arming.
			if (!idleFallbackEligible()) return;
			fireRecap("idle");
		}, deps.config.idleMs());
	};

	const onTurnEnd = () => {
		if (!deps.config.isAutoEnabled() || !safeHasUI()) return;

		// Prime multi-tab moment: the agent produced output while the user is
		// away. Debounced so mid-loop turn_ends (followed by the next
		// turn_start within moments) don't trigger drafts; tryAwayRecap also
		// defers if the agent loop is still active when the timer fires.
		if (focusedOutAt !== undefined) {
			clearPostTurnTimer();
			postTurnTimer = setTimeout(() => {
				postTurnTimer = undefined;
				tryAwayRecap();
			}, POST_TURN_DEBOUNCE_MS);
		}

		// Fallback for terminals without focus reporting.
		if (idleFallbackEligible()) scheduleIdleRecap();
	};

	const onTurnStart = () => {
		// Another turn is starting in the same agent loop — any armed trigger
		// or in-flight draft is stale. The dedupe stamp itself is content-based,
		// so it does not need manual invalidation.
		clearIdleTimer();
		clearPostTurnTimer();
		cancelActive();
	};

	const onInput = () => {
		clearIdleTimer();
		clearPostTurnTimer();
		clearAwayTimer();
		cancelActive();
		focusDraftAfterAgent = false;
	};

	const onAgentStart = () => {
		agentActive = true;
		clearIdleTimer();
		clearPostTurnTimer();
		cancelActive();
	};

	const onAgentEnd = () => {
		agentActive = false;
		if (focusDraftAfterAgent) {
			focusDraftAfterAgent = false;
			tryAwayRecap();
		}
	};

	const onFocusOut = () => {
		focusEventsSeen = true;
		focusedOutAt = Date.now();
		// Focus reporting works — the idle fallback is now redundant.
		clearIdleTimer();
		if (!deps.config.isAutoEnabled()) return;
		clearAwayTimer();
		awayTimer = setTimeout(() => {
			awayTimer = undefined;
			tryAwayRecap();
		}, deps.config.awayMs());
	};

	const onFocusIn = () => {
		focusEventsSeen = true;
		focusedOutAt = undefined;
		focusDraftAfterAgent = false;
		clearAwayTimer();
		// The user is back and looking at the output — a post-turn recap now
		// would just repeat what's on screen.
		clearPostTurnTimer();
		clearIdleTimer();
		// Note: an in-flight draft (triggered by a genuine absence) is left to
		// finish — it lands moments after return, which is exactly when it helps.
	};

	const reset = () => {
		agentActive = false;
		focusDraftAfterAgent = false;
		focusedOutAt = undefined;
		focusEventsSeen = false;
		// Content-based dedupe is per-session state — a fresh session must be
		// able to draft the same content again.
		lastDraftedStateKey = undefined;
		clearIdleTimer();
		clearAwayTimer();
		clearPostTurnTimer();
		cancelActive();
	};

	return {
		onTurnEnd,
		onTurnStart,
		onInput,
		onAgentStart,
		onAgentEnd,
		onFocusOut,
		onFocusIn,
		runGenerateAndShow,
		reset,
	};
}
