/**
 * fs.watch wrapper with debounce for pi-file-system-watcher.
 *
 * Provides:
 *   - {@link createDebounced}    — trailing-edge debounce utility (exported for tests).
 *   - {@link tryCreateFsWatch}  — attempt to wrap `fs.watch` around a path;
 *                                 returns `null` on ENOSYS / EPERM or any
 *                                 synchronous throw so callers fall back to
 *                                 pure polling without crashing.
 *
 * Design notes
 * ─────────────
 * • `fs.watch` is used ONLY as a fast-notification layer that triggers an
 *   immediate `pollOnce` call. The authoritative change decision is always
 *   made by `detectChanges` (stat-based). This avoids the inherent
 *   unreliability of `fs.watch` event semantics across platforms.
 *
 * • A trailing-edge debounce (default 500 ms) collapses rapid successive
 *   fs.watch events (e.g. an editor saving a file with multiple writes) into
 *   a single poll trigger.
 *
 * • If the path does not exist at watch-creation time (target='exists') or
 *   `fs.watch` cannot be set up for any reason, the function returns `null`
 *   and the PollScheduler polling loop continues as the sole detection path.
 *
 * • Each `FsWatchHandle` owns one `fs.FSWatcher` instance. The runtime disposes
 *   handles when a watch is removed or the session shuts down.
 */

import { watch, type FSWatcher } from "node:fs";

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

export interface DebouncedHandle {
	/** Schedule the callback after `delayMs` of quiet time. */
	trigger(): void;
	/** Cancel any pending invocation. */
	cancel(): void;
}

/**
 * Create a trailing-edge debounce wrapper around `fn`.
 *
 * Each call to `trigger()` resets the delay. `fn` is called once after
 * `delayMs` of silence. `cancel()` discards any pending invocation.
 */
export function createDebounced(fn: () => void, delayMs: number): DebouncedHandle {
	let timer: ReturnType<typeof setTimeout> | null = null;

	function trigger(): void {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			fn();
		}, delayMs);
	}

	function cancel(): void {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	}

	return { trigger, cancel };
}

// ---------------------------------------------------------------------------
// fs.watch wrapper
// ---------------------------------------------------------------------------

export interface FsWatchHandle {
	/** Release resources: cancel any pending debounce timer and close the watcher. */
	dispose(): void;
}

/**
 * Attempt to create an `fs.watch` listener for `watchPath`.
 *
 * When a filesystem event fires, the `onEvent` callback is invoked after
 * a debounce period of `debounceMs` milliseconds. The callback is intended
 * to trigger an immediate `pollOnce` in the runtime.
 *
 * Returns `null` (caller falls back to polling) when:
 *   - `fs.watch` throws synchronously (ENOSYS, EPERM, ENOENT, etc.).
 *   - The watcher emits an `'error'` event after creation.
 *
 * The watcher is created with `{ persistent: false }` so it does not prevent
 * the process from exiting if it is inadvertently not disposed.
 */
export function tryCreateFsWatch(
	watchPath: string,
	onEvent: () => void,
	debounceMs: number,
): FsWatchHandle | null {
	const debounced = createDebounced(onEvent, debounceMs);
	let watcher: FSWatcher | null = null;

	try {
		watcher = watch(watchPath, { persistent: false }, () => {
			debounced.trigger();
		});

		watcher.on("error", () => {
			// An error after the watcher was created (e.g. file deleted on some
			// platforms) is not actionable — the polling loop handles it.
			debounced.cancel();
			try {
				watcher?.close();
			} catch {
				/* ignore */
			}
			watcher = null;
		});
	} catch {
		// fs.watch unavailable (ENOSYS on some Linux mounts, EPERM, ENOENT, …)
		debounced.cancel();
		return null;
	}

	return {
		dispose(): void {
			debounced.cancel();
			try {
				watcher?.close();
			} catch {
				/* ignore */
			}
			watcher = null;
		},
	};
}
