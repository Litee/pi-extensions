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

import type { completeSimple as completeSimpleFn, getModel as getModelFn } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

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
}

const DEFAULT_WIDGET_KEY = "pi-session-recap";
const DEFAULT_STATUS_KEY = "pi-session-recap";

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
): Promise<string | undefined> {
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
			...(model.reasoning ? { reasoning: "minimal" as const } : {}),
		},
	);

	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();

	return firstLine(text);
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
	/** Event hook: clear pending + detach for session_shutdown. */
	reset(): void;
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

	const getLeafId = (): string | undefined => {
		try {
			return deps.ctx.sessionManager.getLeafId() ?? undefined;
		} catch {
			return undefined;
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
		const entries = ctx.sessionManager.getBranch() as Entry[];
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

		try {
			const recap = await runModelCall(transcript, deps, controller.signal);
			if (!recap || controller.signal.aborted) return;
			if (getLeafId() !== startLeaf) return;

			lastDraftedLeafId = startLeaf;
			clearTimer();

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
		if (deps.config.isDisabled() || !deps.ctx.hasUI) return;
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			void runGenerateAndShow({ reason: "idle" });
		}, deps.config.idleMs());
	};

	const onFocusOut = () => {
		focusedOutAt = Date.now();
		if (deps.config.isDisabled() || activeController) return;

		const leaf = getLeafId();
		if (lastDraftedLeafId && leaf === lastDraftedLeafId) return;

		const entries = deps.ctx.sessionManager.getBranch() as Entry[];
		if (!hasMeaningfulActivity(entries)) return;
		void runGenerateAndShow({ reason: "focus" });
	};

	const onFocusIn = () => {
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
		clearTimer();
		cancelActive();
		focusedOutAt = undefined;
		pendingRecap = undefined;
		lastDraftedLeafId = undefined;
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
	};
}
