/**
 * Per-watch poll-error bookkeeping shared across pi watcher extensions.
 *
 * Centralises the consecutive-error counter management, recovery
 * notification, back-off routing, and threshold alerting that every
 * watcher implements in its `pollOnce` loop.
 *
 * Design:
 *   - `noteWatchSuccess` — resets the counter; fires `onRecover` exactly
 *     once when `prevErrors` was >= threshold.
 *   - `noteWatchFailure` — increments the counter; classifies the error;
 *     conditionally calls `scheduler.noteBackoff()`; always calls
 *     `onAppendError`; fires `onThresholdMessage` exactly when the count
 *     hits the threshold (strict ===, never re-fires).
 *
 * Callers supply label-specific callbacks so the module stays domain-agnostic.
 */

import {
	classifyWatcherError,
	type ClassifyErrorOptions,
	type ClassifiedWatcherError,
} from "./classify-error.js";
import type { PollScheduler } from "./poll-scheduler.js";

export const DEFAULT_POLL_ERROR_THRESHOLD = 5;

/** Minimum watch shape required by both helpers. */
export interface WatchLike {
	consecutiveErrors: number;
}

// ---------------------------------------------------------------------------
// noteWatchSuccess
// ---------------------------------------------------------------------------

export interface NoteWatchSuccessOpts {
	/** Threshold that was used when incrementing (must match noteWatchFailure). */
	threshold?: number;
	/** Called when the watch just recovered (prevErrors was >= threshold). */
	onRecover: (prevErrors: number) => void;
}

/**
 * Call after a successful poll for one watch.
 *
 * Resets `watch.consecutiveErrors` to 0 and calls `onRecover` when the
 * previous count was >= threshold — i.e. the watch crossed back from
 * degraded to healthy.
 */
export function noteWatchSuccess(watch: WatchLike, opts: NoteWatchSuccessOpts): void {
	const threshold = opts.threshold ?? DEFAULT_POLL_ERROR_THRESHOLD;
	const prevErrors = watch.consecutiveErrors;
	watch.consecutiveErrors = 0;
	if (prevErrors >= threshold) {
		opts.onRecover(prevErrors);
	}
}

// ---------------------------------------------------------------------------
// noteWatchFailure
// ---------------------------------------------------------------------------

export interface NoteWatchFailureOpts {
	/** Raw caught error. */
	err: unknown;
	/** Options forwarded to `classifyWatcherError`. */
	classifyOpts: ClassifyErrorOptions;
	/** Scheduler — `noteBackoff()` is called when `classified.shouldBackoff`. */
	scheduler: PollScheduler;
	/**
	 * Called unconditionally with the classified error and the original raw
	 * error. Intended for `pi.appendEntry` calls; should never throw.
	 */
	onAppendError: (classified: ClassifiedWatcherError, raw: unknown) => void;
	/**
	 * Called exactly once when `watch.consecutiveErrors === threshold` (after
	 * incrementing). Intended for injecting the warning chat message.
	 * Never called again until the counter resets.
	 */
	onThresholdMessage: (classified: ClassifiedWatcherError) => void;
	threshold?: number;
}

/**
 * Call inside a poll-loop catch block for one watch.
 *
 * Increments `watch.consecutiveErrors`, classifies the error, routes
 * back-off, appends an error log entry, and fires the threshold message
 * when the counter hits the threshold.
 */
export function noteWatchFailure(watch: WatchLike, opts: NoteWatchFailureOpts): void {
	const threshold = opts.threshold ?? DEFAULT_POLL_ERROR_THRESHOLD;
	watch.consecutiveErrors += 1;
	const classified = classifyWatcherError(opts.err, opts.classifyOpts);
	if (classified.shouldBackoff) {
		opts.scheduler.noteBackoff();
	}
	opts.onAppendError(classified, opts.err);
	if (watch.consecutiveErrors === threshold) {
		opts.onThresholdMessage(classified);
	}
}
