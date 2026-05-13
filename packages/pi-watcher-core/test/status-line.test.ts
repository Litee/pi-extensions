import { describe, expect, it } from "vitest";
import { buildStatusLine, formatWatchList, statusLineColorAlias } from "../src/status-line.js";

describe("buildStatusLine", () => {
	it("returns empty string for count 0", () => {
		expect(buildStatusLine({ label: "test-watcher", mode: "active", count: 0 })).toBe("");
		expect(buildStatusLine({ label: "test-watcher", mode: "paused", count: 0 })).toBe("");
	});

	it("active with no modifier", () => {
		expect(
			buildStatusLine({ label: "test-watcher", mode: "active", count: 3 }),
		).toBe("test-watcher: active (3)");
	});

	it("paused", () => {
		expect(
			buildStatusLine({ label: "test-watcher", mode: "paused", count: 3 }),
		).toBe("test-watcher: paused (3)");
	});

	it("active throttled", () => {
		expect(
			buildStatusLine({ label: "test-watcher", mode: "active", count: 3, modifier: "throttled" }),
		).toBe("test-watcher: active (throttled) (3)");
	});

	it("active auth-error", () => {
		expect(
			buildStatusLine({ label: "test-watcher", mode: "active", count: 3, modifier: "auth-error" }),
		).toBe("test-watcher: active (auth error) (3)");
	});

	it("modifier defaults to none when absent", () => {
		expect(
			buildStatusLine({ label: "x", mode: "active", count: 1 }),
		).toBe("x: active (1)");
	});

	it("modifier none is the same as absent", () => {
		expect(
			buildStatusLine({ label: "x", mode: "active", count: 1, modifier: "none" }),
		).toBe("x: active (1)");
	});

	it("paused ignores modifier", () => {
		// Paused always shows "paused (N)" regardless of modifier.
		expect(
			buildStatusLine({ label: "x", mode: "paused", count: 2, modifier: "throttled" }),
		).toBe("x: paused (2)");
	});
});

describe("statusLineColorAlias", () => {
	it("active + none → accent", () => expect(statusLineColorAlias("active", "none")).toBe("accent"));
	it("active + throttled → warning", () => expect(statusLineColorAlias("active", "throttled")).toBe("warning"));
	it("active + auth-error → warning", () => expect(statusLineColorAlias("active", "auth-error")).toBe("warning"));
	it("paused + none → muted", () => expect(statusLineColorAlias("paused", "none")).toBe("muted"));
	it("paused + throttled → muted (paused wins)", () => expect(statusLineColorAlias("paused", "throttled")).toBe("muted"));
	it("modifier defaults to none", () => {
		expect(statusLineColorAlias("active")).toBe("accent");
		expect(statusLineColorAlias("paused")).toBe("muted");
	});
});

describe("formatWatchList", () => {
	it("empty list returns empty string", () => {
		expect(formatWatchList([])).toBe("");
	});

	it("items within maxShow — no suffix", () => {
		expect(formatWatchList(["A"])).toBe("A");
		expect(formatWatchList(["A", "B"])).toBe("A, B");
	});

	it("items exceeding maxShow — appends (+N more)", () => {
		expect(formatWatchList(["A", "B", "C"])).toBe("A, B (+1 more)");
		expect(formatWatchList(["A", "B", "C", "D"])).toBe("A, B (+2 more)");
	});

	it("custom maxShow is respected", () => {
		expect(formatWatchList(["A", "B", "C"], 3)).toBe("A, B, C");
		expect(formatWatchList(["A", "B", "C", "D"], 3)).toBe("A, B, C (+1 more)");
	});
});
