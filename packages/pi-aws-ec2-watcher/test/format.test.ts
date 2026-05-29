import { describe, expect, it } from "vitest";

import {
	buildChangeChatMessage,
	buildStartupChatMessage,
	buildStatusLine,
} from "../src/format.js";
import type { Ec2Event, Ec2Watch, WatchMap } from "../src/types.js";

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

describe("buildStatusLine", () => {
	it("idle → muted when no watches", () => {
		expect(buildStatusLine({ watches: {}, paused: false, pollIntervalMs: 60_000 }))
			.toEqual({ text: "aws-ec2: idle", colorAlias: "muted" });
	});

	it("active → accent, count only", () => {
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a" }),
			b: makeWatch({ watchId: "b" }),
			c: makeWatch({ watchId: "c" }),
		};
		expect(buildStatusLine({ watches, paused: false, pollIntervalMs: 60_000 }))
			.toEqual({ text: "aws-ec2: 3", colorAlias: "accent" });
	});

	it("active + errors → warning with ⚠ errors segment", () => {
		const watches: WatchMap = { a: makeWatch() };
		expect(buildStatusLine({ watches, paused: false, pollIntervalMs: 60_000, hasErrors: true }))
			.toEqual({ text: "aws-ec2: 1 | ⚠ errors", colorAlias: "warning" });
	});

	it("paused → muted, (paused) suffix", () => {
		const watches: WatchMap = { a: makeWatch() };
		expect(buildStatusLine({ watches, paused: true, pollIntervalMs: 60_000 }))
			.toEqual({ text: "aws-ec2: 1 (paused)", colorAlias: "muted" });
	});

	it("paused + errors → warning (errors take colour priority over paused)", () => {
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a" }),
			b: makeWatch({ watchId: "b" }),
		};
		expect(buildStatusLine({ watches, paused: true, pollIntervalMs: 60_000, hasErrors: true }))
			.toEqual({ text: "aws-ec2: 2 | ⚠ errors (paused)", colorAlias: "warning" });
	});

	it("excludes terminal watches from the count", () => {
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a", terminal: true }),
			b: makeWatch({ watchId: "b" }),
		};
		expect(buildStatusLine({ watches, paused: false, pollIntervalMs: 60_000 }))
			.toEqual({ text: "aws-ec2: 1", colorAlias: "accent" });
	});

	it("idle (all terminal) → muted", () => {
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a", terminal: true }),
		};
		expect(buildStatusLine({ watches, paused: false, pollIntervalMs: 60_000 }))
			.toEqual({ text: "aws-ec2: idle", colorAlias: "muted" });
	});
});

describe("buildChangeChatMessage", () => {
	it("plural header + bullet list", () => {
		const events: Ec2Event[] = [
			{
				watchId: "w1",
				instanceId: "i-1234abcd",
				eventType: "state_changed",
				previousState: "pending",
				newState: "running",
				summary: "EC2 i-1234abcd: pending → running",
				formatted: "• EC2 i-1234abcd: pending → running",
				isTerminal: false,
			},
			{
				watchId: "w2",
				instanceId: "i-abcd1234",
				eventType: "timeout",
				previousState: "running",
				newState: "",
				summary: "EC2 instance i-abcd1234 timed out",
				formatted: "• EC2 instance i-abcd1234 timed out ✗",
				isTerminal: true,
			},
		];
		const out = buildChangeChatMessage(events, new Date(2024, 0, 1, 10, 30));
		expect(out).toContain("[10:30] 2 events detected");
		expect(out).toContain("• EC2 i-1234abcd: pending → running");
		expect(out).toContain("• EC2 instance i-abcd1234 timed out ✗");
	});

	it("singular header when exactly one event", () => {
		const events: Ec2Event[] = [
			{
				watchId: "w1",
				instanceId: "i-1234abcd",
				eventType: "state_changed",
				previousState: "running",
				newState: "terminated",
				summary: "EC2 i-1234abcd: running → terminated",
				formatted: "• EC2 i-1234abcd: running → terminated ✓",
				isTerminal: true,
			},
		];
		expect(buildChangeChatMessage(events, new Date(2024, 0, 1, 9, 5)))
			.toContain("[09:05] 1 event detected");
	});
});

describe("buildStartupChatMessage", () => {
	it("renders bullet list with instanceId + state per watch", () => {
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a", baseline: { state: "running" } }),
			b: makeWatch({
				watchId: "b",
				instanceId: "i-abcd1234",
				baseline: { state: "stopped" },
			}),
		};
		const msg = buildStartupChatMessage(watches, new Date(2024, 0, 1, 8, 0));
		expect(msg).toContain("watching 2 instances");
		expect(msg).toContain("state=running");
		expect(msg).toContain("state=stopped");
	});

	it("handles the empty case gracefully", () => {
		expect(buildStartupChatMessage({}, new Date())).toContain("no watches configured");
	});

	it("all-active → `active — watching N instances` wording", () => {
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a" }),
			b: makeWatch({ watchId: "b" }),
		};
		const msg = buildStartupChatMessage(watches, new Date(2024, 0, 1, 8, 0));
		expect(msg).toContain("active — watching 2 instances");
		expect(msg).not.toContain("done");
	});

	it("mixed → `watching N instances · K active, M done`", () => {
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a", terminal: true }),
			b: makeWatch({ watchId: "b" }),
			c: makeWatch({ watchId: "c" }),
		};
		const msg = buildStartupChatMessage(watches, new Date(2024, 0, 1, 8, 0));
		expect(msg).toContain("watching 3 instances · 2 active, 1 done");
	});

	it("all-terminal → `watching N instances (N done)`", () => {
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a", terminal: true }),
			b: makeWatch({ watchId: "b", terminal: true }),
		};
		const msg = buildStartupChatMessage(watches, new Date(2024, 0, 1, 8, 0));
		expect(msg).toContain("watching 2 instances (2 done)");
	});
});
