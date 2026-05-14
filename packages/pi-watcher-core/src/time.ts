/**
 * Shared time-formatting helpers for pi watcher extensions.
 */

/**
 * Format a Date as a zero-padded local `HH:MM` string.
 * Used by watcher change messages and startup headers.
 */
export function formatShortTime(d: Date): string {
	const pad = (n: number): string => n.toString().padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
