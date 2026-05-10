/**
 * Runtime state + poll-loop control for pi-archon-workflow-watcher.
 *
 * Extracted from index.ts for unit-testability — this module has no
 * dependency on pi-tui assembly or command/tool registration.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { ArchonClient } from "./archon-client.js";
import { buildChangeChatMessage, buildStatusLine } from "./format.js";
import { writeSnapshot } from "./persistence.js";
import { detectChanges } from "./poller.js";
import { DB_LOCKED_MARKER } from "./archon-client.js";
import { TERMINAL_STATUSES, type ArchonRun, type RunSnapshot } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default poll interval (ms). Minimum / base rhythm. */
export const POLL_INTERVAL_MS = 15_000;

/**
 * Idle back-off ceiling (ms). When consecutive polls observe no updates the
 * interval doubles from {@link POLL_INTERVAL_MS} up to this cap (5 min).
 * Any detected update snaps the interval back to {@link POLL_INTERVAL_MS}.
 */
export const POLL_INTERVAL_MAX_MS = 5 * 60_000;

/** customType on every chat message this extension injects. */
export const CUSTOM_MESSAGE_TYPE = "pi-archon-workflow-watcher";

/** Status-line key under which we pin our footer row. */
export const STATUS_KEY = "pi-archon-workflow-watcher";

/**
 * Number of consecutive poll failures before a warning chat message is
 * injected.
 */
export const ERROR_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// UI surface + runtime
// ---------------------------------------------------------------------------

export interface UiSurface {
	notify?: (msg: string, level?: string) => void;
	setStatus?: (key: string, text: string | undefined) => void;
	theme?: { fg?: (color: string, text: string) => string };
	hasUI?: boolean;
}

/** Mutable per-process runtime. One instance per extension activation. */
export interface Runtime {
	pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry">;
	client: ArchonClient;
	/**
	 * Snapshot of last known state for watched runs only.
	 * Keyed by run ID. Updated after every poll.
	 */
	snapshot: RunSnapshot;
	/**
	 * Explicitly watched run IDs. The poll loop only tracks these;
	 * all other active archon runs are ignored.
	 */
	watchedIds: Set<string>;
	paused: boolean;
	/** Effective poll interval (ms). Grows on idle, resets on update. */
	pollIntervalMs: number;
	/** Idle back-off base (ms). Separate from pollIntervalMs. */
	idleIntervalMs: number;
	timer: ReturnType<typeof setInterval> | null;
	ui: UiSurface | null;
	consecutiveErrors: number;
}

export function makeRuntime(pi: Runtime["pi"], client: ArchonClient): Runtime {
	return {
		pi,
		client,
		snapshot: {},
		watchedIds: new Set(),
		paused: false,
		pollIntervalMs: POLL_INTERVAL_MS,
		idleIntervalMs: POLL_INTERVAL_MS,
		timer: null,
		ui: null,
		consecutiveErrors: 0,
	};
}

// ---------------------------------------------------------------------------
// Status-line helpers
// ---------------------------------------------------------------------------

function colorize(theme: UiSurface["theme"], text: string): string {
	return theme?.fg ? theme.fg("accent", text) : text;
}

/**
 * Re-pin the extension status line with the current state + counts.
 * When paused, clears the status row instead of showing "paused".
 * Safe to call with no UI.
 */
