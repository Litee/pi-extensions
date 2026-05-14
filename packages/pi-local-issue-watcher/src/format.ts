import type { Change } from "./diff.js";
import { formatChange } from "./diff.js";
import { abbreviatePath } from "./path.js";
import type { Snapshot } from "./types.js";
import { formatShortTime } from "pi-watcher-core/time";

/** The set of states the watcher status line can be in. */
export type WatcherState = "active" | "paused";

/**
 * Well-known statuses emitted by `local-skill-issues-tracker`, in the order
 * `watch_issues.py` uses for its summary line. Anything not in this list is
 * appended alphabetically after.
 */
const WELL_KNOWN_STATUSES = ["open", "in_progress", "done", "wont_fix"] as const;

/**
 * Build the one-line session-start / resume announcement for the pinned
 * status row.
 *
 * Format:
 *   active  → `local-issue-watcher: active (N open)`
 *   paused  → `local-issue-watcher: paused`
 *
 * The count is embedded in parentheses after the state so it reads as an
 * annotation rather than a separate metric. Total issue count is omitted —
 * the open count is the only actionable signal at a glance. The per-status
 * breakdown lives on the chat surface ({@link buildStartupChatMessage}).
 *
 * The `dbRoot` and `pollIntervalMs` parameters are retained in the
 * signature because callers still thread them through to the chat-surface
 * {@link buildStartupChatMessage}; this function ignores them.
 *
 * The message is meant for `ctx.ui.setStatus` (pinned status-row text) and
 * must NOT trigger an agent turn — it is purely a user-visible status line.
 */
export function buildStartupAnnouncement(
	state: WatcherState,
	_dbRoot: string,
	_pollIntervalMs: number,
	snapshot: Snapshot,
): string {
	const prefix = `local-issue-watcher: ${state}`;
	if (state === "paused") return prefix;
	return `${prefix} (${formatCompactStatusSummary(snapshot)})`;
}

/**
 * Build the pinned status line shown when `dbRoot` does not exist on disk.
 *
 * Format: `local-issue-watcher: dbRoot missing | <abbreviated path>`
 *
 * Deliberately terse — remediation guidance goes to the chat surface
 * ({@link buildMissingDbRootChatMessage}) where there is room for it.
 * The abbreviated path is included so the user can identify which
 * directory needs to exist without leaving the status bar.
 */
export function buildMissingDbRootStatus(dbRoot: string): string {
	return `local-issue-watcher: dbRoot missing | ${abbreviatePath(dbRoot)}`;
}

/**
 * Build the chat-visible message posted when `dbRoot` does not exist on
 * disk. Unlike the terse pinned status row ({@link buildMissingDbRootStatus}),
 * this message provides actionable remediation steps so the LLM can surface
 * them to the user without requiring a separate `/status` invocation.
 *
 * Format (rendered inside the [pi-local-issue-watcher] box):
 *
 *     status: dbRoot missing
 *     db: <path>
 *     To start watching, either:
 *     - Create the directory: mkdir -p <path>
 *     - Or set LOCAL_ISSUE_TRACKER_DB_ROOT to an existing tracker path
 */
export function buildMissingDbRootChatMessage(dbRoot: string): string {
	return [
		`status: dbRoot missing`,
		`db: ${dbRoot}`,
		`To start watching, either:`,
		`- Create the directory: mkdir -p ${dbRoot}`,
		`- Or set LOCAL_ISSUE_TRACKER_DB_ROOT to an existing tracker path`,
	].join("\n");
}

/**
 * Build the compact, chat-visible startup announcement the watcher posts
 * on each `session_start`. #0031 collapsed the previous 4-line block
 * (status/poll/db/issues) down to a single line — the detailed breakdown
 * now lives in {@link buildStatusDetailMessage} and is only emitted on
 * explicit `status` invocations.
 *
 * Format: `active (N open)`
 *
 * The `dbRoot` and `pollIntervalMs` parameters are retained for signature
 * compatibility with existing callers; they are ignored.
 */
