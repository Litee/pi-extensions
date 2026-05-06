import { describe, expect, it } from "vitest";

import { buildChatMessageContent, buildMissingDbRootStatus, buildStartupAnnouncement, buildStartupChatMessage, formatStatusSummary } from "../src/format.js";
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

describe("buildStartupAnnouncement (#0022)", () => {
	it("is a compact two-segment line: '<state> | <open> open, <total> total'", () => {
		const snap: Snapshot = {
			"/a": issue("open"),
			"/b": issue("in_progress"),
		};
		// Per #0022 the dbRoot and poll-period segments are both
		// dropped from the pinned status row — they are static config
		// that rarely changes and belong to an info / inspection
		// surface, not the always-visible line.
		const msg = buildStartupAnnouncement("active", "/abs/db", 60_000, snap);
		expect(msg).toBe("local-issue-watcher: active | 1 open, 2 total");
	});

	it("renders '0 open, 0 total' for an empty tracker and no dbRoot segment", () => {
		const msg = buildStartupAnnouncement("active", "/abs/db", 60_000, {});
		expect(msg).toBe("local-issue-watcher: active | 0 open, 0 total");
		expect(msg).not.toContain("dbRoot");
		expect(msg).not.toContain("/a/db");
		expect(msg).not.toContain("/abs");
	});

	it("honours alternate states like 'resumed'", () => {
		const msg = buildStartupAnnouncement("resumed", "/abs/db", 60_000, {});
		expect(msg.startsWith("local-issue-watcher: resumed | ")).toBe(true);
	});

	it("drops the poll=<N>s segment entirely (#0022)", () => {
		const msg = buildStartupAnnouncement("active", "/abs/db", 30_000, {
			"/a": issue("open"),
		});
		expect(msg).not.toContain("poll=");
		expect(msg).not.toContain("30s");
	});

	it("ignores the dbRoot and pollIntervalMs arguments (retained for signature compatibility with chat surfaces)", () => {
		// The dbRoot/poll parameters are still threaded through callers
		// to the chat-surface `buildStartupChatMessage`; this function
		// silently ignores them.
		const a = buildStartupAnnouncement("active", "/abs/db", 60_000, {
			"/a": issue("open"),
		});
		const b = buildStartupAnnouncement("active", "/completely/other/path", 999_999, {
			"/a": issue("open"),
		});
		expect(a).toBe(b);
	});

	it("collapses per-status breakdown into a single 'total' number (#0022)", () => {
		const snap: Snapshot = {
			"/a": issue("open"),
			"/b": issue("done"),
			"/c": issue("done"),
			"/d": issue("wont_fix"),
		};
		const msg = buildStartupAnnouncement("active", "/abs/db", 60_000, snap);
		expect(msg).toBe("local-issue-watcher: active | 1 open, 4 total");
		expect(msg).not.toMatch(/done|wont_fix|in_progress/);
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
// buildStartupAnnouncement when paused (#0010)
// ---------------------------------------------------------------------------

describe("buildStartupAnnouncement when paused (#0010, #0022)", () => {
	it("drops the count summary entirely for the paused state", () => {
		const snap: Snapshot = {
			"/a": issue("open"),
			"/b": issue("in_progress"),
			"/c": issue("done"),
		};
		const msg = buildStartupAnnouncement("paused", "/abs/db", 60_000, snap);
		expect(msg).toBe("local-issue-watcher: paused");
		expect(msg).not.toMatch(/open|in_progress|done|total/);
	});

	it("paused line is exactly the prefix — no dbRoot, no poll, no counts (#0022)", () => {
		const msg = buildStartupAnnouncement("paused", "/abs/db", 60_000, {
			"/a": issue("open"),
		});
		expect(msg).toBe("local-issue-watcher: paused");
	});

	it("'active' still includes counts", () => {
		const msg = buildStartupAnnouncement("active", "/abs/db", 60_000, {
			"/a": issue("open"),
		});
		expect(msg).toContain("1 open");
		expect(msg).toContain("1 total");
	});
});

// ---------------------------------------------------------------------------
// buildStartupAnnouncement — no last-update segment (#0016)
// ---------------------------------------------------------------------------

describe("buildStartupAnnouncement has no last-update segment (#0016, #0022)", () => {
	it("active state ends at the counts — no 'last update:' phrase, no dbRoot, no poll", () => {
		const msg = buildStartupAnnouncement("active", "/abs/db", 60_000, {
			"/a": issue("open"),
		});
		expect(msg).toBe("local-issue-watcher: active | 1 open, 1 total");
		expect(msg).not.toMatch(/last update/);
		expect(msg).not.toMatch(/\b(never|just now|\dm ago|\dh ago|\dd ago)\b/);
	});

	it("paused state is exactly the prefix — no 'last update:', no dbRoot, no poll", () => {
		const msg = buildStartupAnnouncement("paused", "/abs/db", 60_000, {});
		expect(msg).toBe("local-issue-watcher: paused");
		expect(msg).not.toMatch(/last update/);
	});
});

// ---------------------------------------------------------------------------
// buildStartupChatMessage (#0011) — chat-visible startup summary
// ---------------------------------------------------------------------------

describe("buildStartupChatMessage (#0011)", () => {
	it("first two lines are 'active' then 'poll=Ns', no extension-name prefix", () => {
		const msg = buildStartupChatMessage("/abs/db", {
			"/a": issue("open"),
			"/b": issue("in_progress"),
			"/c": issue("done"),
		});
		const lines = msg.split("\n");
		expect(lines[0]).toBe("active");
		expect(lines[1]).toBe("poll=60s");
		expect(lines[2]).toBe("dbRoot: /abs/db");
		expect(lines[3]).toBe("1 open \u00b7 1 in_progress \u00b7 1 done");
		// No extension-name prefix — the box header already identifies the source.
		expect(lines[0]).not.toContain("local-issue-watcher:");
		// No commands hint line.
		expect(msg).not.toContain("/local-issue-watcher:");
	});

	it("includes an explicit 'N open' segment even when zero (structured signal for the LLM)", () => {
		const msg = buildStartupChatMessage("/abs/db", {
			"/a": issue("done"),
			"/b": issue("wont_fix"),
		});
		expect(msg).toMatch(/0 open/);
	});

	it("returns a sensible format for an empty tracker", () => {
		const msg = buildStartupChatMessage("/abs/db", {});
		const lines = msg.split("\n");
		expect(lines[0]).toBe("active");
		expect(lines[1]).toBe("poll=60s");
		expect(lines[2]).toBe("dbRoot: /abs/db");
		expect(lines[3]).toBe("0 open");
	});

	it("respects a custom pollIntervalMs", () => {
		const msg = buildStartupChatMessage("/abs/db", {}, 30_000);
		const lines = msg.split("\n");
		expect(lines[0]).toBe("active");
		expect(lines[1]).toBe("poll=30s");
	});
});

// ---------------------------------------------------------------------------
// buildMissingDbRootStatus (#0014) — pinned status line when dbRoot is absent
// ---------------------------------------------------------------------------

describe("buildMissingDbRootStatus (#0014)", () => {
	it("contains the 'dbRoot missing' state marker and the abbreviated path (#0018)", () => {
		const msg = buildMissingDbRootStatus("/some/missing/path");
		expect(msg).toContain("local-issue-watcher: dbRoot missing");
		expect(msg).toContain("/s/m/path");
		// The raw full path and the `dbRoot=` label must NOT appear — this is a
		// pinned status line, not a user-triggered notification (#0018).
		expect(msg).not.toContain("/some/missing/path");
		expect(msg).not.toContain("dbRoot=");
	});

	it("surfaces a remediation hint (env var or directory creation)", () => {
		const msg = buildMissingDbRootStatus("/abs/db");
		expect(msg).toMatch(/LOCAL_ISSUE_TRACKER_DB_ROOT|create the directory/);
	});

	it("is a single line with no newlines", () => {
		const msg = buildMissingDbRootStatus("/abs/db");
		expect(msg).not.toMatch(/\n/);
	});
});
