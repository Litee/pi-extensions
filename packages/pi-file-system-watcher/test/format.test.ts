/**
 * Tests for format.ts
 */

import { describe, expect, it } from "vitest";

import {
	buildChangeChatMessage,
	buildStartupChatMessage,
	buildStatusLine,
	buildWatchSummaryHeader,
} from "../src/format.js";
import type { FsEvent, WatchMap } from "../src/types.js";

// ---------------------------------------------------------------------------
// buildStatusLine
// ---------------------------------------------------------------------------

describe("buildStatusLine", () => {
	it("returns idle when no watches", () => {
		const res = buildStatusLine({ watches: {}, paused: false });
		expect(res.text).toBe("fs: idle");
		expect(res.colorAlias).toBe("muted");
	});

	it("shows active count", () => {
		const watches: WatchMap = {
			w1: {
				watchId: "w1",
				path: "/p",
				target: "exists",
				mode: "poll",
				timeoutAt: undefined,
				addedAt: 0,
				lastPolledAt: undefined,
				baseline: undefined,
				terminal: false,
				consecutiveErrors: 0,
			},
		};
		const res = buildStatusLine({ watches, paused: false });
		expect(res.text).toBe("fs: 1");
		expect(res.colorAlias).toBe("accent");
	});

	it("shows paused suffix", () => {
		const watches: WatchMap = {
			w1: {
				watchId: "w1",
				path: "/p",
				target: "exists",
				mode: "poll",
				timeoutAt: undefined,
				addedAt: 0,
				lastPolledAt: undefined,
				baseline: undefined,
				terminal: false,
				consecutiveErrors: 0,
			},
		};
		const res = buildStatusLine({ watches, paused: true });
		expect(res.text).toMatch(/paused/);
		expect(res.colorAlias).toBe("muted");
	});

	it("shows error indicator", () => {
		const watches: WatchMap = {
			w1: {
				watchId: "w1",
				path: "/p",
				target: "exists",
				mode: "poll",
				timeoutAt: undefined,
				addedAt: 0,
				lastPolledAt: undefined,
				baseline: undefined,
				terminal: false,
				consecutiveErrors: 0,
			},
		};
		const res = buildStatusLine({ watches, paused: false, hasErrors: true });
		expect(res.text).toMatch(/⚠/);
		expect(res.colorAlias).toBe("warning");
	});

	it("excludes terminal watches from count", () => {
		const watches: WatchMap = {
			w1: {
				watchId: "w1",
				path: "/p",
				target: "exists",
				mode: "poll",
				timeoutAt: undefined,
				addedAt: 0,
				lastPolledAt: undefined,
				baseline: undefined,
				terminal: true, // terminal
				consecutiveErrors: 0,
			},
		};
		const res = buildStatusLine({ watches, paused: false });
		expect(res.text).toBe("fs: idle");
	});
});

// ---------------------------------------------------------------------------
// buildChangeChatMessage
// ---------------------------------------------------------------------------

describe("buildChangeChatMessage", () => {
	it("formats a single event", () => {
		const events: FsEvent[] = [
			{
				watchId: "w1",
				path: "/tmp/x.txt",
				eventType: "exists",
				summary: "/tmp/x.txt now exists",
				formatted: "• /tmp/x.txt now exists ✓",
			},
		];
		const msg = buildChangeChatMessage(events, new Date("2024-01-01T10:30:00"));
		expect(msg).toMatch(/\[10:30\]/);
		expect(msg).toMatch(/1 event/);
		expect(msg).toMatch(/• \/tmp\/x\.txt now exists ✓/);
	});

	it("uses plural for multiple events", () => {
		const events: FsEvent[] = [
			{
				watchId: "w1",
				path: "/a",
				eventType: "exists",
				summary: "appeared",
				formatted: "• appeared ✓",
			},
			{
				watchId: "w2",
				path: "/b",
				eventType: "removed",
				summary: "removed",
				formatted: "• removed ✓",
			},
		];
		const msg = buildChangeChatMessage(events, new Date("2024-01-01T10:30:00"));
		expect(msg).toMatch(/2 events/);
	});
});

// ---------------------------------------------------------------------------
// buildWatchSummaryHeader
// ---------------------------------------------------------------------------

describe("buildWatchSummaryHeader", () => {
	it("returns undefined when no watches", () => {
		expect(buildWatchSummaryHeader({})).toBeUndefined();
	});

	it("returns active summary when all active", () => {
		const watches: WatchMap = {
			w1: {
				watchId: "w1",
				path: "/p",
				target: "exists",
				mode: "poll",
				timeoutAt: undefined,
				addedAt: 0,
				lastPolledAt: undefined,
				baseline: undefined,
				terminal: false,
				consecutiveErrors: 0,
			},
		};
		const header = buildWatchSummaryHeader(watches)!;
		expect(header).toMatch(/active/);
		expect(header).toMatch(/1 path/);
	});
});

// ---------------------------------------------------------------------------
// buildStartupChatMessage
// ---------------------------------------------------------------------------

describe("buildStartupChatMessage", () => {
	it("reports no watches configured when empty", () => {
		const msg = buildStartupChatMessage({}, new Date());
		expect(msg).toMatch(/no watches/i);
	});

	it("lists watch paths with status", () => {
		const watches: WatchMap = {
			w1: {
				watchId: "w1",
				path: "/tmp/file.txt",
				target: "changed",
				mode: "poll",
				timeoutAt: undefined,
				addedAt: 0,
				lastPolledAt: undefined,
				baseline: { exists: true, mtimeNs: 1000n, size: 5 },
				terminal: false,
				consecutiveErrors: 0,
			},
		};
		const msg = buildStartupChatMessage(watches, new Date("2024-01-01T10:30:00"));
		expect(msg).toMatch(/\/tmp\/file\.txt/);
		expect(msg).toMatch(/changed/);
	});
});
