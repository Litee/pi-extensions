/**
 * Runtime state + poll-loop control for pi-archon-workflow-watcher.
 *
 * Extracted from index.ts for unit-testability — this module has no
 * dependency on pi-tui assembly or command/tool registration.
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { PollScheduler } from "pi-watcher-core/poll-scheduler";

import type { ArchonClient } from "./archon-client.js";
import { buildChangeChatMessage, buildStatusLine } from "./format.js";
import { writeState } from "./persistence.js";
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

/**
 * Fire a cmux desktop notification. Fails silently — cmux may not be installed.
 */
function notifyViaCmux(title: string, subtitle: string, body: string): void {
	execFile(
		"cmux",
		["notify", "--title", title, "--subtitle", subtitle, "--body", body],
		() => { /* ignore errors — cmux may not be installed */ },
	);
}

// ---------------------------------------------------------------------------
// UI surface + runtime
// ---------------------------------------------------------------------------

export interface UiSurface {
	notify?: (msg: string, level?: string) => void;
	setStatus?: (key: string, text: string | undefined) => void;
	theme?: { fg?: (color: string, text: string) => string };
	hasUI?: boolean;
	showApprovalDialog?: (params: ApprovalDialogParams) => Promise<ApprovalResult>;
}

export interface ApprovalDialogParams {
	runId: string;
	workflowName: string;
	nodeId: string;
	message: string;
}

export type ApprovalResult =
	| { decision: "approve" }
	| { decision: "reject"; feedback: string }
	| null;

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
	/**
	 * Back-off-aware poll scheduler (pi-watcher-core). Owns the timer,
	 * effective interval, and idle-doubling state machine. Replaces the
	 * former `pollIntervalMs` / `idleIntervalMs` / `timer` triple and the
	 * `bumpIdleInterval` / `resetIntervalAfterUpdate` / `setPollInterval`
	 * helpers.
	 */
	scheduler: PollScheduler;
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
		scheduler: new PollScheduler({
			baseMs: POLL_INTERVAL_MS,
			maxMs: POLL_INTERVAL_MAX_MS,
			idleMaxMs: POLL_INTERVAL_MAX_MS,
		}),
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

/**
 * Handle an approval-type pause by opening a TUI dialog.
 * Fires `archon workflow approve/reject` based on the human's decision.
 * Called fire-and-forget from pollOnce.
 */
async function handleApprovalDialog(rt: Runtime, run: ArchonRun): Promise<void> {
	if (!run.id || !rt.ui?.showApprovalDialog) return;
	const result = await rt.ui.showApprovalDialog({
		runId: run.id,
		workflowName: run.workflowName ?? run.id,
		nodeId: run.approvalNodeId ?? "approval",
		message: run.approvalMessage ?? "",
	});
	if (!result) return; // dismissed without action

	await new Promise<void>((resolve) => {
		const args =
			result.decision === "approve"
				? ["workflow", "approve", run.id!, "approved"]
				: ["workflow", "reject", run.id!, result.feedback];
		execFile("archon", args, () => resolve());
	});
}


/**
 * Start the poll loop. No-op if already running. The internal PollScheduler
 * guarantees the next tick is only scheduled after the previous tick
 * resolves, so a slow `getWorkflowStatus` call can never be re-entered by
 * the timer.
 */
export function startPolling(rt: Runtime): void {
	rt.scheduler.start(() => pollOnce(rt));
}

/** Stop the poll loop. No-op if already stopped. */
export function stopPolling(rt: Runtime): void {
	rt.scheduler.stop();
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
			rt.pi.appendEntry("archon-watcher:poll-skip", { reason: "db-locked" });
			return;
		}
		rt.consecutiveErrors += 1;
		rt.pi.appendEntry("archon-watcher:poll-error", { message: msg });
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
		// For approval-type pauses with a UI, open the TUI dialog instead of
		// sending a chat message (LLM bypassed entirely for those events).
		const approvalEvents = events.filter(
			(e) =>
				e.newStatus === "paused" &&
				current[e.runId]?.approvalType === "approval" &&
				rt.ui?.showApprovalDialog !== undefined,
		);
		const approvalRunIds = new Set(approvalEvents.map((e) => e.runId));

		// Remaining events go to the chat message.
		const chatEvents = events.filter((e) => !approvalRunIds.has(e.runId));

		// Fire TUI dialogs (non-blocking — don't await, poll loop continues).
		for (const event of approvalEvents) {
			const run = current[event.runId];
			if (run) void handleApprovalDialog(rt, run);
		}

		if (chatEvents.length > 0) {
			// triggerTurn only for non-approval paused/terminal events.
			const triggerTurn = chatEvents.some((e) => e.shouldTriggerTurn);
			rt.pi.sendMessage(
				{
					customType: CUSTOM_MESSAGE_TYPE,
					content: buildChangeChatMessage(chatEvents, new Date()),
					display: true,
					details: { events: chatEvents },
				},
				{ deliverAs: "followUp", triggerTurn },
			);
		}

		// cmux desktop notification for paused events (all types).
		for (const event of events) {
			if (event.newStatus === "paused") {
				notifyViaCmux(
					"Archon: input needed",
					event.workflowName,
					event.formatted.replace(/^• /, ""),
				);
			}
		}

		// Auto-remove runs that have ended (disappeared from active list).
		for (const event of events) {
			if (event.eventType === "run_removed") {
				rt.watchedIds.delete(event.runId);
			}
		}
		rt.scheduler.noteSuccess(true);
	} else {
		rt.scheduler.noteSuccess(false);
	}

	rt.snapshot = current;
	writeState(rt.pi, { snapshot: current, watchedIds: rt.watchedIds, paused: rt.paused });
	refreshStatus(rt);

	// Stop polling once nothing remains to watch.
	if (rt.watchedIds.size === 0) stopPolling(rt);
}
