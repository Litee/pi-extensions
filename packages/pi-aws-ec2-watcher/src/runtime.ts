/**
 * Runtime state + poll-loop control for pi-aws-ec2-watcher.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_POLL_ERROR_THRESHOLD,
	noteWatchFailure,
	noteWatchSuccess,
} from "pi-watcher-core/error-tracker";
import { PollScheduler } from "pi-watcher-core/poll-scheduler";
import { colorize, type UiSurface } from "pi-watcher-core/ui-surface";

export type { UiSurface } from "pi-watcher-core/ui-surface";
export { colorize } from "pi-watcher-core/ui-surface";

import { buildChangeChatMessage, buildStatusLine } from "./format.js";
import { writeState } from "./persistence.js";
import { buildTimeoutEvent, detectChanges } from "./poller.js";
import type { Ec2Client } from "./ec2-client.js";
import type { Ec2Widget } from "./ui/ec2-widget.js";
import type { Ec2Event, WatchMap } from "./types.js";

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
	"RequestLimitExceeded",
]);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base poll interval (ms). Resets here whenever any observable change is seen. */
export const POLL_INTERVAL_MS = 60_000;

/** Idle back-off ceiling (ms). */
export const POLL_INTERVAL_MAX_MS = 600_000;

/** Consecutive per-watch poll failures before a ⚠ warning is injected. */
export const POLL_ERROR_THRESHOLD = DEFAULT_POLL_ERROR_THRESHOLD;

export const CUSTOM_MESSAGE_TYPE = "pi-aws-ec2-watcher";

export const STATUS_KEY = "pi-aws-ec2-watcher";

/** Name of the tool whose active-set membership controls status-row visibility. */
export const TOOL_NAME = "ec2_instance_watcher";

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface Runtime {
	pi: Pick<
		ExtensionAPI,
		"sendMessage" | "appendEntry" | "events" | "getActiveTools" | "setActiveTools"
	>;
	client: Ec2Client;
	watches: WatchMap;
	paused: boolean;
	enabled: boolean;
	displayMode: "widget" | "statusline";
	scheduler: PollScheduler;
	ui: UiSurface | null;
	widget: Ec2Widget | null;
	now: () => number;
}

export function makeRuntime(pi: Runtime["pi"], client: Ec2Client): Runtime {
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
		now: Date.now,
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
	const result = buildStatusLine({
		watches: rt.watches,
		paused: rt.paused,
		pollIntervalMs: rt.scheduler.intervalMs,
		hasErrors,
	});
	rt.ui?.setStatus?.(STATUS_KEY, colorize(rt.ui?.theme, result.colorAlias, result.text));
}

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

	const allEvents: Ec2Event[] = [];
	let anyObservedChange = false;
	const nowTs = rt.now();

	for (const watch of active) {
		// Timeout check first.
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
								`✓ EC2 instance ${watch.instanceId} (${watch.watchId}) ` +
								`recovered after ${prevErrors} consecutive error(s).`,
							display: true,
						},
						{ deliverAs: "followUp", triggerTurn: false },
					);
				},
			});
			if (result.newBaseline !== undefined) {
				watch.baseline = result.newBaseline;
			}
			watch.lastPolledAt = nowTs;

			if (result.observedChange) anyObservedChange = true;
			if (result.events.length > 0) {
				allEvents.push(...result.events);
				// Mark terminal if the event itself is terminal.
				if (result.events.some((e) => e.isTerminal)) {
					watch.terminal = true;
				}
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
					rt.pi.appendEntry("ec2-watcher:poll-error", {
						instanceId: watch.instanceId,
						message: (raw as Error)?.message ?? String(raw),
					});
				},
				onThresholdMessage: (classified) => {
					rt.pi.sendMessage(
						{
							customType: CUSTOM_MESSAGE_TYPE,
							content:
								`⚠ EC2 instance ${watch.instanceId} (${watch.watchId}) ` +
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
		const baseContent = buildChangeChatMessage(allEvents, new Date(nowTs));
		const content = rt.enabled
			? baseContent
			: baseContent +
			  '\nRun manage_tools({action:"activate", tools:["ec2_instance_watcher"]}) to manage this watcher.';
		rt.pi.sendMessage(
			{
				customType: CUSTOM_MESSAGE_TYPE,
				content,
				display: true,
				details: { events: allEvents },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		writeState(rt.pi, rt);
	}

	rt.scheduler.noteSuccess(anyObservedChange);

	const stillActive = Object.values(rt.watches).some((w) => !w.terminal);
	if (!stillActive) stopPolling(rt);

	rt.pi.events.emit("ec2:change", {});
	refreshStatus(rt);
}
