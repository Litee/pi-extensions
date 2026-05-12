/**
 * S3 change detection.
 *
 * Pure module: no environment access, no persistence, no setInterval.
 * All I/O goes through the injected {@link S3Client} so tests can drop in
 * a stub implementation with canned responses.
 *
 * Public surface:
 *   - {@link snapshotObject}    — fetch current baseline, no diff.
 *   - {@link detectChanges}     — fetch + diff against a watch's baseline,
 *                                 emit at most one event.
 */

import type { S3Client } from "./s3-client.js";
import type { S3Baseline, S3Event, S3Watch } from "./types.js";

/** Fetch the current state of an S3 object with no diffing. */
export async function snapshotObject(
	client: S3Client,
	watch: S3Watch,
): Promise<S3Baseline> {
	const r = await client.headObject(watch.bucket, watch.key, watch.profile, watch.region);
	if (!r.exists) return { exists: false };
	const out: S3Baseline = { exists: true };
	if (r.etag !== undefined) out.etag = r.etag;
	if (r.contentLength !== undefined) out.contentLength = r.contentLength;
	return out;
}

export interface DetectChangesResult {
	/** At most one event per call. */
	events: S3Event[];
	/** Updated baseline to persist back into the watch record. */
	newBaseline: S3Baseline;
	/**
	 * `true` iff any observable change was detected relative to the prior
	 * baseline (existence flip OR ETag change OR size change). The scheduler
	 * uses this as its "had events" signal so back-off resets to the base
	 * interval on real S3 activity, independent of whether the watch's
	 * target condition actually fired.
	 */
	observedChange: boolean;
}

/**
 * Compare `now` against `prev` and return whether the observation matches
 * `target`. Semantics:
 *   - `exists`:  fires the first time `exists` flips false → true.
 *   - `removed`: fires the first time `exists` flips true → false.
 *   - `updated`: fires when both snapshots exist AND (etag or contentLength)
 *                differs. A missing ETag on either side is treated as
 *                "unknown, no change" — updated will not fire. If the object
 *                disappears, `updated` does NOT fire (that's a `removed`
 *                condition, not an update).
 *
 * `prev === undefined` means we never had a baseline (seed failed), so no
 * target can fire yet — the caller will install `now` as the baseline and
 * re-check on the next poll.
 */
function targetFired(
	target: S3Watch["target"],
	prev: S3Baseline | undefined,
	now: S3Baseline,
): boolean {
	if (prev === undefined) return false;
	switch (target) {
		case "exists":
			return !prev.exists && now.exists;
		case "removed":
			return prev.exists && !now.exists;
		case "updated": {
			if (!prev.exists || !now.exists) return false;
			if (prev.etag !== undefined && now.etag !== undefined && prev.etag !== now.etag) {
				return true;
			}
			if (
				prev.contentLength !== undefined &&
				now.contentLength !== undefined &&
				prev.contentLength !== now.contentLength
			) {
				return true;
			}
			return false;
		}
	}
}

/** `true` iff any observable field differs between `prev` and `now`. */
function anyChange(prev: S3Baseline | undefined, now: S3Baseline): boolean {
	if (prev === undefined) return false;
	if (prev.exists !== now.exists) return true;
	if (prev.etag !== now.etag) return true;
	if (prev.contentLength !== now.contentLength) return true;
	return false;
}

function uri(watch: S3Watch): string {
	return `s3://${watch.bucket}/${watch.key}`;
}

function buildTargetEvent(
	watch: S3Watch,
	prev: S3Baseline | undefined,
	now: S3Baseline,
): S3Event {
	const loc = uri(watch);
	switch (watch.target) {
		case "exists": {
			const size = now.contentLength !== undefined ? ` (${now.contentLength} bytes)` : "";
			const summary = `${loc} now exists${size}`;
			return {
				watchId: watch.watchId,
				bucket: watch.bucket,
				key: watch.key,
				eventType: "exists",
				summary,
				formatted: `• ${summary} ✓`,
			};
		}
		case "removed": {
			const summary = `${loc} was removed`;
			return {
				watchId: watch.watchId,
				bucket: watch.bucket,
				key: watch.key,
				eventType: "removed",
				summary,
				formatted: `• ${summary} ✓`,
			};
		}
		case "updated": {
			const prevEtag = prev?.etag ?? "?";
			const nextEtag = now.etag ?? "?";
			const summary = `${loc} updated (etag ${prevEtag} → ${nextEtag})`;
			return {
				watchId: watch.watchId,
				bucket: watch.bucket,
				key: watch.key,
				eventType: "updated",
				summary,
				formatted: `• ${summary} ✓`,
			};
		}
	}
}

/**
 * Poll an S3 object, diff against the watch's current baseline, and return
 * any target-hit event plus the refreshed baseline.
 *
 * Emits AT MOST one event per call — the first (and only) time the target
 * condition fires. Once the caller observes a returned event, it marks the
 * watch terminal and stops polling it.
 *
 * The `observedChange` flag reports any observable change in the object
 * (existence flip or ETag/size change), independent of whether the target
 * condition actually fired. The poll-scheduler uses this as its "had
 * events" signal so the back-off interval snaps back to base whenever S3
 * actually changes.
 */
export async function detectChanges(
	client: S3Client,
	watch: S3Watch,
): Promise<DetectChangesResult> {
	const now = await snapshotObject(client, watch);
	const prev = watch.baseline;
	const events: S3Event[] = [];
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
export function buildTimeoutEvent(watch: S3Watch): S3Event {
	const loc = uri(watch);
	const summary = `${loc} timed out waiting for '${watch.target}'`;
	return {
		watchId: watch.watchId,
		bucket: watch.bucket,
		key: watch.key,
		eventType: "timeout",
		summary,
		formatted: `• ${summary} ✗`,
	};
}
