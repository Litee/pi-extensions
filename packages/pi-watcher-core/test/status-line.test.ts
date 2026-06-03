import { describe, expect, it } from "vitest";
import { buildStatusLine, formatWatchList, statusLineColorAlias } from "../src/status-line.js";

describe("buildStatusLine", () => {
	it("returns empty string for count 0", () => {
		expect(buildStatusLine({ label: "tickets", mode: "active", count: 0 })).toBe("");
	});

	it("active with no modifier", () => {
		expect(
			buildStatusLine({ label: "tickets", mode: "active", count: 3 }),
		).toBe("tickets: 3");
	});

	it("active throttled", () => {
		expect(
			buildStatusLine({ label: "tickets", mode: "active", count: 3, modifier: "throttled" }),
		).toBe("tickets: 3 (throttled)");
	});

	it("active auth-error", () => {
		expect(
			buildStatusLine({ label: "tickets", mode: "active", count: 3, modifier: "auth-error" }),
		).toBe("tickets: 3 (auth error)");
	});

	it("modifier defaults to none when absent", () => {
		expect(
			buildStatusLine({ label: "x", mode: "active", count: 1 }),
		).toBe("x: 1");
	});

	it("modifier none is the same as absent", () => {
		expect(
			buildStatusLine({ label: "x", mode: "active", count: 1, modifier: "none" }),
		).toBe("x: 1");
	});
});

describe("statusLineColorAlias", () => {
	it("none → accent", () => expect(statusLineColorAlias("none")).toBe("accent"));
	it("throttled → warning", () => expect(statusLineColorAlias("throttled")).toBe("warning"));
	it("auth-error → warning", () => expect(statusLineColorAlias("auth-error")).toBe("warning"));
	it("modifier defaults to none", () => {
		expect(statusLineColorAlias()).toBe("accent");
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
