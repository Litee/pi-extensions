/**
 * Generic status-line rendering primitives for pi watcher extensions.
 *
 * The format is harmonized across all watcher packages on the ticket-watcher
 * style: `<label>: <mode> [(<modifier>)] (<count>)`.
 *
 * Examples:
 *   "ticket-watcher: active (3)"
 *   "ticket-watcher: paused (3)"
 *   "ticket-watcher: active (throttled) (3)"
 *   "ticket-watcher: active (auth error) (3)"
 */

export type StatusLineMode = "active" | "paused";
export type StatusLineModifier = "throttled" | "auth-error" | "none";
export type StatusLineColorAlias = "accent" | "muted" | "warning";

export interface StatusLineOptions {
	/** Extension label shown at the start of the status row, e.g. `"ticket-watcher"`. */
	label: string;
	mode: StatusLineMode;
	/** Number of watched items. Returns `""` (clear the pin) when 0. */
	count: number;
	/** Defaults to `"none"` when absent. */
	modifier?: StatusLineModifier;
}

/**
 * Returns the theme colour alias to use for a given mode + modifier.
 *
 * - `accent`  — active, no error
 * - `muted`   — paused (modifier is ignored; paused takes precedence)
 * - `warning` — throttled or auth-error
 */
export function statusLineColorAlias(
	mode: StatusLineMode,
	modifier: StatusLineModifier = "none",
): StatusLineColorAlias {
	if (mode === "paused") return "muted";
	if (modifier === "throttled" || modifier === "auth-error") return "warning";
	return "accent";
}

/**
 * Build the pinned status-row text.
 *
 * Returns `""` when `count === 0` — callers MUST treat that as "clear the
 * pinned row" (`setStatus(key, undefined)`) since no polling is happening and
 * any rendered text would misrepresent runtime state.
 */
export function buildStatusLine(opts: StatusLineOptions): string {
	if (opts.count === 0) return "";
	const modifier = opts.modifier ?? "none";
	if (opts.mode === "paused") return `${opts.label}: paused (${opts.count})`;
	if (modifier === "throttled") return `${opts.label}: active (throttled) (${opts.count})`;
	if (modifier === "auth-error") return `${opts.label}: active (auth error) (${opts.count})`;
	return `${opts.label}: active (${opts.count})`;
}

/**
 * Compact watch-list renderer: shows up to `maxShow` IDs, then a
 * `(+N more)` overflow suffix.
 *
 * @example
 * formatWatchList(["A", "B", "C"], 2) // "A, B (+1 more)"
 * formatWatchList(["A", "B"], 2)       // "A, B"
 * formatWatchList([], 2)               // ""
 */
export function formatWatchList(items: readonly string[], maxShow = 2): string {
	if (items.length === 0) return "";
	const shown = items.slice(0, maxShow).join(", ");
	if (items.length <= maxShow) return shown;
	return `${shown} (+${items.length - maxShow} more)`;
}