export function buildStartupChatMessage(
	_dbRoot: string,
	snapshot: Snapshot,
	_pollIntervalMs = 60_000,
): string {
	let open = 0;
	for (const info of Object.values(snapshot)) if ((info.status || "") === "open") open++;
	return `active (${open} open)`;
}

/**
 * Build the multi-line detailed status output used by the `status`
 * subcommand. This is the pre-#0031 body of {@link buildStartupChatMessage}.
 *
 * Format (rendered inside the [pi-local-issue-watcher] box):
 *
 *     status: active
 *     poll: 60s
 *     db: <path>
 *     issues: N open · M done · K wont_fix
 */
export function buildStatusDetailMessage(
	dbRoot: string,
	snapshot: Snapshot,
	pollIntervalMs = 60_000,
): string {
	const counts: Record<string, number> = {};
	for (const info of Object.values(snapshot)) {
		const s = info.status || "unknown";
		counts[s] = (counts[s] ?? 0) + 1;
	}
	const parts: string[] = [`${counts["open"] ?? 0} open`];
	for (const s of WELL_KNOWN_STATUSES) {
		if (s === "open") continue;
		if (s in counts) parts.push(`${counts[s]} ${s}`);
	}
	const leftover = Object.keys(counts)
		.filter((s) => !(WELL_KNOWN_STATUSES as readonly string[]).includes(s))
		.sort();
	for (const s of leftover) parts.push(`${counts[s]} ${s}`);
	const pollSeconds = Math.max(1, Math.round(pollIntervalMs / 1000));
	return [
		`status: active`,
		`poll: ${pollSeconds}s`,
		`db: ${dbRoot}`,
		`issues: ${parts.join(" · ")}`,
	].join("\n");
}

/** Render issue counts as "N open, M in_progress, ..." — matches the Python watcher. */
export function formatStatusSummary(snapshot: Snapshot): string {
	const counts: Record<string, number> = {};
	for (const info of Object.values(snapshot)) {
		const s = info.status || "unknown";
		counts[s] = (counts[s] ?? 0) + 1;
	}
	const parts: string[] = [];
	for (const s of WELL_KNOWN_STATUSES) {
		if (s in counts) parts.push(`${counts[s]} ${s}`);
	}
	const leftover = Object.keys(counts)
		.filter((s) => !(WELL_KNOWN_STATUSES as readonly string[]).includes(s))
		.sort();
	for (const s of leftover) parts.push(`${counts[s]} ${s}`);
	return parts.length === 0 ? "0 issues" : parts.join(", ");
}

/**
 * Compact open-count summary for the pinned status row.
 *
 * Format: `N open`
 *
 * Only the open count is surfaced — it is the only actionable signal at
 * a glance. Per-status breakdown goes to the chat surface via
 * {@link buildStartupChatMessage}.
 */
export function formatCompactStatusSummary(snapshot: Snapshot): string {
	let open = 0;
	for (const info of Object.values(snapshot)) if ((info.status || "") === "open") open++;
	return `${open} open`;
}

/**
 * Build the `content` field of the `pi.sendMessage` payload the watcher
 * delivers whenever it detects ≥ 1 change. Structure:
 *
 *     [HH:MM] N update(s):
 *     - <rendered change 1>
 *     - <rendered change 2>
 *     ...
 *
 * `HH:MM` is the local-time clock reading of `now` (typically the moment
 * the watcher observed the change), with zero-padded fields. Callers supply
 * the `Date` so tests can pin the value without clock mocking.
 *
 * The empty-array case returns an empty string; callers are expected to skip
 * delivery in that case (we never want to flood chat with a no-op header).
 */
export function buildChatMessageContent(changes: Change[], now: Date): string {
	if (changes.length === 0) return "";
	const header =
		changes.length === 1
			? `[${formatShortTime(now)}] 1 update:`
			: `[${formatShortTime(now)}] ${changes.length} updates:`;
	const bullets = changes.map((c) => `- ${formatChange(c)}`);
	return [header, ...bullets].join("\n");
}
