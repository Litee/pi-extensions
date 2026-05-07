/**
 * Chat-message and status-line formatters.
 *
 * Pure functions — no I/O, no timers, no runtime state. All inputs
 * come from the caller so every function is straightforward to unit-test.
 */

import type { GlueEvent, WatchMap } from "./types.js";

// ---------------------------------------------------------------------------
// Status-line
// ---------------------------------------------------------------------------

export interface StatusLineInput {
	watches: WatchMap;
	paused: boolean;
	pollIntervalMs: number;
	/** When `true` at least one active watch has hit the consecutive-error threshold. */
	hasErrors?: boolean;
}

/**
 * Build the text shown in the pi status-line row.
 *
 * - Idle (no active watches): `☁ Glue: idle`
 * - Active:                   `☁ Glue: N job(s) | M workflow(s) | ⟳ 120s`
 * - Paused:                   `☁ Glue: N job(s) | M workflow(s) ⏸`
 *
 * Terminal watches are excluded from the counts; they no longer generate
 * events but remain in the list for reference until explicitly removed.
 */
export function buildStatusLine(input: StatusLineInput): string {
	const { watches, paused, pollIntervalMs, hasErrors } = input;

	const active = Object.values(watches).filter((w) => !w.terminal);
	if (active.length === 0) return "☁ Glue: idle";

	const jobs = active.filter((w) => w.type === "job").length;
	const workflows = active.filter((w) => w.type === "workflow").length;

	const parts: string[] = [];
	if (jobs > 0) parts.push(`${jobs} job${jobs === 1 ? "" : "s"}`);
	if (workflows > 0) parts.push(`${workflows} workflow${workflows === 1 ? "" : "s"}`);
	if (hasErrors) parts.push("⚠ errors");

	const suffix = paused
		? " ⏸"
		: ` | ⟳ ${Math.round(pollIntervalMs / 1000)}s`;

	return `☁ Glue: ${parts.join(" | ")}${suffix}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a Date as a compact local `[HH:mm]` stamp. */
function formatHm(date: Date): string {
	const pad = (n: number): string => n.toString().padStart(2, "0");
	return `[${pad(date.getHours())}:${pad(date.getMinutes())}]`;
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
 *
 * • my-etl-job (jr_abc123): STARTING → RUNNING
 * • my-workflow (wr_def456): RUNNING → COMPLETED ✓
 * ```
 */
export function buildChangeChatMessage(events: GlueEvent[], date: Date): string {
	const noun = events.length === 1 ? "change" : "changes";
	const header = `${formatHm(date)} ${events.length} ${noun} detected`;
	const bullets = events.map((e) => e.formatted).join("\n");
	return `${header}\n\n${bullets}`;
}

/**
 * Build the content for the startup chat message emitted when the watcher
 * resumes with an existing watch list (session restart or `/glue-watcher enable`).
 *
 * Format when watches are present:
 * ```
 * [10:30] active — watching 2 runs:
 *
 * • job  my-etl-job (jr_abc123): state=RUNNING
 * • workflow  my-workflow (wr_def456): state=RUNNING [terminal]
 * ```
 */
export function buildStartupChatMessage(watches: WatchMap, date: Date): string {
	const all = Object.values(watches);
	if (all.length === 0) {
		return "active — no watches configured. Use the glue_watcher tool to add a job or workflow.";
	}
	const noun = all.length === 1 ? "run" : "runs";
	const lines = all.map((w) => {
		const state = w.baseline ? w.baseline.state || "?" : "?";
		const tag = w.terminal ? " [terminal]" : "";
		return `• ${w.type}  ${w.name} (${w.runId}): state=${state}${tag}`;
	});
	return `${formatHm(date)} active — watching ${all.length} ${noun}:\n\n${lines.join("\n")}`;
}
