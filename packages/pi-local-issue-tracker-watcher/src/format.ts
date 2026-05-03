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
 * where `<state>` is typically `active` or `resumed`. When `lastUpdateAt`
 * **or** `now` is supplied, a ` | last update: <phrase>` segment is
 * appended (see {@link formatTimeSince}); omitting both preserves the
 * original format for back-compat.
 *
 * **Paused state (#0010)**: when `state === "paused"` the per-status count
 * summary is dropped entirely — a paused watcher is not producing a live
 * readout, and freezing a count into the status bar is misleading. The
 * last-update phrase (if provided) is still rendered because it is
 * historical information, not a live count.
 *
 * The message is meant for `ctx.ui.setStatus` (pinned status-row text) and
 * must NOT trigger an agent turn — it is purely a user-visible status line.
 */
export function buildStartupAnnouncement(
	state: string,
	dbRoot: string,
	pollIntervalMs: number,
	snapshot: Snapshot,
	lastUpdateAt?: number,
	now?: Date,
): string {
	const pollSeconds = Math.round(pollIntervalMs / 1000);
	const prefix = `issue-watcher: ${state} | dbRoot=${dbRoot} | poll=${pollSeconds}s`;
	const base = state === "paused" ? prefix : `${prefix} | ${formatStatusSummary(snapshot)}`;
	if (lastUpdateAt === undefined && now === undefined) return base;
	return `${base} | last update: ${formatTimeSince(now ?? new Date(), lastUpdateAt)}`;
}

/**
 * Render a human-friendly "time since N" phrase relative to `now`.
 *
 * Bucket rules (#0009):
 *  - `lastUpdateAt` undefined → `"never"`
 *  - delta  < 10s   → `"just now"`
 *  - delta  < 60s   → `"Ns ago"`
 *  - delta  < 60m   → `"Nm ago"`
 *  - delta  < 24h   → `"Nh ago"`
 *  - delta >= 24h   → `"Nd ago"`
 *
 * Future timestamps (clock skew / rehydrated-from-future-state) are treated
 * as `"just now"` — the watcher never surfaces negative ages.
 */
export function formatTimeSince(now: Date, lastUpdateAt: number | undefined): string {
	if (lastUpdateAt === undefined) return "never";
	const delta = now.getTime() - lastUpdateAt;
	if (delta < 10_000) return "just now";
	if (delta < 60_000) return `${Math.floor(delta / 1_000)}s ago`;
	if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)}m ago`;
	if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))}h ago`;
	return `${Math.floor(delta / (24 * 60 * 60_000))}d ago`;
}

/**
 * Build the single-line, chat-visible startup announcement the watcher
 * posts on each `session_start` so the LLM can see the watcher is active
 * and knows which tracker it is monitoring (#0011).
 *
 * Format: `issue-watcher: active | dbRoot=<path> | <summary>`
 *
 * The summary includes an explicit `0 open` segment when the tracker has
 * no open issues — downstream agents can key off a stable structured shape.
 *
 * Unlike {@link buildStartupAnnouncement} (which goes to the pinned status
 * row), this string is intended for `pi.sendMessage({ triggerTurn: false })`
 * so it lands in the conversation but does not cost an agent turn.
 */
export function buildStartupChatMessage(dbRoot: string, snapshot: Snapshot): string {
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
	return `issue-watcher: active | dbRoot=${dbRoot} | ${parts.join(", ")}`;
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
 *     [HH:MM:SS] N issue update(s)
 *     - <rendered change 1>
 *     - <rendered change 2>
 *     ...
 *
 * `HH:MM:SS` is the local-time clock reading of `now` (typically the moment
 * the watcher observed the change), with zero-padded fields. Callers supply
 * the `Date` so tests can pin the value without clock mocking.
 *
 * The empty-array case returns an empty string; callers are expected to skip
 * delivery in that case (we never want to flood chat with a no-op header).
 */
export function buildChatMessageContent(changes: Change[], now: Date): string {
	if (changes.length === 0) return "";
	const stamp = formatLocalHms(now);
	const header =
		changes.length === 1
			? `[${stamp}] 1 issue update`
			: `[${stamp}] ${changes.length} issue updates`;
	const bullets = changes.map((c) => `- ${formatChange(c)}`);
	return [header, ...bullets].join("\n");
}

/** Zero-padded local-time `HH:MM:SS` for a given Date. */
function formatLocalHms(d: Date): string {
	const pad = (n: number): string => n.toString().padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
