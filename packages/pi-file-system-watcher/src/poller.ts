/**
 * Filesystem change detection for pi-file-system-watcher.
 *
 * Pure module: no environment access beyond `fs.promises.stat`, no
 * persistence, no setInterval. All I/O goes through `snapshotPath` so
 * tests can exercise change-detection logic with real filesystem using
 * tmp directories.
 *
 * Public surface:
 *   - {@link snapshotPath}    — fetch current baseline, no diff.
 *   - {@link detectChanges}   — fetch + diff against a watch's baseline,
 *                               emit at most one event.
 *   - {@link buildTimeoutEvent} — synthesise a timeout event.
 */

import { stat } from "node:fs/promises";

import type { FsBaseline, FsEvent, FsWatch } from "./types.js";

/** Fetch the current stat of a path with no diffing. */
export async function snapshotPath(filePath: string): Promise<FsBaseline> {
	try {
		const st = await stat(filePath, { bigint: true });
		return {
			exists: true,
			mtimeNs: st.mtimeNs,
			size: Number(st.size),
		};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { exists: false };
		}
		throw err;
	}
}

export interface DetectChangesResult {
	/** At most one event per call. */
	events: FsEvent[];
	/** Updated baseline to persist back into the watch record. */
	newBaseline: FsBaseline;
	/**
	 * `true` iff any observable change was detected relative to the prior
	 * baseline (existence flip OR mtime/size change). The scheduler uses this
	 * as its "had events" signal to reset back-off on real FS activity,
	 * independent of whether the watch's target condition actually fired.
	 */
	observedChange: boolean;
}

/**
 * Check whether `target` condition fired by comparing `prev` to `now`.
 *
 * - `exists`:  fires the first time `exists` flips false → true.
 * - `removed`: fires the first time `exists` flips true → false.
 * - `changed`: fires when both snapshots exist AND mtimeNs or size differs.
 *              When the file disappears `changed` does NOT fire (that's
 *              `removed`, not a change).
 *
 * `prev === undefined` means no baseline yet (seed failed); no target can
 * fire until the baseline is installed on the next poll.
 */
function targetFired(
	target: FsWatch["target"],
	prev: FsBaseline | undefined,
	now: FsBaseline,
): boolean {
	if (prev === undefined) return false;
	switch (target) {
		case "exists":
			return !prev.exists && now.exists;
		case "removed":
			return prev.exists && !now.exists;
		case "changed": {
			if (!prev.exists || !now.exists) return false;
			if (prev.mtimeNs !== undefined && now.mtimeNs !== undefined && prev.mtimeNs !== now.mtimeNs) {
				return true;
			}
			if (prev.size !== undefined && now.size !== undefined && prev.size !== now.size) {
				return true;
			}
			return false;
		}
	}
}

/** `true` iff any observable field differs between `prev` and `now`. */
function anyChange(prev: FsBaseline | undefined, now: FsBaseline): boolean {
	if (prev === undefined) return false;
	if (prev.exists !== now.exists) return true;
	if (prev.mtimeNs !== now.mtimeNs) return true;
	if (prev.size !== now.size) return true;
	return false;
}

function buildTargetEvent(watch: FsWatch, _prev: FsBaseline | undefined, _now: FsBaseline): FsEvent {
	const { path, watchId } = watch;
	switch (watch.target) {
		case "exists": {
			const summary = `${path} now exists`;
			return { watchId, path, eventType: "exists", summary, formatted: `• ${path}: absent → present` };
		}
		case "removed": {
			const summary = `${path} was removed`;
			return { watchId, path, eventType: "removed", summary, formatted: `• ${path}: present → absent` };
		}
		case "changed": {
			const summary = `${path} changed`;
			return { watchId, path, eventType: "changed", summary, formatted: `• ${path}: unchanged → changed` };
		}
	}
}

/**
 * Stat the path, diff against the watch's current baseline, and return any
 * target-hit event plus the refreshed baseline.
 *
 * Emits AT MOST one event per call — the first (and only) time the target
 * condition fires. Once the caller observes a returned event, it marks the
 * watch terminal and stops polling it.
 *
 * @param snapshot  Override the snapshot function. Defaults to {@link snapshotPath}
 *                  (real `fs.promises.stat`). Pass a stub in unit tests.
 */
export async function detectChanges(
	watch: FsWatch,
	snapshot: (path: string) => Promise<FsBaseline> = snapshotPath,
): Promise<DetectChangesResult> {
	const now = await snapshot(watch.path);
	const prev = watch.baseline;
	const events: FsEvent[] = [];
	if (targetFired(watch.target, prev, now)) {
		events.push(buildTargetEvent(watch, prev, now));
	}
	return {
		events,
		newBaseline: now,
		observedChange: anyChange(prev, now),
	};
}

/**
 * Build a `timeout` event for a watch whose `timeoutAt` has elapsed before
 * the target condition was met.
 */
export function buildTimeoutEvent(watch: FsWatch): FsEvent {
	const { path, watchId } = watch;
	const summary = `${path} timed out waiting for '${watch.target}'`;
	return { watchId, path, eventType: "timeout", summary, formatted: `• ${path}: timed out ✗` };
}
