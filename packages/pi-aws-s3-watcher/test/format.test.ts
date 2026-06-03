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

describe("buildStatusLine", () => {
	it("idle → muted when no watches", () => {
		expect(buildStatusLine({ watches: {}, pollIntervalMs: 60_000 }))
			.toEqual({ text: "aws-s3: idle", colorAlias: "muted" });
	});

	it("active → accent, count only, no noun, no poll interval", () => {
		const watches: WatchMap = { a: makeWatch({ watchId: "a" }), b: makeWatch({ watchId: "b" }), c: makeWatch({ watchId: "c" }) };
		expect(buildStatusLine({ watches, pollIntervalMs: 60_000 }))
			.toEqual({ text: "aws-s3: 3", colorAlias: "accent" });
	});

	it("active + errors → warning with ⚠ errors segment", () => {
		const watches: WatchMap = { a: makeWatch() };
		expect(
			buildStatusLine({ watches, pollIntervalMs: 60_000, hasErrors: true }),
		).toEqual({ text: "aws-s3: 1 | ⚠ errors", colorAlias: "warning" });
	});



	it("excludes terminal watches from the count", () => {
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a", terminal: true }),
			b: makeWatch({ watchId: "b" }),
		};
		expect(buildStatusLine({ watches, pollIntervalMs: 60_000 }))
			.toEqual({ text: "aws-s3: 1", colorAlias: "accent" });
	});
});

describe("buildChangeChatMessage", () => {
	it("plural header + bullet list", () => {
		const events: S3Event[] = [
			{
				watchId: "w1", bucket: "b", key: "k", eventType: "creation",
				isTerminal: true as const,
				summary: "s3://b/k now exists", formatted: "• s3://b/k now exists ✓",
			},
			{
				watchId: "w2", bucket: "b", key: "other", eventType: "timeout",
				isTerminal: true as const,
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
			watchId: "w1", bucket: "b", key: "k", eventType: "creation",
			isTerminal: true as const,
			summary: "x", formatted: "• x",
		}];
		expect(buildChangeChatMessage(events, new Date(2024, 0, 1, 9, 5)))
			.toContain("[09:05] 1 event detected");
	});
});

describe("buildStartupChatMessage", () => {
	it("renders bullet list with target + state per watch", () => {
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a", target: "creation", baseline: { exists: false } }),
			b: makeWatch({
				watchId: "b",
				bucket: "o",
				key: "file",
				target: "modification",
				baseline: { exists: true, etag: '"x"' },
			}),
		};
		const msg = buildStartupChatMessage(watches, new Date(2024, 0, 1, 8, 0));
		expect(msg).toContain("watching 2 objects");
		expect(msg).toContain("(target: creation) — state=absent");
		expect(msg).toContain("(target: modification) — state=present");
	});

	it("handles the empty case gracefully", () => {
		expect(buildStartupChatMessage({}, new Date())).toContain("no watches configured");
	});

	it("all-active → keeps `active — watching N objects` wording", () => {
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a" }),
			b: makeWatch({ watchId: "b" }),
		};
		const msg = buildStartupChatMessage(watches, new Date(2024, 0, 1, 8, 0));
		expect(msg).toContain("active — watching 2 objects");
		expect(msg).not.toContain("done");
	});

	it("mixed → `watching N objects · K active, M done`, no `active —` prefix", () => {
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a", terminal: true }),
			b: makeWatch({ watchId: "b" }),
			c: makeWatch({ watchId: "c" }),
		};
		const msg = buildStartupChatMessage(watches, new Date(2024, 0, 1, 8, 0));
		expect(msg).toContain("watching 3 objects · 2 active, 1 done");
		expect(msg).not.toContain("active — watching");
	});

	it("all-terminal → `watching N objects (N done)`, no `active —` prefix", () => {
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a", terminal: true }),
			b: makeWatch({ watchId: "b", terminal: true }),
		};
		const msg = buildStartupChatMessage(watches, new Date(2024, 0, 1, 8, 0));
		expect(msg).toContain("watching 2 objects (2 done)");
		expect(msg).not.toContain("active — watching");
	});
});
