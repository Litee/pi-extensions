/**
 * Pure viewport / scroll math for the skills browser list.
 *
 * Extracted from `index.ts` so the windowing logic and scroll-indicator
 * percentage can be unit-tested without a live pi-tui runtime.
 */

/**
 * Compute the visible window [start, end) into a list of length `len`,
 * keeping `selectedIndex` roughly centred within `maxVisible` rows.
 *
 * Guarantees:
 *   - 0 <= start <= end <= len
 *   - end - start <= maxVisible
 *   - When len <= maxVisible, returns the full range [0, len).
 */
export function computeWindow(
	selectedIndex: number,
	len: number,
	maxVisible: number,
): { start: number; end: number } {
	const start = Math.max(
		0,
		Math.min(
			selectedIndex - Math.floor(maxVisible / 2),
			Math.max(0, len - maxVisible),
		),
	);
	const end = Math.min(len, start + maxVisible);
	return { start, end };
}

/**
 * Compute the scroll-indicator percentage (0–100) for the given position.
 *
 * Returns `null` when the percentage is undefined:
 *   - `len === 0` — no items.
 *   - `len === 1` — single item; prior implementation divided by `len - 1`
 *     and produced `NaN`, then rendered as "NaN%". The caller should skip
 *     the indicator entirely in this case.
 */
export function computeScrollPercent(
	selectedIndex: number,
	len: number,
): number | null {
	if (len <= 1) return null;
	return Math.round((selectedIndex / (len - 1)) * 100);
}
