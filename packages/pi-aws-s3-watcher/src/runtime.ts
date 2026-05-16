/**
 * Runtime state + poll-loop control for pi-aws-s3-watcher.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_POLL_ERROR_THRESHOLD, noteWatchFailure, noteWatchSuccess } from "pi-watcher-core/error-tracker";
import { PollScheduler } from "pi-watcher-core/poll-scheduler";
import { colorize, type UiSurface } from "pi-watcher-core/ui-surface";

export type { UiSurface } from "pi-watcher-core/ui-surface";
export { colorize } from "pi-watcher-core/ui-surface";

import { buildChangeChatMessage, buildStatusLine } from "./format.js";
import { writeState } from "./persistence.js";
import { buildTimeoutEvent, detectChanges } from "./poller.js";
import type { S3Client } from "./s3-client.js";
import type { S3Event, WatchMap } from "./types.js";

const AUTH_ERROR_NAMES = new Set([
	"CredentialsProviderError",
	"TokenProviderError",
	"ProviderError",
	"ExpiredToken",
	"ExpiredTokenException",
]);
const THROTTLE_ERROR_NAMES = new Set([
	"ThrottlingException",
	"TooManyRequestsException",
	"SlowDown",
	"RequestLimitExceeded",
]);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base poll interval (ms). Resets here whenever any observable change is seen. */
export const POLL_INTERVAL_MS = 60_000;

/**
 * Idle back-off ceiling (ms). Each poll that observes no change doubles the
 * interval from {@link POLL_INTERVAL_MS} up to this cap (15 min).
 */
export const POLL_INTERVAL_MAX_MS = 900_000;

/** Consecutive per-watch poll failures before a ⚠ warning is injected. */
export const POLL_ERROR_THRESHOLD = DEFAULT_POLL_ERROR_THRESHOLD;

export const CUSTOM_MESSAGE_TYPE = "pi-aws-s3-watcher";

export const STATUS_KEY = "pi-aws-s3-watcher";

/** Name of the tool whose active-set membership controls status-row visibility. */
export const TOOL_NAME = "s3_watcher";

// ---------------------------------------------------------------------------
// UI surface + runtime
// ---------------------------------------------------------------------------

export interface Runtime {
	pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry" | "events" | "getActiveTools" | "setActiveTools">;
	client: S3Client;
	watches: WatchMap;
	paused: boolean;
	/**
	 * Whether the s3_watcher tool has been explicitly activated in this session.
	 * Defaults to false — pi auto-adds extension tools on startup but we
	 * immediately undo that unless persisted enabled=true.
	 */
	enabled: boolean;
	scheduler: PollScheduler;
	ui: UiSurface | null;
	now: () => number;
}

export function makeRuntime(pi: Runtime["pi"], client: S3Client): Runtime {
	return {
		pi,
		client,
		watches: {},
		paused: false,
		enabled: false,
		scheduler: new PollScheduler({
			baseMs: POLL_INTERVAL_MS,
			maxMs: POLL_INTERVAL_MAX_MS,
			idleMaxMs: POLL_INTERVAL_MAX_MS,
		}),
		ui: null,
		now: Date.now,
	};
}

// ---------------------------------------------------------------------------
// Status-line helpers
// ---------------------------------------------------------------------------

