import { describe, expect, it } from "vitest";

import { buildChatMessageContent, buildFirstUpdateContent, buildMissingDbRootChatMessage, buildMissingDbRootStatus, buildStartupAnnouncement, buildStartupChatMessage, buildStatusDetailMessage, formatStatusSummary } from "../src/format.js";
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
	it("is a compact line: 'active (N open)'", () => {
		const snap: Snapshot = {
			"/a": issue("open"),
			"/b": issue("in_progress"),
		};
		const msg = buildStartupAnnouncement("active", "/abs/db", 60_000, snap);
		expect(msg).toBe("local-issue-watcher: active (1 open)");
	});

	it("renders '(0 open)' for an empty tracker", () => {
		const msg = buildStartupAnnouncement("active", "/abs/db", 60_000, {});
		expect(msg).toBe("local-issue-watcher: active (0 open)");
		expect(msg).not.toContain("dbRoot");
		expect(msg).not.toContain("/abs");
	});

	it("drops the poll=<N>s segment entirely", () => {
		const msg = buildStartupAnnouncement("active", "/abs/db", 30_000, {
			"/a": issue("open"),
		});
		expect(msg).not.toContain("poll=");
		expect(msg).not.toContain("30s");
	});

	it("ignores the dbRoot and pollIntervalMs arguments", () => {
		const a = buildStartupAnnouncement("active", "/abs/db", 60_000, {
			"/a": issue("open"),
		});
		const b = buildStartupAnnouncement("active", "/completely/other/path", 999_999, {
			"/a": issue("open"),
		});
		expect(a).toBe(b);
	});

	it("counts only open issues, not total", () => {
		const snap: Snapshot = {
			"/a": issue("open"),
			"/b": issue("done"),
			"/c": issue("done"),
			"/d": issue("wont_fix"),
		};
		const msg = buildStartupAnnouncement("active", "/abs/db", 60_000, snap);
		expect(msg).toBe("local-issue-watcher: active (1 open)");
		expect(msg).not.toMatch(/done|wont_fix|in_progress|total/);
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
		expect(out.split("\n")[0]).toMatch(/^\[14:30\] 1 update:/);
	});

	it("uses a plural header for multiple changes and bullets each one", () => {
		const out = buildChatMessageContent([change1, change2], new Date(2026, 4, 3, 9, 5, 8));
		const lines = out.split("\n");
		expect(lines[0]).toMatch(/^\[09:05\] 2 updates:/);
		// Each non-header line is a bullet containing the rendered change.
		const bullets = lines.slice(1).filter((l) => l.trim().startsWith("-"));
		expect(bullets).toHaveLength(2);
		expect(bullets.some((b) => b.includes("status changed: open -> done"))).toBe(true);
		expect(bullets.some((b) => b.includes("hi there"))).toBe(true);
	});

	it("returns an empty string when there are no changes (callers must guard)", () => {
		expect(buildChatMessageContent([], new Date())).toBe("");
	});

	it("zero-pads hours and minutes in local time", () => {
		const out = buildChatMessageContent([change1], new Date(2026, 0, 1, 1, 2, 3));
		expect(out.split("\n")[0]).toMatch(/^\[01:02\] /);
	});

	it("handles midnight (00:00) without collapsing digits", () => {
		const out = buildChatMessageContent([change1], new Date(2026, 0, 1, 0, 0, 0));
		expect(out.split("\n")[0]).toMatch(/^\[00:00\] /);
	});

	it("handles the end-of-day boundary (23:59)", () => {
		const out = buildChatMessageContent([change1], new Date(2026, 0, 1, 23, 59, 59));
		expect(out.split("\n")[0]).toMatch(/^\[23:59\] /);
	});
});

// ---------------------------------------------------------------------------
// buildStartupAnnouncement when paused (#0010)
// ---------------------------------------------------------------------------

describe("buildStartupAnnouncement — active state", () => {
	it("'active' includes open count", () => {
		const msg = buildStartupAnnouncement("active", "/abs/db", 60_000, {
			"/a": issue("open"),
		});
		expect(msg).toContain("1 open");
		expect(msg).not.toContain("total");
	});
});

// ---------------------------------------------------------------------------
// buildStartupAnnouncement — no last-update segment (#0016)
// ---------------------------------------------------------------------------

describe("buildStartupAnnouncement has no last-update segment", () => {
	it("active state ends at the open count — no 'last update:', no dbRoot, no poll", () => {
		const msg = buildStartupAnnouncement("active", "/abs/db", 60_000, {
			"/a": issue("open"),
		});
		expect(msg).toBe("local-issue-watcher: active (1 open)");
		expect(msg).not.toMatch(/last update/);
		expect(msg).not.toMatch(/\b(never|just now|\dm ago|\dh ago|\dd ago)\b/);
	});
});

