/**
 * Baseline-seeding helper for pi watcher extensions.
 *
 * On `session_start`, watchers must re-seed any watches that survived the
 * session log without a baseline (add-time seeding failed, or the field was
 * dropped during serialisation). This helper centralises that loop with a
 * consistent contract:
 *   - Terminal watches are skipped.
 *   - Watches with an existing baseline are skipped.
 *   - Errors are routed to `onError` and never re-thrown.
 *   - `watch.baseline` is mutated in-place on success.
 */

/** Minimum watch shape required by the seeder. */
export interface SeedableWatch {
	terminal: boolean;
	baseline: unknown;
}

export interface SeedBaselinesOpts<W extends SeedableWatch> {
	/** Fetch a fresh baseline for one watch. May throw — errors are caught. */
	snapshot: (watch: W) => Promise<unknown>;
	/** Called for each watch whose `snapshot()` threw. Never re-throws. */
	onError: (watch: W, err: unknown) => void;
}

/**
 * Iterate `watches`, skipping terminal and already-seeded entries, and
 * attempt to populate `watch.baseline` via `opts.snapshot`.
 *
 * Errors from `snapshot` are caught and forwarded to `opts.onError` so a
 * single failing watch never blocks the rest.
 */
export async function seedMissingBaselines<W extends SeedableWatch>(
	watches: W[],
	opts: SeedBaselinesOpts<W>,
): Promise<void> {
	const pending = watches.filter((w) => !w.terminal && w.baseline === undefined);
	await Promise.all(
		pending.map(async (watch) => {
			try {
				watch.baseline = await opts.snapshot(watch);
			} catch (err) {
				opts.onError(watch, err);
			}
		}),
	);
}
