/**
 * Tests for src/socket-protocol.ts
 * Unix-socket framing: [UInt32 LE length][UTF-8 JSON]
 * Plus type guards for request/response shapes.
 */

import { describe, it, expect } from "vitest";

import {
	encode,
	Decoder,
	isSocketRequest,
	isSocketResponse,
} from "../src/socket-protocol.js";

// ---------------------------------------------------------------------------
// encode
// ---------------------------------------------------------------------------

describe("socket-protocol encode", () => {
	it("always uses little-endian for the length prefix", () => {
		const obj = { id: "r1", op: "listTabs" };
		const buf = encode(obj);
		const expectedBody = Buffer.from(JSON.stringify(obj), "utf-8");
		// Header must be LE regardless of machine endianness
		expect(buf.readUInt32LE(0)).toBe(expectedBody.length);
	});

	it("body is valid UTF-8 JSON", () => {
		const obj = { id: "r2", op: "status" };
		const buf = encode(obj);
		const body: unknown = JSON.parse(buf.subarray(4).toString("utf-8"));
		expect(body).toEqual(obj);
	});
});

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

describe("socket-protocol Decoder", () => {
	it("decodes a single complete frame", () => {
		const obj = { id: "r1", op: "ping" };
		const decoder = new Decoder();
		const results = [...decoder.push(encode(obj))];
		expect(results).toHaveLength(1);
		expect(results[0]).toEqual(obj);
	});

	it("handles two frames concatenated", () => {
		const a = { id: "r1", op: "listTabs" };
		const b = { id: "r2", op: "ping" };
		const buf = Buffer.concat([encode(a), encode(b)]);
		const decoder = new Decoder();
		const results = [...decoder.push(buf)];
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual(a);
		expect(results[1]).toEqual(b);
	});

	it("handles partial frames split across pushes", () => {
		const obj = { id: "r3", op: "getTabContent", params: { tabId: 5, offset: 0 } };
		const buf = encode(obj);
		const mid = Math.floor(buf.length / 2);
		const decoder = new Decoder();
		expect([...decoder.push(buf.subarray(0, mid))]).toHaveLength(0);
		expect([...decoder.push(buf.subarray(mid))]).toHaveLength(1);
	});

	it("always decodes with LE even if machine is BE (simulated by manual encoding)", () => {
		// Encode a tiny object manually with LE header
		const body = Buffer.from('{"id":"x"}', "utf-8");
		const hdr = Buffer.allocUnsafe(4);
		hdr.writeUInt32LE(body.length, 0);
		const buf = Buffer.concat([hdr, body]);
		const decoder = new Decoder();
		const results = [...decoder.push(buf)];
		expect(results).toHaveLength(1);
		expect((results[0] as { id: string }).id).toBe("x");
	});
});

// ---------------------------------------------------------------------------
// isSocketRequest
// ---------------------------------------------------------------------------

describe("isSocketRequest", () => {
	it("accepts a closeTab request", () => {
		expect(isSocketRequest({ id: "r1c", op: "closeTab" })).toBe(true);
	});

	it("accepts an exportTabs request", () => {
		expect(isSocketRequest({ id: "r1b", op: "exportTabs" })).toBe(true);
	});

	it("accepts a listTabs request", () => {
		expect(isSocketRequest({ id: "r1", op: "listTabs" })).toBe(true);
	});

	it("accepts a getTabContent request with params", () => {
		expect(
			isSocketRequest({
				id: "r2",
				op: "getTabContent",
				params: { tabId: 3, offset: 0 },
			}),
		).toBe(true);
	});

	it("accepts a status request", () => {
		expect(isSocketRequest({ id: "r3", op: "status" })).toBe(true);
	});

	it("accepts a ping request", () => {
		expect(isSocketRequest({ id: "r4", op: "ping" })).toBe(true);
	});

	it("rejects when id is missing", () => {
		expect(isSocketRequest({ op: "listTabs" })).toBe(false);
	});

	it("rejects when op is unknown", () => {
		expect(isSocketRequest({ id: "r5", op: "badOp" })).toBe(false);
	});

	it("rejects null", () => {
		expect(isSocketRequest(null)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// isSocketResponse
// ---------------------------------------------------------------------------

describe("isSocketResponse", () => {
	it("accepts a successful response", () => {
		expect(isSocketResponse({ id: "r1", ok: true, result: {} })).toBe(true);
	});

	it("accepts an error response", () => {
		expect(
			isSocketResponse({
				id: "r2",
				ok: false,
				error: { code: "DAEMON_NOT_RUNNING", message: "not running" },
			}),
		).toBe(true);
	});

	it("rejects when id is missing", () => {
		expect(isSocketResponse({ ok: true })).toBe(false);
	});

	it("rejects when ok is missing", () => {
		expect(isSocketResponse({ id: "r3" })).toBe(false);
	});

	it("rejects null", () => {
		expect(isSocketResponse(null)).toBe(false);
	});
});
