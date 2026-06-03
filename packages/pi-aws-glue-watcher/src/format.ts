/**
 * Chat-message and status-line formatters.
 *
 * Pure functions — no I/O, no timers, no runtime state. All inputs
 * come from the caller so every function is straightforward to unit-test.
 */

import type { GlueEvent, WatchMap } from "./types.js";
import { formatShortTime } from "pi-watcher-core/time";
import { statusLineColorAlias, type StatusLineColorAlias } from "pi-watcher-core/status-line";
export type { StatusLineColorAlias } from "pi-watcher-core/status-line";

// ---------------------------------------------------------------------------
// Status-line
// ---------------------------------------------------------------------------

export interface StatusLineResult {
	text: string;
	colorAlias: StatusLineColorAlias;
}

export interface StatusLineInput {
	watches: WatchMap;
	pollIntervalMs: number;
	/** When `true` at least one active watch has hit the consecutive-error threshold. */
	hasErrors?: boolean;
}

/** Returns true when the given Glue state string maps to an error outcome. */
function isGlueErrorState(state: string | undefined): boolean {
	return (
		state === "FAILED" ||
		state === "ERROR" ||
		state === "TIMEOUT" ||
		state === "STOPPED"
	);
}

/** Returns true when the given Glue state string maps to a successful outcome. */
function isGlueSuccessState(state: string | undefined): boolean {
	return state === "SUCCEEDED" || state === "COMPLETED";
}

/**
 * Build the row shown in the pi status-line row.
 *
 * | State              | Row                       | Alias   |
 * |--------------------|---------------------------|----------|
 * | Idle               | `☁ Glue: idle`            | muted   |
 * | Active             | `☁ Glue: M/N`             | accent  |
 * | Active + errors    | `☁ Glue: ⚠ M/N`           | warning |
 * | Paused             | `☁ Glue: M/N (paused)`    | muted   |
 * | Paused + errors    | `☁ Glue: ⚠ M/N (paused)`  | warning |
 *
 * M = watches whose baseline.state is SUCCEEDED or COMPLETED.
 * N = total watch count.
 * Errors (hasErrors flag or any error-state watch) take priority over paused.
 * `pollIntervalMs` is accepted for back-compat but no longer rendered.
 */
export function buildStatusLine(input: StatusLineInput): StatusLineResult {
	const { watches, hasErrors } = input;

	const allWatches = Object.values(watches);

	if (allWatches.length === 0) {
		return { text: "☁ Glue: idle", colorAlias: "muted" };
	}

	const N = allWatches.length;
	const M = allWatches.filter((w) => w.baseline && isGlueSuccessState(w.baseline.state)).length;

	// Errors win if the caller flagged them OR if any watch is in a terminal-error state.
	const errorInStates = allWatches.some((w) => isGlueErrorState(w.baseline?.state));
	const effectiveHasErrors = (hasErrors ?? false) || errorInStates;

	const body = effectiveHasErrors ? `⚠ ${M}/${N}` : `${M}/${N}`;
	const text = `☁ Glue: ${body}`;

	const colorAlias: StatusLineColorAlias =
		effectiveHasErrors ? "warning" : statusLineColorAlias();
	return { text, colorAlias };
}

// ---------------------------------------------------------------------------
// Chat messages
// ---------------------------------------------------------------------------

/**
 * Build the content for a change-notification chat message.
 *
 * Format:
 * ```
 * [10:30] 2 changes detected
 * 1. my-etl-job — STARTING → RUNNING
 *    · run: jr_abc123
 *    · type: job
 * 2. my-workflow — RUNNING → COMPLETED ✓
 *    · run: wr_def456
 *    · type: workflow
 * ```
 */
export function buildChangeChatMessage(events: GlueEvent[], date: Date): string {
	const noun = events.length === 1 ? "change" : "changes";
	const header = `[${formatShortTime(date)}] ${events.length} ${noun} detected`;
	const lines = events.map((e, i) => {
		const primary = `${i + 1}. ${e.formatted}`;
		// e.formatted already contains the name + transition; sub-fields live on the watch
		// but events don't carry them — keep sub-field block empty for change messages
		// so the numbered-list header alone is sufficient.
		return primary;
	});
	return `${header}\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Startup-message helpers
// ---------------------------------------------------------------------------

/**
 * Render the detail sub-lines for one watch entry.
 * ```
 *    · run: jr_abc123
 *    · type: job
 *    · terminal
 * ```
 */
function buildWatchSubLines(w: import("./types.js").GlueWatch, { terminal }: { terminal?: boolean } = {}): string[] {
	const lines: string[] = [];
	lines.push(`   \u00b7 run: ${w.runId}`);
	lines.push(`   \u00b7 type: ${w.type}`);
	if (terminal ?? w.terminal) lines.push(`   \u00b7 terminal`);
	return lines;
}

/**
 * Build summary and detail bodies for one watch entry.
 *
 * Returns `{ summary, detail }` where:
 * - `summary` is the primary numbered line  (e.g. `1. etl-job \u2014 state=RUNNING`)
 * - `detail` is the indented sub-field block (one string per line)
 */
export function buildWatchEntry(
	watch: import("./types.js").GlueWatch,
	index: number,
): { summary: string; detail: string[] } {
	const state = watch.baseline ? watch.baseline.state || "?" : "?";
	const summary = `${index + 1}. ${watch.name} \u2014 state=${state}`;
	const detail = buildWatchSubLines(watch);
	return { summary, detail };
}

/**
 * Build the content for the startup chat message.
 *
 * Full (expanded) format:
 * ```
 * [10:30] active \u2014 watching 2 runs:
 * 1. etl-job \u2014 state=RUNNING
 *    \u00b7 run: jr_abc123
 *    \u00b7 type: job
 * 2. my-workflow \u2014 state=SUCCEEDED
 *    \u00b7 run: wr_def456
 *    \u00b7 type: workflow
 * ```
 *
 * Collapsed format (used when `expanded=false`, shown as the stored
 * `content.text`):
 * ```
 * [10:30] active \u2014 watching 2 runs:
 * 1. etl-job \u2014 state=RUNNING
 * 2. my-workflow \u2014 state=SUCCEEDED
 *   … ctrl+o to expand
 * ```
 */
export function buildStartupChatMessage(
	watches: WatchMap,
	date: Date,
	{ expanded = false, pollMs }: { expanded?: boolean; pollMs?: number } = {},
): string {
	const all = Object.values(watches);
	if (all.length === 0) {
		return "active \u2014 no watches configured. Use the glue_watcher tool to add a job or workflow.";
	}
	const noun = all.length === 1 ? "run" : "runs";
	const pollSuffix =
		typeof pollMs === "number" && pollMs > 0
			? ` \u2014 poll: ${Math.round(pollMs / 1000)}s`
			: "";
	const header = `[${formatShortTime(date)}] active \u2014 watching ${all.length} ${noun}${pollSuffix}:`;

	const entries = all.map((w, i) => buildWatchEntry(w, i));

	if (expanded) {
		const lines: string[] = [header];
		for (const { summary, detail } of entries) {
			lines.push(summary);
			lines.push(...detail);
		}
		return lines.join("\n");
	}

	// Collapsed: primary lines only + expand hint.
	const lines: string[] = [header];
	for (const { summary } of entries) lines.push(summary);
	lines.push("… ctrl+o to expand");
	return lines.join("\n");
}
