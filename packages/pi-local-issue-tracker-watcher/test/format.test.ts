import { describe, expect, it } from "vitest";

import { buildChatMessageContent, buildStartupAnnouncement, buildStartupChatMessage, formatStatusSummary, formatTimeSince } from "../src/format.js";
import type { Change } from "../src/diff.js";
import type { Snapshot } from "../src/types.js";

function issue(status: string): Snapshot[string] {
	return {
		mtimeNs: 1n,
		issueId: "0001",
		status,
		title: "t",
		description: "d",
		comments: [],
		skill: "s",
		skillVersion: "1.0.0",
	};
}

describe("formatStatusSummary", () => {
	it("returns '0 issues' for an empty snapshot", () => {
		expect(formatStatusSummary({})).toBe("0 issues");
	});

	it("orders well-known statuses first: open, in_progress, done, wont_fix", () => {
		const snap: Snapshot = {
			"/a": issue("done"),
			"/b": issue("open"),
			"/c": issue("open"),
			"/d": issue("in_progress"),
			"/e": issue("wont_fix"),
		};
		expect(formatStatusSummary(snap)).toBe(
			"2 open, 1 in_progress, 1 done, 1 wont_fix",
		);
	});

	it("appends unknown statuses alphabetically after the well-known ones", () => {
		const snap: Snapshot = {
			"/a": issue("open"),
			"/b": issue("zeta"),
			"/c": issue("alpha"),
		};
		expect(formatStatusSummary(snap)).toBe("1 open, 1 alpha, 1 zeta");
	});
});

describe("buildStartupAnnouncement", () => {
	it("includes the state, absolute dbRoot, poll seconds, and status summary", () => {
		const snap: Snapshot = {
			"/a": issue("open"),
			"/b": issue("in_progress"),
		};
		const msg = buildStartupAnnouncement("active", "/abs/db", 60_000, snap);
		expect(msg).toBe(
			"issue-watcher: active | dbRoot=/abs/db | poll=60s | 1 open, 1 in_progress",
		);
	});

	it("renders '0 issues' for an empty tracker", () => {
		const msg = buildStartupAnnouncement("active", "/abs/db", 60_000, {});
		expect(msg).toContain("0 issues");
		expect(msg).toContain("/abs/db");
	});

	it("honours alternate states like 'resumed'", () => {
		const msg = buildStartupAnnouncement("resumed", "/abs/db", 60_000, {});
		expect(msg.startsWith("issue-watcher: resumed | ")).toBe(true);
	});

	it("rounds the poll interval to whole seconds", () => {
		const msg = buildStartupAnnouncement("active", "/abs/db", 30_000, {});
		expect(msg).toContain("poll=30s");
	});
});

describe("buildChatMessageContent", () => {
	const change1: Change = {
		kind: "status_changed",
		path: "/db/skill-a/0001-x.json",
		issueId: "0001",
		skill: "skill-a",
		from: "open",
		to: "done",
	};
	const change2: Change = {
		kind: "comment_added",
		path: "/db/skill-b/0002-y.json",
		issueId: "0002",
		skill: "skill-b",
		preview: "hi there",
	};

	it("uses a singular header for a single change", () => {
		const out = buildChatMessageContent([change1], new Date(2026, 4, 3, 14, 30, 5));
		expect(out.split("\n")[0]).toMatch(/^\[14:30:05\] 1 issue update/);
	});

	it("uses a plural header for multiple changes and bullets each one", () => {
		const out = buildChatMessageContent([change1, change2], new Date(2026, 4, 3, 9, 5, 8));
		const lines = out.split("\n");
		expect(lines[0]).toMatch(/^\[09:05:08\] 2 issue updates/);
		// Each non-header line is a bullet containing the rendered change.
		const bullets = lines.slice(1).filter((l) => l.trim().startsWith("-"));
		expect(bullets).toHaveLength(2);
		expect(bullets.some((b) => b.includes("status changed: open -> done"))).toBe(true);
		expect(bullets.some((b) => b.includes("hi there"))).toBe(true);
	});

	it("returns an empty string when there are no changes (callers must guard)", () => {
		expect(buildChatMessageContent([], new Date())).toBe("");
	});

	it("zero-pads hours, minutes, and seconds in local time", () => {
		const out = buildChatMessageContent([change1], new Date(2026, 0, 1, 1, 2, 3));
		expect(out.split("\n")[0]).toMatch(/^\[01:02:03\] /);
	});

	it("handles midnight (00:00:00) without collapsing digits", () => {
		const out = buildChatMessageContent([change1], new Date(2026, 0, 1, 0, 0, 0));
		expect(out.split("\n")[0]).toMatch(/^\[00:00:00\] /);
	});

	it("handles the end-of-day boundary (23:59:59)", () => {
		const out = buildChatMessageContent([change1], new Date(2026, 0, 1, 23, 59, 59));
		expect(out.split("\n")[0]).toMatch(/^\[23:59:59\] /);
	});
});