// ---------------------------------------------------------------------------
// buildStartupChatMessage (#0011) — chat-visible startup summary
// ---------------------------------------------------------------------------

describe("buildStartupChatMessage (#0011, #0031)", () => {
	it("returns 'active (N open)' with the open count from the snapshot", () => {
		const snap: Snapshot = {
			"/a": issue("open"),
			"/b": issue("open"),
			"/c": issue("done"),
		};
		expect(buildStartupChatMessage("/abs/db", snap)).toBe("active (2 open)");
	});

	it("returns 'active (0 open)' when no issues are open", () => {
		expect(buildStartupChatMessage("/abs/db", {})).toBe("active (0 open)");
	});

	it("ignores dbRoot and pollIntervalMs (signature compatibility)", () => {
		expect(buildStartupChatMessage("/ignored", {}, 30_000)).toBe("active (0 open)");
	});

	it("counts only 'open' — done/wont_fix/in_progress do not leak in", () => {
		const snap: Snapshot = {
			"/a": issue("done"),
			"/b": issue("wont_fix"),
			"/c": issue("in_progress"),
		};
		const msg = buildStartupChatMessage("/abs/db", snap);
		expect(msg).toBe("active (0 open)");
		expect(msg).not.toMatch(/done|wont_fix|in_progress|poll|db:/);
	});
});

// ---------------------------------------------------------------------------
// buildStatusDetailMessage (#0031) — detailed output used by `status` command
// ---------------------------------------------------------------------------

describe("buildStatusDetailMessage (#0031)", () => {
	it("first two lines are 'status: active' then 'poll: Ns', no extension-name prefix", () => {
		const msg = buildStatusDetailMessage("/abs/db", {
			"/a": issue("open"),
			"/b": issue("in_progress"),
			"/c": issue("done"),
		});
		const lines = msg.split("\n");
		expect(lines[0]).toBe("status: active");
		expect(lines[1]).toBe("poll: 60s");
		expect(lines[2]).toBe("db: /abs/db");
		expect(lines[3]).toBe("issues: 1 open \u00b7 1 in_progress \u00b7 1 done");
		expect(lines[0]).not.toContain("local-issue-watcher:");
	});

	it("includes an explicit 'N open' segment even when zero", () => {
		const msg = buildStatusDetailMessage("/abs/db", {
			"/a": issue("done"),
			"/b": issue("wont_fix"),
		});
		expect(msg).toMatch(/0 open/);
	});

	it("returns a sensible format for an empty tracker", () => {
		const msg = buildStatusDetailMessage("/abs/db", {});
		const lines = msg.split("\n");
		expect(lines[0]).toBe("status: active");
		expect(lines[1]).toBe("poll: 60s");
		expect(lines[2]).toBe("db: /abs/db");
		expect(lines[3]).toBe("issues: 0 open");
	});

	it("respects a custom pollIntervalMs", () => {
		const msg = buildStatusDetailMessage("/abs/db", {}, 30_000);
		const lines = msg.split("\n");
		expect(lines[0]).toBe("status: active");
		expect(lines[1]).toBe("poll: 30s");
	});
});

// ---------------------------------------------------------------------------
// buildMissingDbRootStatus — pinned status line when dbRoot is absent
// ---------------------------------------------------------------------------

describe("buildMissingDbRootStatus", () => {
	it("contains the 'dbRoot missing' state marker and the abbreviated path", () => {
		const msg = buildMissingDbRootStatus("/some/missing/path");
		expect(msg).toContain("local-issue-watcher: dbRoot missing");
		expect(msg).toContain("/s/m/path");
		expect(msg).not.toContain("/some/missing/path");
		expect(msg).not.toContain("dbRoot=");
	});

	it("does not contain remediation guidance (that lives in the chat message)", () => {
		const msg = buildMissingDbRootStatus("/abs/db");
		expect(msg).not.toMatch(/LOCAL_ISSUE_TRACKER_DB_ROOT|create the directory|mkdir/);
	});

	it("is a single line with no newlines", () => {
		const msg = buildMissingDbRootStatus("/abs/db");
		expect(msg).not.toMatch(/\n/);
	});
});

// ---------------------------------------------------------------------------
// buildMissingDbRootChatMessage — chat message when dbRoot is absent
// ---------------------------------------------------------------------------

