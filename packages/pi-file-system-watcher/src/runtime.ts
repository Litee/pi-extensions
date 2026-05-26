/**
 * Runtime state + poll-loop control for pi-file-system-watcher.
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
import type { FsBaseline, FsEvent, FsWatch, WatchMap } from "./types.js";
import { tryCreateFsWatch, type FsWatchHandle } from "./watcher.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base poll interval (ms). Resets here whenever any observable change is seen. */
export const POLL_INTERVAL_MS = 5_000;

/**
 * Idle back-off ceiling (ms). Each quiet poll doubles the interval from
 * {@link POLL_INTERVAL_MS} up to this cap (5 min).
 */
export const POLL_INTERVAL_MAX_MS = 300_000;

/** Consecutive per-watch poll failures before a ⚠ warning is injected. */
export const POLL_ERROR_THRESHOLD = DEFAULT_POLL_ERROR_THRESHOLD;

export const CUSTOM_MESSAGE_TYPE = "pi-file-system-watcher";

export const STATUS_KEY = "pi-file-system-watcher";

/** Name of the tool whose active-set membership controls status-row visibility. */
export const TOOL_NAME = "file_system_watcher";

/** Default debounce window for fs.watch events (ms). */
export const DEFAULT_DEBOUNCE_MS = 500;

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export type PiMinimal = Pick<
	ExtensionAPI,
	"sendMessage" | "appendEntry" | "events" | "getActiveTools" | "setActiveTools"
>;

export interface Runtime {
	pi: PiMinimal;
	/**
	 * Injectable snapshot function. Defaults to `snapshotPath` from poller.ts.
	 * Tests supply a stub so real `fs.promises.stat` is never called in unit tests.
	 * `detectChanges` in poller.ts also accepts this as a parameter.
	 */
	snapshot: (path: string) => Promise<FsBaseline>;
	watches: WatchMap;
	paused: boolean;
	/**
	 * Whether `file_system_watcher` has been explicitly activated in this session.
	 * Defaults to false — pi auto-adds extension tools on startup but we
	 * immediately undo that unless persisted `enabled=true`.
	 */
	enabled: boolean;
	displayMode: "widget" | "statusline";
	scheduler: PollScheduler;
	ui: UiSurface | null;
	/**
	 * Active fs.watch handles keyed by watchId. Disposed on watch removal
	 * or session_shutdown.
	 */
	watchHandles: Map<string, FsWatchHandle>;
	/** Prevents concurrent pollOnce invocations (scheduler + fs.watch overlap). */
	pollInFlight: boolean;
	now: () => number;
}

export function makeRuntime(pi: Runtime["pi"], snapshot: Runtime["snapshot"]): Runtime {
	return {
		pi,
		snapshot,
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
		watchHandles: new Map(),
		pollInFlight: false,
		now: Date.now,
	};
}

// ---------------------------------------------------------------------------
// fs.watch handle lifecycle
// ---------------------------------------------------------------------------

/**
 * Set up an `fs.watch` listener for `watch` (if the watch's mode permits it).
 *
 * - `mode: 'poll'`: no-op — polling only.
 * - `mode: 'auto'` | `'event'`: attempt to create a listener; falls back
 *   silently on ENOSYS / EPERM or if the path does not currently exist.
 *
 * When the listener fires it triggers an immediate `pollOnce` outside the
 * normal schedule for fast notifications.
 */
export function setupWatchFs(rt: Runtime, watch: FsWatch, debounceMs = DEFAULT_DEBOUNCE_MS): void {
	if (watch.mode === "poll") return;
	const handle = tryCreateFsWatch(watch.path, () => {
		void pollOnce(rt);
	}, debounceMs);
	if (handle) rt.watchHandles.set(watch.watchId, handle);
}

/** Dispose the fs.watch handle for `watchId` if one exists. */
export function teardownWatchFs(rt: Runtime, watchId: string): void {
	const handle = rt.watchHandles.get(watchId);
	if (handle) {
		handle.dispose();
		rt.watchHandles.delete(watchId);
	}
}

/** Dispose ALL fs.watch handles (called on session_shutdown). */
export function teardownAllWatchHandles(rt: Runtime): void {
	for (const [id, handle] of rt.watchHandles) {
		handle.dispose();
		rt.watchHandles.delete(id);
	}
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
 * Single poll cycle. Per-watch errors are isolated; the combined event batch
 * lands as a single chat message.
 *
 * Protected by `pollInFlight` against concurrent invocations when the
 * fs.watch fast-path and the scheduler tick overlap.
 */
export async function pollOnce(rt: Runtime): Promise<void> {
	if (rt.paused) return;
	if (rt.pollInFlight) return;
	rt.pollInFlight = true;
	try {
		await _doPollOnce(rt);
	} finally {
		rt.pollInFlight = false;
	}
}

async function _doPollOnce(rt: Runtime): Promise<void> {
	const active = Object.values(rt.watches).filter((w) => !w.terminal);
	if (active.length === 0) {
		refreshStatus(rt);
		return;
	}

	const allEvents: FsEvent[] = [];
	let anyObservedChange = false;
	const nowTs = rt.now();

	for (const watch of active) {
		// Timeout check first — short-circuits the stat() call.
		if (watch.timeoutAt !== undefined && nowTs >= watch.timeoutAt) {
			allEvents.push(buildTimeoutEvent(watch));
			watch.terminal = true;
			teardownWatchFs(rt, watch.watchId);
			anyObservedChange = true;
			continue;
		}

		try {
			// Pass rt.snapshot so tests can stub stat() without touching real FS.
			const result = await detectChanges(watch, rt.snapshot);

			noteWatchSuccess(watch, {
				onRecover: (prevErrors) => {
					rt.pi.sendMessage(
						{
							customType: CUSTOM_MESSAGE_TYPE,
							content: `✓ ${watch.path} (${watch.watchId}) recovered after ${prevErrors} consecutive error(s).`,
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
				watch.terminal = true;
				teardownWatchFs(rt, watch.watchId);
			}
		} catch (err) {
			noteWatchFailure(watch, {
				err,
				classifyOpts: {
					genericMessage: "stat() failed — check the path is accessible",
				},
				scheduler: rt.scheduler,
				onAppendError: (_classified, raw) => {
					rt.pi.appendEntry("file-system-watcher:poll-error", {
						path: watch.path,
						message: (raw as Error)?.message ?? String(raw),
					});
				},
				onThresholdMessage: (classified) => {
					rt.pi.sendMessage(
						{
							customType: CUSTOM_MESSAGE_TYPE,
							content:
								`⚠ ${watch.path} (${watch.watchId}) has failed ` +
								`${POLL_ERROR_THRESHOLD} consecutive polls. ` +
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
			  '\nRun manage_tools({action:"activate", tools:["file_system_watcher"]}) to manage this watcher.';
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

	rt.pi.events.emit("fs:change", {});
	refreshStatus(rt);
}