// ---------------------------------------------------------------------------
// formatTimeSince / buildStartupAnnouncement with last-update phrase (#0009)
// ---------------------------------------------------------------------------

describe("formatTimeSince", () => {
	const NOW = new Date(2026, 4, 3, 12, 0, 0); // 12:00:00 local

	it("returns 'never' when no timestamp has been recorded yet", () => {
		expect(formatTimeSince(NOW, undefined)).toBe("never");
	});

	it("returns 'just now' for deltas < 10s", () => {
		expect(formatTimeSince(NOW, NOW.getTime())).toBe("just now");
		expect(formatTimeSince(NOW, NOW.getTime() - 9_000)).toBe("just now");
		expect(formatTimeSince(NOW, NOW.getTime() - 9_999)).toBe("just now");
	});

	it("returns 'Ns ago' for 10s..<60s", () => {
		expect(formatTimeSince(NOW, NOW.getTime() - 10_000)).toBe("10s ago");
		expect(formatTimeSince(NOW, NOW.getTime() - 42_000)).toBe("42s ago");
		expect(formatTimeSince(NOW, NOW.getTime() - 59_999)).toBe("59s ago");
	});

	it("returns 'Nm ago' for 60s..<60m", () => {
		expect(formatTimeSince(NOW, NOW.getTime() - 60_000)).toBe("1m ago");
		expect(formatTimeSince(NOW, NOW.getTime() - 5 * 60_000)).toBe("5m ago");
		expect(formatTimeSince(NOW, NOW.getTime() - 59 * 60_000)).toBe("59m ago");
		expect(formatTimeSince(NOW, NOW.getTime() - 60 * 60_000 + 1)).toBe("59m ago");
	});

	it("returns 'Nh ago' for 60m..<24h", () => {
		expect(formatTimeSince(NOW, NOW.getTime() - 60 * 60_000)).toBe("1h ago");
		expect(formatTimeSince(NOW, NOW.getTime() - 23 * 60 * 60_000)).toBe("23h ago");
		expect(formatTimeSince(NOW, NOW.getTime() - 24 * 60 * 60_000 + 1)).toBe("23h ago");
	});

	it("returns 'Nd ago' for >= 24h", () => {
		expect(formatTimeSince(NOW, NOW.getTime() - 24 * 60 * 60_000)).toBe("1d ago");
		expect(formatTimeSince(NOW, NOW.getTime() - 7 * 24 * 60 * 60_000)).toBe("7d ago");
		expect(formatTimeSince(NOW, NOW.getTime() - 365 * 24 * 60 * 60_000)).toBe("365d ago");
	});

	it("treats future timestamps as 'just now' defensively", () => {
		expect(formatTimeSince(NOW, NOW.getTime() + 5_000)).toBe("just now");
	});
});