describe("buildMissingDbRootChatMessage", () => {
	it("starts with 'status: dbRoot missing'", () => {
		const msg = buildMissingDbRootChatMessage("/abs/db");
		expect(msg.split("\n")[0]).toBe("status: dbRoot missing");
	});

	it("includes the full dbRoot path", () => {
		const msg = buildMissingDbRootChatMessage("/abs/db");
		expect(msg).toContain("db: /abs/db");
	});

	it("includes mkdir remediation step with the exact path", () => {
		const msg = buildMissingDbRootChatMessage("/abs/db");
		expect(msg).toContain("mkdir -p /abs/db");
	});

	it("includes LOCAL_ISSUE_TRACKER_DB_ROOT remediation step", () => {
		const msg = buildMissingDbRootChatMessage("/abs/db");
		expect(msg).toContain("LOCAL_ISSUE_TRACKER_DB_ROOT");
	});

	it("is a multi-line string", () => {
		const msg = buildMissingDbRootChatMessage("/abs/db");
		expect(msg.split("\n").length).toBeGreaterThan(2);
	});
});

// ---------------------------------------------------------------------------
// buildFirstUpdateContent — first-scan summary with open-issues listing
// ---------------------------------------------------------------------------

describe("buildFirstUpdateContent", () => {
	const NOW = new Date(2026, 4, 3, 14, 7, 0); // 14:07

	function makeIssue(overrides: Partial<Snapshot[string]>): Snapshot[string] {
		return {
			mtimeNs: 1n,
			issueId: "0001",
			status: "open",
			title: "default title",
			description: "",
			comments: [],
			skill: "skill-a",
			skillVersion: "1.0.0",
			...overrides,
		};
	}

	it("(a) lists only open issues from a mixed snapshot, correct header and bullets ordered by path", () => {
		const snap: Snapshot = {
			"/db/skill-b/0002-b.json": makeIssue({ issueId: "0002", skill: "skill-b", title: "beta", status: "open" }),
			"/db/skill-a/0001-a.json": makeIssue({ issueId: "0001", skill: "skill-a", title: "alpha", status: "open" }),
			"/db/skill-c/0003-c.json": makeIssue({ issueId: "0003", skill: "skill-c", title: "gamma", status: "done" }),
			"/db/skill-d/0004-d.json": makeIssue({ issueId: "0004", skill: "skill-d", title: "delta", status: "wont_fix" }),
		};
		const out = buildFirstUpdateContent(snap, NOW);
		const lines = out.split("\n");
		// Header: tracking 2 open issues:
		expect(lines[0]).toBe("[14:07] tracking 2 open issues:");
		// Bullets sorted by path — skill-a path comes before skill-b path
		expect(lines[1]).toBe(`- issue #0001 (skill-a): "alpha" [open]`);
		expect(lines[2]).toBe(`- issue #0002 (skill-b): "beta" [open]`);
		expect(lines).toHaveLength(3);
		// No done / wont_fix issues
		expect(out).not.toContain("gamma");
		expect(out).not.toContain("delta");
		expect(out).not.toContain("done");
		expect(out).not.toContain("wont_fix");
	});

	it("(b) zero open issues → header-only with no colon and no bullets", () => {
		const snap: Snapshot = {
			"/db/skill-a/0001-a.json": makeIssue({ status: "done" }),
			"/db/skill-b/0002-b.json": makeIssue({ status: "wont_fix" }),
		};
		const out = buildFirstUpdateContent(snap, NOW);
		expect(out).toBe("[14:07] tracking 0 open issues");
		// No trailing colon after the header (the timestamp's ":" is fine)
		expect(out.endsWith("issues")).toBe(true);
		expect(out.split("\n")).toHaveLength(1);
	});

	it("(b) empty snapshot → header-only for zero open issues", () => {
		const out = buildFirstUpdateContent({}, NOW);
		expect(out).toBe("[14:07] tracking 0 open issues");
	});

	it("(c) single open issue → singular 'issue' (not 'issues')", () => {
		const snap: Snapshot = {
			"/db/skill-a/0001-a.json": makeIssue({ issueId: "0042", skill: "my-skill", title: "Fix bug", status: "open" }),
		};
		const out = buildFirstUpdateContent(snap, NOW);
		const lines = out.split("\n");
		expect(lines[0]).toBe("[14:07] tracking 1 open issue:");
		expect(lines[1]).toBe(`- issue #0042 (my-skill): "Fix bug" [open]`);
		expect(lines).toHaveLength(2);
		expect(out).not.toContain("issues:");
	});

	it("zero-pads the time correctly", () => {
		const earlyMorning = new Date(2026, 0, 1, 1, 2, 3);
		const out = buildFirstUpdateContent({}, earlyMorning);
		expect(out).toMatch(/^\[01:02\]/);
	});
});