export function refreshStatus(rt: Runtime): void {
	// Gate on persisted enabled flag, not getActiveTools(). Pi auto-activates
	// all extension tools on session start regardless of user intent;
	// rt.enabled is the reliable source of truth.
	if (!rt.enabled) {
		rt.ui?.setStatus?.(STATUS_KEY, undefined);
		return;
	}
	const hasErrors = Object.values(rt.watches).some(
		(w) => !w.terminal && w.consecutiveErrors >= POLL_ERROR_THRESHOLD,
	);
	const result = buildStatusLine({
		watches: rt.watches,
		paused: rt.paused,
		pollIntervalMs: rt.scheduler.intervalMs,
		hasErrors,
	});
	rt.ui?.setStatus?.(STATUS_KEY, colorize(rt.ui?.theme, result.colorAlias, result.text));
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

export function startPolling(rt: Runtime): void {
	rt.scheduler.start(() => pollOnce(rt));
}

export function stopPolling(rt: Runtime): void {
	rt.scheduler.stop();
}

/**
 * Single poll cycle. Per-watch errors are isolated; the combined event
 * batch lands as a single chat message.
 */
export async function pollOnce(rt: Runtime): Promise<void> {
	if (rt.paused) return;

	const active = Object.values(rt.watches).filter((w) => !w.terminal);
	if (active.length === 0) {
		refreshStatus(rt);
		return;
	}

	const allEvents: S3Event[] = [];
	let anyObservedChange = false;
	const nowTs = rt.now();

	for (const watch of active) {
		// Timeout check first — an elapsed timeout short-circuits the HeadObject call.
		if (watch.timeoutAt !== undefined && nowTs >= watch.timeoutAt) {
			const ev = buildTimeoutEvent(watch);
			allEvents.push(ev);
			watch.terminal = true;
			anyObservedChange = true;
			continue;
		}

		try {
			const result = await detectChanges(rt.client, watch);
			noteWatchSuccess(watch, {
				onRecover: (prevErrors) => {
					rt.pi.sendMessage(
						{
							customType: CUSTOM_MESSAGE_TYPE,
							content:
								`✓ s3://${watch.bucket}/${watch.key} (${watch.watchId}) ` +
								`recovered after ${prevErrors} consecutive error(s).`,
							display: true,
						},
						{ deliverAs: "followUp", triggerTurn: false },
					);
				},
			});
			watch.baseline = result.newBaseline;
			watch.lastPolledAt = nowTs;

			if (result.observedChange) anyObservedChange = true;
			if (result.events.length > 0) {
				allEvents.push(...result.events);
				watch.terminal = true; // target fired exactly once → stop polling this watch.
			}
		} catch (err) {
			noteWatchFailure(watch, {
				err,
				classifyOpts: {
					authPredicate: (e) => AUTH_ERROR_NAMES.has((e as Error)?.name ?? ""),
					throttlePredicate: (e) => THROTTLE_ERROR_NAMES.has((e as Error)?.name ?? ""),
					authMessage: "authentication expired — refresh AWS credentials",
				},
				scheduler: rt.scheduler,
				onAppendError: (_classified, raw) => {
					rt.pi.appendEntry("s3-watcher:poll-error", {
						bucket: watch.bucket,
						key: watch.key,
						message: (raw as Error)?.message ?? String(raw),
					});
				},
				onThresholdMessage: (classified) => {
					rt.pi.sendMessage(
						{
							customType: CUSTOM_MESSAGE_TYPE,
							content:
								`⚠ s3://${watch.bucket}/${watch.key} (${watch.watchId}) ` +
								`has failed ${POLL_ERROR_THRESHOLD} consecutive polls. ` +
								`Last error: ${classified.userMessage}`,
							display: true,
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
				},
			});
		}
	}

	if (allEvents.length > 0) {
		rt.pi.sendMessage(
			{
				customType: CUSTOM_MESSAGE_TYPE,
				content: buildChangeChatMessage(allEvents, new Date(nowTs)),
				display: true,
				details: { events: allEvents },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		writeState(rt.pi, rt);
	}

	// Scheduler: any observable change (target-hit, timeout, or intermediate
	// update) resets to base; otherwise idle-double up to the 15min cap.
	rt.scheduler.noteSuccess(anyObservedChange);

	// Stop the loop once every watch is terminal — there is nothing left to poll.
	const stillActive = Object.values(rt.watches).some((w) => !w.terminal);
	if (!stillActive) stopPolling(rt);

	rt.pi.events.emit("s3:change", {});
	refreshStatus(rt);
}