describe("buildStartupAnnouncement with lastUpdateAt (#0009)", () => {
	const NOW = new Date(2026, 4, 3, 12, 0, 0);

	it("omits the 'last update' segment when lastUpdateAt is undefined (back-compat)", () => {
		const msg = buildStartupAnnouncement("active", "/abs/db", 60_000, {});
		expect(msg).toBe("issue-watcher: active | dbRoot=/abs/db | poll=60s | 0 issues");
	});

	it("appends 'last update: never' when lastUpdateAt is undefined but a clock is supplied", () => {
		const msg = buildStartupAnnouncement("active", "/abs/db", 60_000, {}, undefined, NOW);
		expect(msg).toBe(
			"issue-watcher: active | dbRoot=/abs/db | poll=60s | 0 issues | last update: never",
		);
	});

	it("appends a human-friendly 'last update: Nm ago' when lastUpdateAt is recent", () => {
		const msg = buildStartupAnnouncement(
			"active",
			"/abs/db",
			60_000,
			{},
			NOW.getTime() - 3 * 60_000,
			NOW,
		);
		expect(msg).toContain("| last update: 3m ago");
	});

	it("works for the 'resumed' state the same way", () => {
		const msg = buildStartupAnnouncement(
			"resumed",
			"/abs/db",
			60_000,
			{},
			NOW.getTime() - 10_000,
			NOW,
		);
		expect(msg.startsWith("issue-watcher: resumed | ")).toBe(true);
		expect(msg).toContain("| last update: 10s ago");
	});
});

describe("buildStartupAnnouncement when paused (#0010)", () => {
	const NOW = new Date(2026, 4, 3, 12, 0, 0);

	it("drops the per-status counts segment for the paused state", () => {
		const snap: Snapshot = {
			"/a": issue("open"),
			"/b": issue("in_progress"),
			"/c": issue("done"),
		};
		const msg = buildStartupAnnouncement("paused", "/abs/db", 60_000, snap);
		expect(msg).toBe("issue-watcher: paused | dbRoot=/abs/db | poll=60s");
		expect(msg).not.toMatch(/open|in_progress|done/);
	});

	it("keeps the last-update segment on the paused line (issue #0010, per user decision)", () => {
		const msg = buildStartupAnnouncement(
			"paused",
			"/abs/db",
			60_000,
			{ "/a": issue("open") },
			NOW.getTime() - 5 * 60_000,
			NOW,
		);
		expect(msg).toBe(
			"issue-watcher: paused | dbRoot=/abs/db | poll=60s | last update: 5m ago",
		);
		expect(msg).not.toMatch(/\d\s+(open|in_progress|done)/);
	});

	it("paused line with no lastUpdateAt and no clock omits both counts and last-update", () => {
		const msg = buildStartupAnnouncement("paused", "/abs/db", 60_000, {
			"/a": issue("open"),
		});
		expect(msg).toBe("issue-watcher: paused | dbRoot=/abs/db | poll=60s");
	});

	it("paused line shows 'last update: never' when clock is supplied but no lastUpdateAt", () => {
		const msg = buildStartupAnnouncement("paused", "/abs/db", 60_000, {}, undefined, NOW);
		expect(msg).toBe("issue-watcher: paused | dbRoot=/abs/db | poll=60s | last update: never");
	});

	it("'active' still includes counts", () => {
		const msg = buildStartupAnnouncement("active", "/abs/db", 60_000, {
			"/a": issue("open"),
		});
		expect(msg).toContain("1 open");
	});
});

// ---------------------------------------------------------------------------
// buildStartupChatMessage (#0011) — chat-visible startup summary
// ---------------------------------------------------------------------------

describe("buildStartupChatMessage (#0011)", () => {
	it("contains 'active', the absolute dbRoot, and the status summary", () => {
		const msg = buildStartupChatMessage("/abs/db", {
			"/a": issue("open"),
			"/b": issue("in_progress"),
			"/c": issue("done"),
		});
		expect(msg).toBe(
			"issue-watcher: active | dbRoot=/abs/db | 1 open, 1 in_progress, 1 done",
		);
	});

	it("includes an explicit 'N open' segment even when zero (structured signal for the LLM)", () => {
		const msg = buildStartupChatMessage("/abs/db", {
			"/a": issue("done"),
			"/b": issue("wont_fix"),
		});
		expect(msg).toMatch(/0 open/);
	});

	it("returns a sensible line for an empty tracker", () => {
		const msg = buildStartupChatMessage("/abs/db", {});
		expect(msg).toBe("issue-watcher: active | dbRoot=/abs/db | 0 open");
	});
});
