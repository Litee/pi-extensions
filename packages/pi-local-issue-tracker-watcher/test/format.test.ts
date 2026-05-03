import { describe, expect, it } from "vitest";

import { buildChatMessageContent, buildStartupAnnouncement, formatStatusSummary } from "../src/format.js";
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