export function refreshStatus(rt: Runtime): void {
	const watchedCount = rt.watchedIds.size;
	const activeCount = Object.values(rt.snapshot).filter(
		(r) => !TERMINAL_STATUSES.has(r.status),
	).length;
	// Clear the status row when paused or watching nothing.
	if (rt.paused || watchedCount === 0) {
		rt.ui?.setStatus?.(STATUS_KEY, undefined);
		return;
	}
	const text = buildStatusLine({ paused: false, runCount: watchedCount, activeCount });
	rt.ui?.setStatus?.(STATUS_KEY, colorize(rt.ui.theme, text));
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

export function startPolling(rt: Runtime): void {
	if (rt.timer !== null) return;
	rt.timer = setInterval(() => {
		void pollOnce(rt);
	}, rt.pollIntervalMs);
}

/** Change the running interval; restart the timer only when the value changed. */
export function setPollInterval(rt: Runtime, nextMs: number): void {
	if (rt.pollIntervalMs === nextMs) return;
	rt.pollIntervalMs = nextMs;
	stopPolling(rt);
	if (!rt.paused) startPolling(rt);
}

/** Double the idle base (cap {@link POLL_INTERVAL_MAX_MS}) after a quiet poll. */
export function bumpIdleInterval(rt: Runtime): void {
	rt.idleIntervalMs = Math.min(rt.idleIntervalMs * 2, POLL_INTERVAL_MAX_MS);
	setPollInterval(rt, rt.idleIntervalMs);
}

/** Reset both the idle base and effective interval after a poll with updates. */
export function resetIntervalAfterUpdate(rt: Runtime): void {
	rt.idleIntervalMs = POLL_INTERVAL_MS;
	setPollInterval(rt, POLL_INTERVAL_MS);
}

export function stopPolling(rt: Runtime): void {
	if (rt.timer !== null) {
		clearInterval(rt.timer);
		rt.timer = null;
	}
}

/**
 * Single poll cycle.
 *
 * 1. If paused, return immediately.
 * 2. Fetch archon workflow status.
 * 3. On error: increment consecutiveErrors, warn, inject alert at threshold.
 * 4. Build current snapshot (filter empty-id runs).
 * 5. Detect changes vs rt.snapshot.
 * 6. If events: send ONE combined chat message.
 * 7. Update rt.snapshot, persist, refresh status.
 */
export async function pollOnce(rt: Runtime): Promise<void> {
	if (rt.paused) return;
	if (rt.watchedIds.size === 0) return; // nothing to watch

	let allRuns: ArchonRun[];
	try {
		allRuns = await rt.client.getWorkflowStatus();
	} catch (err) {
		const msg = (err as Error).message;
		// db-locked is transient (retries already exhausted in the client).
		// Don't penalise the error counter — just skip this poll quietly.
		if (msg.includes(DB_LOCKED_MARKER)) {
			console.warn("[archon-watcher] poll skipped: database is locked");
			return;
		}
		rt.consecutiveErrors += 1;
		console.warn(`[archon-watcher] poll failed: ${msg}`);
		if (rt.consecutiveErrors === ERROR_THRESHOLD) {
			rt.pi.sendMessage(
				{
					customType: CUSTOM_MESSAGE_TYPE,
					content: `⚠ archon-workflow-watcher: ${ERROR_THRESHOLD} consecutive poll failures. Last error: ${msg}`,
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}
		return;
	}

	rt.consecutiveErrors = 0;

	// Filter to only the runs we are explicitly watching.
	const current: RunSnapshot = {};
	for (const run of allRuns) {
		if (run.id && rt.watchedIds.has(run.id)) {
			current[run.id] = run;
		}
	}

	const events = detectChanges(rt.snapshot, current);

	if (events.length > 0) {
		const triggerTurn = events.some((e) => e.shouldTriggerTurn);
		rt.pi.sendMessage(
			{
				customType: CUSTOM_MESSAGE_TYPE,
				content: buildChangeChatMessage(events, new Date()),
				display: true,
				details: { events },
			},
			{ deliverAs: "followUp", triggerTurn },
		);
		// Auto-remove runs that have ended (disappeared from active list).
		for (const event of events) {
			if (event.eventType === "run_removed") {
				rt.watchedIds.delete(event.runId);
			}
		}
		resetIntervalAfterUpdate(rt);
	} else {
		bumpIdleInterval(rt);
	}

	rt.snapshot = current;
	writeSnapshot(rt.pi, current, rt.watchedIds);
	refreshStatus(rt);

	// Stop polling once nothing remains to watch.
	if (rt.watchedIds.size === 0) stopPolling(rt);
}
