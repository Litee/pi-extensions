/**
 * Runtime state + poll-loop control for pi-aws-glue-watcher.
 *
 * Extracted from index.ts for unit-testability — this module has no
 * dependency on pi-tui assembly or command/tool registration.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_POLL_ERROR_THRESHOLD, noteWatchFailure, noteWatchSuccess } from "pi-watcher-core/error-tracker";
import { PollScheduler } from "pi-watcher-core/poll-scheduler";
import { colorize, type UiSurface } from "pi-watcher-core/ui-surface";

import type { GlueClient } from "./glue-client.js";
import { buildChangeChatMessage, buildStatusLine } from "./format.js";
import { writeState } from "./persistence.js";
import { detectJobChanges, detectWorkflowChanges } from "./poller.js";
import type { GlueEvent, WatchMap } from "./types.js";
import type { GlueWidget } from "./ui/glue-widget.js";

export type { UiSurface } from "pi-watcher-core/ui-surface";
export { colorize, extractUiSurface } from "pi-watcher-core/ui-surface";

const AUTH_ERROR_NAMES = new Set([
	"CredentialsProviderError",
	"TokenProviderError",
	"ProviderError",
]);
const THROTTLE_ERROR_NAMES = new Set([
	"ThrottlingException",
	"TooManyRequestsException",
]);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default poll interval (ms). Minimum / base rhythm. */
export const POLL_INTERVAL_MS = 120_000;

/**
 * Idle back-off ceiling (ms). When consecutive polls observe no updates the
 * interval doubles from {@link POLL_INTERVAL_MS} up to this cap (15 min).
 * Any detected update snaps the interval back to {@link POLL_INTERVAL_MS}.
 */
export const POLL_INTERVAL_MAX_MS = 900_000;

/**
 * Number of consecutive per-watch poll failures before a warning chat
 * message is injected. The same threshold triggers the ⚠ indicator in the
 * status line.
 */
export const POLL_ERROR_THRESHOLD = DEFAULT_POLL_ERROR_THRESHOLD;

/** customType on every chat message this extension injects. */
export const CUSTOM_MESSAGE_TYPE = "pi-aws-glue-watcher";

/** Status-line key under which we pin our footer row. */
export const STATUS_KEY = "glue-watcher";

// ---------------------------------------------------------------------------
// UI surface + runtime
// ---------------------------------------------------------------------------

/** Mutable per-process runtime. One instance per `createExtensionWithClient` call. */
export interface Runtime {
	pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry" | "events">;
	client: GlueClient;
	watches: WatchMap;
	paused: boolean;
	enabled: boolean;
	displayMode: "widget" | "statusline";
	/**
	 * Per-watch poll schedulers keyed by watchId. Each watch runs its own
	 * back-off-aware scheduler so idle back-off and throttle back-off are
	 * independent between watches.
	 */
	schedulers: Map<string, PollScheduler>;
	ui: UiSurface | null;
	widget: GlueWidget | null;
}

export function makeRuntime(pi: Runtime["pi"], client: GlueClient): Runtime {
	return {
		pi,
		client,
		watches: {},
		paused: false,
		enabled: false,
		displayMode: "widget",
		schedulers: new Map(),
		ui: null,
		widget: null,
	};
}

// ---------------------------------------------------------------------------
// Status-line helpers
// ---------------------------------------------------------------------------

export function refreshStatus(rt: Runtime): void {
	if (rt.displayMode !== "statusline") {
		rt.ui?.setStatus?.(STATUS_KEY, undefined);
		return;
	}
	const hasErrors = Object.values(rt.watches).some(
		(w) => !w.terminal && w.consecutiveErrors >= POLL_ERROR_THRESHOLD,
	);
	const intervalMs = minIntervalMs(rt);
	const result = buildStatusLine({
		watches: rt.watches,
		paused: rt.paused,
		pollIntervalMs: intervalMs,
		hasErrors,
	});
	rt.ui?.setStatus?.(STATUS_KEY, colorize(rt.ui?.theme, result.colorAlias, result.text));
}

