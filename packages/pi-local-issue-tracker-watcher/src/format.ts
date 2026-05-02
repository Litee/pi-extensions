import type { Change } from "./diff.js";
import { formatChange } from "./diff.js";
import type { Snapshot } from "./types.js";

/**
 * Well-known statuses emitted by `local-skill-issues-tracker`, in the order
 * `watch_issues.py` uses for its summary line. Anything not in this list is
 * appended alphabetically after.
 */
const WELL_KNOWN_STATUSES = ["open", "in_progress", "done", "wont_fix"] as const;

/**
 * Build the one-line session-start / resume announcement.
 *
 * Format: `issue-watcher: <state> | dbRoot=<path> | poll=<N>s | <summary>`
 * where `<state>` is typically `active` or `resumed`. The message is meant
 * for `ctx.ui.notify` (informational toast) and must NOT trigger an agent
 * turn — it is purely a user-visible status line.
 */
export function buildStartupAnnouncement(
	state: string,
	dbRoot: string,
	pollIntervalMs: number,
	snapshot: Snapshot,
): string {
	const pollSeconds = Math.round(pollIntervalMs / 1000);
	return `issue-watcher: ${state} | dbRoot=${dbRoot} | poll=${pollSeconds}s | ${formatStatusSummary(snapshot)}`;
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
 * Build the `content` field of the `pi.sendMessage` payload the watcher
 * delivers whenever it detects ≥ 1 change. Structure:
 *
 *     N issue update(s)
 *     - <rendered change 1>
 *     - <rendered change 2>
 *     ...
 *
 * The empty-array case returns an empty string; callers are expected to skip
 * delivery in that case (we never want to flood chat with a no-op header).
 */
export function buildChatMessageContent(changes: Change[]): string {
	if (changes.length === 0) return "";
	const header =
		changes.length === 1
			? "1 issue update"
			: `${changes.length} issue updates`;
	const bullets = changes.map((c) => `- ${formatChange(c)}`);
	return [header, ...bullets].join("\n");
}
