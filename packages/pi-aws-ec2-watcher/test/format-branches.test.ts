/**
 * Branch-coverage gap-fill for format.ts.
 *
 * Covers the branches not exercised by format.test.ts:
 *   - L66:  buildWatchSummaryHeader({}) → early return undefined
 *   - L70:  total === 1 → singular "instance" noun
 *   - L87:  w.baseline?.nameTag truthy → " (nameTag)" in line text
 */

import { describe, expect, it } from "vitest";

import {
	buildStartupChatMessage,
	buildWatchSummaryHeader,
} from "../src/format.js";
import type { Ec2Watch, WatchMap } from "../src/types.js";

function makeWatch(overrides: Partial<Ec2Watch> = {}): Ec2Watch {
	return {
		watchId: "w1",
		instanceId: "i-1234abcd",
		profile: "p",
		region: undefined,
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
// buildWatchSummaryHeader — empty map (format.ts L66 true branch)
// ---------------------------------------------------------------------------

describe("buildWatchSummaryHeader — empty map", () => {
	it("returns undefined for an empty WatchMap (L66 early-return branch)", () => {
		// buildStartupChatMessage short-circuits before calling this with an empty
		// map, so the only way to exercise the branch is a direct call.
		expect(buildWatchSummaryHeader({})).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// buildWatchSummaryHeader — singular noun (format.ts L70 "instance" branch)
// ---------------------------------------------------------------------------

describe("buildWatchSummaryHeader — singular noun", () => {
	it('uses "instance" (singular) when exactly one watch is active (L70 true branch)', () => {
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a" }),
		};
		const header = buildWatchSummaryHeader(watches);
		// active — watching 1 instance  (not "instances")
		expect(header).toBe("active — watching 1 instance");
		expect(header).not.toContain("instances");
	});

	it('uses "instances" (plural) when more than one watch exists', () => {
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a" }),
			b: makeWatch({ watchId: "b" }),
		};
		const header = buildWatchSummaryHeader(watches);
		expect(header).toContain("instances");
	});
});

// ---------------------------------------------------------------------------
// buildStartupChatMessage — nameTag branch (format.ts L87 truthy branch)
// ---------------------------------------------------------------------------

describe("buildStartupChatMessage — watch with nameTag", () => {
	it("includes the nameTag in parentheses on the bullet line (L87 truthy branch)", () => {
		const watches: WatchMap = {
			a: makeWatch({
				watchId: "a",
				instanceId: "i-0a1b2c3d",
				baseline: { state: "running", nameTag: "prod-web" },
			}),
		};
		const msg = buildStartupChatMessage(watches, new Date(2024, 0, 1, 9, 0));

		// The bullet line should include the nameTag.
		expect(msg).toContain("i-0a1b2c3d (prod-web)");
		// And use the singular "instance" header (only 1 watch).
		expect(msg).toContain("watching 1 instance");
	});

	it("does not include parenthesised name when nameTag is absent (L87 falsy branch)", () => {
		const watches: WatchMap = {
			a: makeWatch({
				watchId: "a",
				baseline: { state: "running" },
			}),
		};
		const msg = buildStartupChatMessage(watches, new Date(2024, 0, 1, 9, 0));
		expect(msg).not.toMatch(/\(/);
	});
});