/**
 * Toggle between the permanent widget and the compact status line.
 * Persists the new mode and immediately updates the UI.
 */
export function toggleDisplayMode(rt: Runtime, ctx: unknown): void {
	rt.displayMode = rt.displayMode === "widget" ? "statusline" : "widget";
	writeState(rt.pi, rt);
	if (rt.displayMode === "widget") {
		rt.ui?.setStatus?.(STATUS_KEY, undefined);
		rt.widget?.show(ctx);
	} else {
		rt.widget?.hide(ctx);
		refreshStatus(rt);
	}
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Per-watch scheduler helpers
// ---------------------------------------------------------------------------

/** Return the minimum effective interval across all running schedulers, or POLL_INTERVAL_MS. */
export function minIntervalMs(rt: Runtime): number {
	if (rt.schedulers.size === 0) return POLL_INTERVAL_MS;
	let min = Infinity;
	for (const s of rt.schedulers.values()) min = Math.min(min, s.intervalMs);
	return min === Infinity ? POLL_INTERVAL_MS : min;
}

/**
 * Ensure a per-watch PollScheduler exists and is running for the given watch.
 * No-op if the scheduler for this watchId is already running.
 *
 * @param delayMs Optional initial delay before the first tick (ms). Used by
 *   `startPolling` to stagger simultaneous schedulers and avoid a burst of
 *   back-to-back chat messages when multiple watches are started together.
 */
export function startWatchPolling(rt: Runtime, watchId: string, delayMs = 0): void {
	if (rt.paused) return;
	const watch = rt.watches[watchId];
	if (!watch || watch.terminal) return;
	if (rt.schedulers.has(watchId) && rt.schedulers.get(watchId)!.isRunning) return;
	const baseMs = watch.pollIntervalMs ?? POLL_INTERVAL_MS;
	const scheduler = new PollScheduler({
		baseMs,
		maxMs: POLL_INTERVAL_MAX_MS,
		idleMaxMs: POLL_INTERVAL_MAX_MS,
	});
	rt.schedulers.set(watchId, scheduler);
	if (delayMs > 0) {
		setTimeout(() => {
			// Use identity check: the map entry must still be THIS scheduler
			// instance. If stopWatchPolling + startWatchPolling ran during the
			// delay window a new scheduler is in the map; don't start the old one.
			if (rt.schedulers.get(watchId) === scheduler && !scheduler.isRunning) {
				scheduler.start(() => pollWatch(rt, watchId));
			}
		}, delayMs);
	} else {
		scheduler.start(() => pollWatch(rt, watchId));
	}
}

/**
 * Stop and remove the per-watch scheduler for the given watchId.
 * No-op if no scheduler exists for it.
 */
export function stopWatchPolling(rt: Runtime, watchId: string): void {
	const s = rt.schedulers.get(watchId);
	if (s) {
		s.stop();
		rt.schedulers.delete(watchId);
	}
}

/**
 * Start per-watch schedulers for all non-terminal watches. No-op for any
 * watch that already has a running scheduler. Staggers startup by 2s per
 * watch to de-correlate simultaneous schedulers and avoid message bursts.
 */
export function startPolling(rt: Runtime): void {
	const active = Object.values(rt.watches).filter((w) => !w.terminal);
	for (let i = 0; i < active.length; i++) {
		startWatchPolling(rt, active[i]!.watchId, i * 2000);
	}
}

/** Stop and remove all per-watch schedulers. */
export function stopPolling(rt: Runtime): void {
	for (const [id, s] of rt.schedulers) {
		s.stop();
		rt.schedulers.delete(id);
	}
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

/**
 * Poll a single watch. Called by its per-watch PollScheduler. Applies
 * back-off to that watch's scheduler only, emits events for that watch,
 * and stops the scheduler when the run reaches a terminal state.
 */
export async function pollWatch(rt: Runtime, watchId: string): Promise<void> {
	if (rt.paused) return;
	const watch = rt.watches[watchId];
	if (!watch || watch.terminal) {
		stopWatchPolling(rt, watchId);
		return;
	}

	// Ensure a scheduler exists for the pollOnce/direct-call path.
	// In production each scheduler invokes pollWatch directly, so the entry
	// is always present. pollOnce calls pollWatch without a pre-existing
	// scheduler, so we create one here.
	if (!rt.schedulers.has(watchId)) {
		startWatchPolling(rt, watchId);
	}
	const scheduler = rt.schedulers.get(watchId)!;
	const events: GlueEvent[] = [];
	let anyUpdate = false;

	try {
		const result =
			watch.type === "job"
				? await detectJobChanges(rt.client, watch)
				: await detectWorkflowChanges(rt.client, watch);

		noteWatchSuccess(watch, {
			onRecover: (prevErrors) => {
				rt.pi.sendMessage(
					{
						customType: CUSTOM_MESSAGE_TYPE,
						content:
							`✓ ${watch.type} '${watch.name}' (${watch.watchId}) ` +
							`recovered after ${prevErrors} consecutive error(s).`,
						display: true,
					},
					{ deliverAs: "followUp", triggerTurn: false },
				);
			},
		});
		watch.baseline = result.newBaseline;
		watch.lastPolledAt = Date.now();

		if (result.events.length > 0) {
			anyUpdate = true;
			events.push(...result.events);
			if (result.events.some((e) => e.isTerminal)) {
				watch.terminal = true;
				stopWatchPolling(rt, watchId);
			}
		}
	} catch (err) {
		noteWatchFailure(watch, {
			err,
			classifyOpts: {
				authPredicate: (e) => AUTH_ERROR_NAMES.has((e as Error)?.name ?? ""),
				throttlePredicate: (e) => THROTTLE_ERROR_NAMES.has((e as Error)?.name ?? ""),
				authMessage: "authentication expired — run `aws sso login` to re-authenticate",
			},
			scheduler,
			onAppendError: (_classified, raw) => {
				rt.pi.appendEntry("glue-watcher:poll-error", {
					type: watch.type,
					name: watch.name,
					message: (raw as Error)?.message ?? String(raw),
				});
			},
			onThresholdMessage: (classified) => {
				rt.pi.sendMessage(
					{
						customType: CUSTOM_MESSAGE_TYPE,
						content:
							`⚠ ${watch.type} '${watch.name}' (${watch.watchId}) ` +
							`has failed ${POLL_ERROR_THRESHOLD} consecutive polls. ` +
							`Last error: ${classified.userMessage}`,
						display: true,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			},
		});
	}

	if (events.length > 0) {
		const baseContent = buildChangeChatMessage(events, new Date());
		const content = rt.enabled
			? baseContent
			: baseContent +
			  '\nRun manage_tools({action:"activate", tools:["glue_watcher"]}) to manage this watcher.';
		rt.pi.sendMessage(
			{
				customType: CUSTOM_MESSAGE_TYPE,
				content,
				display: true,
				details: { events },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		writeState(rt.pi, rt);
	}

	if (scheduler) scheduler.noteSuccess(anyUpdate);
	rt.pi.events.emit("glue:change", {});
	refreshStatus(rt);
}

/**
 * Poll all non-terminal watches sequentially. Used in tests and as a
 * convenience path; in production each watch has its own scheduler.
 */
export async function pollOnce(rt: Runtime): Promise<void> {
	if (rt.paused) return;
	const active = Object.values(rt.watches).filter((w) => !w.terminal);
	if (active.length === 0) {
		refreshStatus(rt);
		return;
	}
	for (const watch of active) {
		await pollWatch(rt, watch.watchId);
	}
}
