/**
 * Tests for src/daemon/nm-protocol.ts
 * Type guards for native-messaging host↔addon protocol shapes.
 */

import { describe, it, expect } from "vitest";

import {
	isHostRequest,
	isAddonReply,
} from "../src/daemon/nm-protocol.js";

describe("isHostRequest", () => {
	it("accepts a listTabs request", () => {
		expect(isHostRequest({ correlationId: "c1", op: "listTabs" })).toBe(true);
	});

	it("accepts a getTabContent request", () => {
		expect(
			isHostRequest({
				correlationId: "c2",
				op: "getTabContent",
				params: { tabId: 5, offset: 0 },
			}),
		).toBe(true);
	});

	it("accepts a ping request", () => {
		expect(isHostRequest({ correlationId: "c3", op: "ping" })).toBe(true);
	});

	it("rejects when correlationId is missing", () => {
		expect(isHostRequest({ op: "listTabs" })).toBe(false);
	});

	it("rejects when op is unknown", () => {
		expect(isHostRequest({ correlationId: "c4", op: "unknown" })).toBe(false);
	});

	it("rejects null", () => {
		expect(isHostRequest(null)).toBe(false);
	});

	it("rejects a non-object", () => {
		expect(isHostRequest("string")).toBe(false);
	});

	it("rejects when correlationId is not a string", () => {
		expect(isHostRequest({ correlationId: 42, op: "ping" })).toBe(false);
	});
});

describe("isAddonReply", () => {
	it("accepts a successful reply", () => {
		expect(
			isAddonReply({
				correlationId: "c1",
				ok: true,
				result: { tabs: [] },
			}),
		).toBe(true);
	});

	it("accepts an error reply", () => {
		expect(
			isAddonReply({
				correlationId: "c2",
				ok: false,
				error: { code: "TAB_NOT_FOUND", message: "No such tab" },
			}),
		).toBe(true);
	});

	it("rejects when correlationId is missing", () => {
		expect(isAddonReply({ ok: true })).toBe(false);
	});

	it("rejects when ok is missing", () => {
		expect(isAddonReply({ correlationId: "c3" })).toBe(false);
	});

	it("rejects null", () => {
		expect(isAddonReply(null)).toBe(false);
	});

	it("rejects when ok is not boolean", () => {
		expect(isAddonReply({ correlationId: "c4", ok: "yes" })).toBe(false);
	});
});
