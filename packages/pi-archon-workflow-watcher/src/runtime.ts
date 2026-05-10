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
import { TERMINAL_STATUSES, type ArchonRun, type RunSnapshot } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Poll interval — 15 s. */
export const POLL_INTERVAL_MS = 15_000;

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
	snapshot: RunSnapshot;
	paused: boolean;
	timer: ReturnType<typeof setInterval> | null;
	ui: UiSurface | null;
	consecutiveErrors: number;
}

export function makeRuntime(pi: Runtime["pi"], client: ArchonClient): Runtime {
	return {
		pi,
		client,
		snapshot: {},
		paused: false,
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
	if (rt.paused) {
		rt.ui?.setStatus?.(STATUS_KEY, undefined);
		return;
	}
	const runCount = Object.keys(rt.snapshot).length;
	const activeCount = Object.values(rt.snapshot).filter(
		(r) => !TERMINAL_STATUSES.has(r.status),
	).length;
	const text = buildStatusLine({ paused: false, runCount, activeCount });
	rt.ui?.setStatus?.(STATUS_KEY, colorize(rt.ui.theme, text));
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

export function startPolling(rt: Runtime): void {
	if (rt.timer !== null) return;
	rt.timer = setInterval(() => {
		void pollOnce(rt);
	}, POLL_INTERVAL_MS);
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

	let runs: ArchonRun[];
	try {
		runs = await rt.client.getWorkflowStatus();
	} catch (err) {
		rt.consecutiveErrors += 1;
		console.warn(
			`[archon-watcher] poll failed: ${(err as Error).message}`,
		);
		if (rt.consecutiveErrors === ERROR_THRESHOLD) {
			rt.pi.sendMessage(
				{
					customType: CUSTOM_MESSAGE_TYPE,
					content: `⚠ archon-workflow-watcher: ${ERROR_THRESHOLD} consecutive poll failures. Last error: ${(err as Error).message}`,
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}
		return;
	}

	rt.consecutiveErrors = 0;

	// Build current snapshot, filtering out runs with empty id
	const current: RunSnapshot = {};
	for (const run of runs) {
		if (run.id) {
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
	}

	rt.snapshot = current;
	writeSnapshot(rt.pi, current);
	refreshStatus(rt);
}
