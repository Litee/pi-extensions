/**
 * Branch-coverage gap-fill for src/format.ts.
 *
 * Covers the three branches that the existing format.test.ts misses:
 *
 *  • buildWatchSummaryHeader: all.length === 0  → returns undefined
 *  • buildWatchSummaryHeader: total === 1        → singular "object"
 *  • buildStartupChatMessage: baseline undefined → state = "?"
 */

import { describe, expect, it } from "vitest";

import {
	buildStartupChatMessage,
	buildStatusLine,
	buildWatchSummaryHeader,
} from "../src/format.js";
import type { S3Watch, WatchMap } from "../src/types.js";

function makeWatch(overrides: Partial<S3Watch> = {}): S3Watch {
	return {
		watchId: "w1",
		bucket: "b",
		key: "k",
		profile: "p",
		region: undefined,
		target: "creation",
		timeoutAt: undefined,
		addedAt: 0,
		lastPolledAt: undefined,
		baseline: undefined,
		terminal: false,
		consecutiveErrors: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// buildWatchSummaryHeader
// ---------------------------------------------------------------------------

describe("buildWatchSummaryHeader — uncovered branches", () => {
	it("returns undefined for an empty WatchMap (all.length === 0 guard)", () => {
		// This branch is unreachable through buildStartupChatMessage (it returns
		// early before calling buildWatchSummaryHeader), so we test it directly.
		expect(buildWatchSummaryHeader({})).toBeUndefined();
	});

	it("uses singular 'object' when there is exactly one active watch", () => {
		// total === 1 ? "object" : "objects"  → "object"
		const watches: WatchMap = { a: makeWatch({ watchId: "a" }) };
		expect(buildWatchSummaryHeader(watches)).toBe("active — watching 1 object");
	});

	it("uses singular 'object' when there is exactly one terminal watch", () => {
		// total === 1, done === 1, active === 0 → all-done branch with singular noun
		const watches: WatchMap = { a: makeWatch({ watchId: "a", terminal: true }) };
		expect(buildWatchSummaryHeader(watches)).toBe("watching 1 object (1 done)");
	});

	it("uses singular 'object' in the mixed branch (1 active, 0 done — sanity)", () => {
		// mixed: 2 total but only 1 active, 1 done — plural "objects"
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a" }),
			b: makeWatch({ watchId: "b", terminal: true }),
		};
		const result = buildWatchSummaryHeader(watches);
		expect(result).toBe("watching 2 objects · 1 active, 1 done");
	});
});

// ---------------------------------------------------------------------------
// buildStartupChatMessage — baseline undefined → state "?"
// ---------------------------------------------------------------------------

describe("buildStartupChatMessage — baseline undefined state", () => {
	it("shows state=? when a watch has no baseline yet", () => {
		// w.baseline === undefined ? "?" : ...  → "?" branch
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a", baseline: undefined }),
		};
		const msg = buildStartupChatMessage(watches, new Date(2024, 0, 1, 8, 0));
		expect(msg).toContain("state=?");
	});

	it("shows state=? alongside [terminal] tag when terminal watch has no baseline", () => {
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a", baseline: undefined, terminal: true }),
		};
		const msg = buildStartupChatMessage(watches, new Date(2024, 0, 1, 8, 0));
		expect(msg).toContain("state=?");
		expect(msg).toContain("[terminal]");
	});
});

// ---------------------------------------------------------------------------
// buildStatusLine — all-terminal → idle (active count falls to 0)
// ---------------------------------------------------------------------------

describe("buildStatusLine — all terminal watches collapse to idle", () => {
	it("returns idle/muted when every watch is terminal (active count = 0)", () => {
		// active.length === 0 → { text: "aws-s3: idle", colorAlias: "muted" }
		// (different trigger than the 'no watches' case already tested)
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a", terminal: true }),
			b: makeWatch({ watchId: "b", terminal: true }),
		};
		expect(buildStatusLine({ watches, pollIntervalMs: 60_000 })).toEqual({
			text: "aws-s3: idle",
			colorAlias: "muted",
		});
	});
});
