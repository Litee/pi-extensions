/**
 * Pure helpers extracted from index.ts so they can be unit-tested without
 * spinning up a live `pi-tui` theme / `registerTool` runtime.
 */

/**
 * Sentinel strings emitted by the built-in grep / find / ls tools when they
 * have nothing to report. `countLines` treats these as "0 results" rather
 * than "1 line of output".
 */
export const EMPTY_SENTINELS: ReadonlySet<string> = new Set([
	"No matches found",
	"No files found matching pattern",
	"(empty directory)",
]);

/**
 * Format a wall-clock duration in milliseconds as `N.Ns`. Mirrors the
 * formatter used by the built-in `bash` renderer
 * (`dist/core/tools/bash.js#formatDuration`).
 *
 * Negative inputs are clamped to 0 so that a clock-skew blip (startedAt in
 * the future) never renders as "-0.3s".
 */
export function formatDuration(ms: number): string {
	const clamped = ms < 0 ? 0 : ms;
	return `${(clamped / 1000).toFixed(1)}s`;
}

/**
 * Count non-empty result lines from grep / ls / find output.
 *
 * - Returns 0 for empty input or for any of the `EMPTY_SENTINELS` strings.
 * - Treats both `\n` and `\r\n` line terminators as line breaks.
 * - Ignores blank lines (whitespace-only).
 */
export function countLines(text: string): number {
	const trimmed = text.trim();
	if (!trimmed || EMPTY_SENTINELS.has(trimmed)) return 0;
	return trimmed.split(/\r?\n/).filter((l) => l.trim() !== "").length;
}

/**
 * Pull a human-readable failure reason out of the bash tool's error text.
 * The built-in `bash.js` appends one of these sentinels on non-zero /
 * aborted / timed-out runs (see `dist/core/tools/bash.js` — `appendStatus`
 * call sites).
 */
export function describeBashFailure(output: string): string {
	const exitMatch = output.match(/Command exited with code (-?\d+)/);
	if (exitMatch) return `exit ${exitMatch[1]}`;
	const timeoutMatch = output.match(/Command timed out after (\d+) seconds/);
	if (timeoutMatch) return `timeout ${timeoutMatch[1]}s`;
	if (/Command aborted/.test(output)) return "aborted";
	return "failed";
}
