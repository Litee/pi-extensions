/**
 * Runtime state + poll-loop control for pi-aws-glue-watcher.
 *
 * Extracted from index.ts for unit-testability — this module has no
 * dependency on pi-tui assembly or command/tool registration.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { PollScheduler } from "pi-watcher-core/poll-scheduler";

import type { GlueClient } from "./glue-client.js";
import { buildChangeChatMessage, buildStatusLine } from "./format.js";
import { writeState } from "./persistence.js";
import { detectJobChanges, detectWorkflowChanges } from "./poller.js";
import type { GlueEvent, WatchMap } from "./types.js";
import type { GlueWidget } from "./ui/glue-widget.js";

/** @see TODO in pollOnce catch block */
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
export const POLL_ERROR_THRESHOLD = 5;

/** customType on every chat message this extension injects. */
export const CUSTOM_MESSAGE_TYPE = "pi-aws-glue-watcher";

/** Status-line key under which we pin our footer row. */
export const STATUS_KEY = "glue-watcher";

// ---------------------------------------------------------------------------
// UI surface + runtime
// ---------------------------------------------------------------------------

export interface UiSurface {
	notify?: (msg: string, level?: string) => void;
	setStatus?: (key: string, text: string | undefined) => void;
	theme?: { fg?: (color: string, text: string) => string };
	hasUI?: boolean;
}

/** Mutable per-process runtime. One instance per `createExtensionWithClient` call. */
export interface Runtime {
	pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry" | "events">;
	client: GlueClient;
	watches: WatchMap;
	paused: boolean;
	enabled: boolean;
	displayMode: "widget" | "statusline";
	/**
	 * Back-off-aware poll scheduler (pi-watcher-core). Owns the timer,
	 * effective interval, and idle-doubling state machine. Replaces the
	 * former `pollIntervalMs` / `idleIntervalMs` / `timer` triple and the
	 * `bumpIdleInterval` / `resetIntervalAfterUpdate` / `setPollInterval`
	 * helpers.
	 */
	scheduler: PollScheduler;
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
		scheduler: new PollScheduler({
			baseMs: POLL_INTERVAL_MS,
			maxMs: POLL_INTERVAL_MAX_MS,
			idleMaxMs: POLL_INTERVAL_MAX_MS,
		}),
		ui: null,
		widget: null,
	};
}

// ---------------------------------------------------------------------------
// Status-line helpers
// ---------------------------------------------------------------------------

export function colorize(theme: UiSurface["theme"], text: string): string {
	return theme?.fg ? theme.fg("accent", text) : text;
}

export function refreshStatus(rt: Runtime): void {
	if (!rt.enabled || rt.displayMode !== "statusline") {
		rt.ui?.setStatus?.(STATUS_KEY, undefined);
		return;
	}
	const hasErrors = Object.values(rt.watches).some(
		(w) => !w.terminal && w.consecutiveErrors >= POLL_ERROR_THRESHOLD,
	);
	const text = buildStatusLine({
		watches: rt.watches,
		paused: rt.paused,
		pollIntervalMs: rt.scheduler.intervalMs,
		hasErrors,
	});
	rt.ui?.setStatus?.(STATUS_KEY, colorize(rt.ui?.theme, text));
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

/**
 * Start the poll loop. No-op if already running. The internal PollScheduler
 * guarantees the next tick is only scheduled after the previous tick
 * resolves, so a slow AWS CLI call can never be re-entered by the timer.
 *
 * Callers are responsible for the `enabled` / `paused` gate — this
 * function unconditionally starts the scheduler once invoked.
 */
export function startPolling(rt: Runtime): void {
	rt.scheduler.start(() => pollOnce(rt));
}

/** Stop the poll loop. No-op if already stopped. */
export function stopPolling(rt: Runtime): void {
	rt.scheduler.stop();
}

/**
 * Single poll cycle. Processes all non-terminal watches in insertion
 * order. Per-watch errors are isolated — one failing watch never blocks
 * the others. The combined event batch lands as a single chat message.
 */
export async function pollOnce(rt: Runtime): Promise<void> {
	if (rt.paused || !rt.enabled) return;

	const active = Object.values(rt.watches).filter((w) => !w.terminal);
	if (active.length === 0) {
		refreshStatus(rt);
		return;
	}

	const allEvents: GlueEvent[] = [];
	let anyUpdate = false;

	for (const watch of active) {
		try {
			const result =
				watch.type === "job"
					? await detectJobChanges(rt.client, watch)
					: await detectWorkflowChanges(rt.client, watch);

			const prevErrors = watch.consecutiveErrors;
			watch.consecutiveErrors = 0;
			watch.baseline = result.newBaseline;
			watch.lastPolledAt = Date.now();

			if (prevErrors >= POLL_ERROR_THRESHOLD) {
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
			}

			if (result.events.length > 0) {
				anyUpdate = true;
				allEvents.push(...result.events);
				if (result.events.some((e) => e.isTerminal)) {
					watch.terminal = true;
				}
			}
		} catch (err) {
			watch.consecutiveErrors = watch.consecutiveErrors + 1;
			// TODO: replace this inline classification with classifyWatcherError() once
			// pi-watcher-core gains predicate support alongside its instanceof-based API.
			// classifyWatcherError currently only accepts class constructors, but SDK
			// errors are identified by .name string, not by prototype chain.
			const errName = (err as Error)?.name ?? "";
			const isAuth = AUTH_ERROR_NAMES.has(errName);
			const isThrottle = THROTTLE_ERROR_NAMES.has(errName);
			const userMessage = isAuth
				? "authentication expired — run aws sso login to re-authenticate"
				: isThrottle
					? "service throttled — will retry"
					: "request failed";
			if (isAuth || isThrottle) {
				rt.scheduler.noteBackoff();
			}
			rt.pi.appendEntry("glue-watcher:poll-error", { type: watch.type, name: watch.name, message: userMessage });
			if (watch.consecutiveErrors === POLL_ERROR_THRESHOLD) {
				rt.pi.sendMessage(
					{
						customType: CUSTOM_MESSAGE_TYPE,
						content:
							`⚠ ${watch.type} '${watch.name}' (${watch.watchId}) ` +
							`has failed ${POLL_ERROR_THRESHOLD} consecutive polls. ` +
							`Last error: ${userMessage}`,
						display: true,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			}
		}
	}

	if (allEvents.length > 0) {
		rt.pi.sendMessage(
			{
				customType: CUSTOM_MESSAGE_TYPE,
				content: buildChangeChatMessage(allEvents, new Date()),
				display: true,
				details: { events: allEvents },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		writeState(rt.pi, rt);
	}

	rt.scheduler.noteSuccess(anyUpdate);
	rt.pi.events.emit("glue:change", {});
	refreshStatus(rt);
}
