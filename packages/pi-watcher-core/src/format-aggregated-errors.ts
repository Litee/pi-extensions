/**
 * Shared helper for user-facing aggregated error notifications produced by
 * watcher extensions (code-review, pipelines, ticket, ...).
 *
 * Each watcher aggregates per-item poll / seed failures into a short list and
 * emits at most one `ui.notify(...)` toast with:
 *
 *   "${extension}: ${phase} failed for ${label}: ${firstErrorMessage}"
 *
 * where `label` is either `"${singular} ${id}"` (single error) or
 * `"${N} ${plural}"` (multiple errors).
 *
 * Before this helper existed, the logic was inlined at 6 near-identical call
 * sites (3 watchers × {poll, seed}), each of which tripped
 * `noUncheckedIndexedAccess` on the `errors[0]` accesses. Centralising the
 * formatter:
 *   - eliminates ~60 lines of duplicated code,
 *   - gives TypeScript a narrow-able `errors.length > 0` branch where
 *     `errors[0]` is provably defined,
 *   - locks the exact user-visible phrasing in one place so all three
 *     watchers stay byte-compatible.
 *
 * SECURITY: callers MUST pass already-sanitised error strings (from
 * `classifyWatcherError(...).userMessage`). This helper does not sanitise
 * and does not re-format the error — it assumes the security invariant
 * established at each call site (see the `SECURITY:` comment next to the
 * `classifyWatcherError` call).
 */

export interface AggregatedWatcherError {
	readonly id: string;
	readonly error: string;
}

export interface FormatAggregatedErrorsOpts {
	/** Extension name prefix, e.g. `"code-review-watcher"`. */
	readonly extension: string;
	/** Verb phase, e.g. `"poll"` or `"seed"`. */
	readonly phase: string;
	/** Singular noun for the watched item, e.g. `"CR"`, `"pipeline"`, `"ticket"`. */
	readonly singular: string;
	/**
	 * Plural noun. Defaults to `${singular}s`. Override for irregular
	 * plurals (none of the current watchers need this, but it keeps the
	 * helper future-proof for e.g. `"sev"` → `"sevs"` vs. `"query"` →
	 * `"queries"`).
	 */
	readonly plural?: string;
	readonly errors: readonly AggregatedWatcherError[];
}

/**
 * Format the user-facing aggregated-error notification string.
 *
 * Returns `undefined` when `errors` is empty so callers can use a single
 * `if (msg) ui?.notify?.(msg, "warning")` guard. Returning `undefined`
 * (rather than throwing) keeps the helper safe to call unconditionally and
 * lets TS infer `errors[0]` as defined inside the body without a
 * non-null assertion.
 */
export function formatAggregatedErrorsMessage(
	opts: FormatAggregatedErrorsOpts,
): string | undefined {
	const { extension, phase, singular, errors } = opts;
	const first = errors[0];
	if (!first) return undefined;
	const plural = opts.plural ?? `${singular}s`;
	const label =
		errors.length === 1 ? `${singular} ${first.id}` : `${errors.length} ${plural}`;
	return `${extension}: ${phase} failed for ${label}: ${first.error}`;
}
