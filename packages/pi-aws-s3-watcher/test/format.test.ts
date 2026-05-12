import { describe, expect, it } from "vitest";

import {
	buildChangeChatMessage,
	buildStartupChatMessage,
	buildStatusLine,
} from "../src/format.js";
import type { S3Event, S3Watch, WatchMap } from "../src/types.js";

function makeWatch(overrides: Partial<S3Watch> = {}): S3Watch {
	return {
		watchId: "w1",
		bucket: "b",
		key: "k",
		profile: "p",
		region: undefined,
		target: "exists",
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
	it("idle when no watches", () => {
		expect(buildStatusLine({ watches: {}, paused: false, pollIntervalMs: 60_000 }))
			.toBe("aws-s3: idle");
	});

	it("shows watch count + poll interval when running", () => {
		const watches: WatchMap = { a: makeWatch({ watchId: "a" }), b: makeWatch({ watchId: "b" }) };
		expect(buildStatusLine({ watches, paused: false, pollIntervalMs: 60_000 }))
			.toBe("aws-s3: 2 watches | ⟳ 60s");
	});

	it("singular when exactly one watch", () => {
		const watches: WatchMap = { a: makeWatch() };
		expect(buildStatusLine({ watches, paused: false, pollIntervalMs: 60_000 }))
			.toBe("aws-s3: 1 watch | ⟳ 60s");
	});

	it("emits pause marker instead of interval when paused", () => {
		const watches: WatchMap = { a: makeWatch() };
		expect(buildStatusLine({ watches, paused: true, pollIntervalMs: 60_000 }))
			.toBe("aws-s3: 1 watch ⏸");
	});

	it("appends error flag when hasErrors is true", () => {
		const watches: WatchMap = { a: makeWatch() };
		expect(
			buildStatusLine({ watches, paused: false, pollIntervalMs: 60_000, hasErrors: true }),
		).toBe("aws-s3: 1 watch | ⚠ errors | ⟳ 60s");
	});

	it("excludes terminal watches from the count", () => {
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a", terminal: true }),
			b: makeWatch({ watchId: "b" }),
		};
		expect(buildStatusLine({ watches, paused: false, pollIntervalMs: 60_000 }))
			.toBe("aws-s3: 1 watch | ⟳ 60s");
	});
});

describe("buildChangeChatMessage", () => {
	it("plural header + bullet list", () => {
		const events: S3Event[] = [
			{
				watchId: "w1", bucket: "b", key: "k", eventType: "exists",
				summary: "s3://b/k now exists", formatted: "• s3://b/k now exists ✓",
			},
			{
				watchId: "w2", bucket: "b", key: "other", eventType: "timeout",
				summary: "timed out", formatted: "• s3://b/other timed out ✗",
			},
		];
		const out = buildChangeChatMessage(events, new Date(2024, 0, 1, 10, 30));
		expect(out).toContain("[10:30] 2 events detected");
		expect(out).toContain("• s3://b/k now exists ✓");
		expect(out).toContain("• s3://b/other timed out ✗");
	});

	it("singular header when exactly one event", () => {
		const events: S3Event[] = [{
			watchId: "w1", bucket: "b", key: "k", eventType: "exists",
			summary: "x", formatted: "• x",
		}];
		expect(buildChangeChatMessage(events, new Date(2024, 0, 1, 9, 5)))
			.toContain("[09:05] 1 event detected");
	});
});

describe("buildStartupChatMessage", () => {
	it("renders bullet list with target + state per watch", () => {
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a", target: "exists", baseline: { exists: false } }),
			b: makeWatch({
				watchId: "b",
				bucket: "o",
				key: "file",
				target: "updated",
				baseline: { exists: true, etag: '"x"' },
			}),
		};
		const msg = buildStartupChatMessage(watches, new Date(2024, 0, 1, 8, 0));
		expect(msg).toContain("watching 2 objects");
		expect(msg).toContain("(target: exists) — state=absent");
		expect(msg).toContain("(target: updated) — state=present");
	});

	it("handles the empty case gracefully", () => {
		expect(buildStartupChatMessage({}, new Date())).toContain("no watches configured");
	});
});
