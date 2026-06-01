/**
 * Tests for src/daemon/nm-framing.ts
 * Native-messaging framing: [UInt32 native-endian length][UTF-8 JSON]
 */

import { describe, it, expect } from "vitest";
import os from "node:os";

import { encode, Decoder } from "../src/daemon/nm-framing.js";

// ---------------------------------------------------------------------------
// encode
// ---------------------------------------------------------------------------

describe("nm-framing encode", () => {
	it("produces a 4-byte header followed by UTF-8 JSON body", () => {
		const obj = { hello: "world" };
		const buf = encode(obj);
		const expectedBody = Buffer.from(JSON.stringify(obj), "utf-8");
		expect(buf.length).toBe(4 + expectedBody.length);
		const body = buf.subarray(4);
		expect(JSON.parse(body.toString("utf-8"))).toEqual(obj);
	});

	it("uses native endianness for the length prefix", () => {
		const obj = { x: 1 };
		const buf = encode(obj);
		const bodyLen = Buffer.from(JSON.stringify(obj), "utf-8").length;
		if (os.endianness() === "LE") {
			expect(buf.readUInt32LE(0)).toBe(bodyLen);
		} else {
			expect(buf.readUInt32BE(0)).toBe(bodyLen);
		}
	});

	it("handles an empty object", () => {
		const buf = encode({});
		const body = buf.subarray(4).toString("utf-8");
		expect(JSON.parse(body)).toEqual({});
	});

	it("handles unicode in values", () => {
		const obj = { msg: "héllo wörld 🌍" };
		const buf = encode(obj);
		expect(JSON.parse(buf.subarray(4).toString("utf-8"))).toEqual(obj);
	});
});

// ---------------------------------------------------------------------------
// Decoder — single frame
// ---------------------------------------------------------------------------

describe("nm-framing Decoder — single frame", () => {
	it("decodes a single complete frame", () => {
		const obj = { correlationId: "c1", op: "listTabs" };
		const decoder = new Decoder();
		const results = [...decoder.push(encode(obj))];
		expect(results).toHaveLength(1);
		expect(results[0]).toEqual(obj);
	});

	it("returns nothing when buffer is empty", () => {
		const decoder = new Decoder();
		expect([...decoder.push(Buffer.alloc(0))]).toHaveLength(0);
	});

	it("returns nothing when only part of the header has arrived", () => {
		const buf = encode({ n: 42 });
		const decoder = new Decoder();
		expect([...decoder.push(buf.subarray(0, 3))]).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Decoder — multi-frame / partial
// ---------------------------------------------------------------------------

describe("nm-framing Decoder — concatenated and partial frames", () => {
	it("handles two frames arriving together", () => {
		const a = { n: 1 };
		const b = { n: 2 };
		const buf = Buffer.concat([encode(a), encode(b)]);
		const decoder = new Decoder();
		const results = [...decoder.push(buf)];
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual(a);
		expect(results[1]).toEqual(b);
	});

	it("handles a frame split across two pushes", () => {
		const obj = { data: "hello world this is a longer payload" };
		const buf = encode(obj);
		const mid = Math.floor(buf.length / 2);
		const decoder = new Decoder();
		const r1 = [...decoder.push(buf.subarray(0, mid))];
		const r2 = [...decoder.push(buf.subarray(mid))];
		expect(r1).toHaveLength(0);
		expect(r2).toHaveLength(1);
		expect(r2[0]).toEqual(obj);
	});

	it("handles header split across two pushes", () => {
		const obj = { ping: true };
		const buf = encode(obj);
		const decoder = new Decoder();
		// Only 2 bytes of the 4-byte header arrive first
		expect([...decoder.push(buf.subarray(0, 2))]).toHaveLength(0);
		expect([...decoder.push(buf.subarray(2))]).toHaveLength(1);
	});

	it("handles three frames mixed across multiple pushes", () => {
		const frames = [{ a: 1 }, { b: 2 }, { c: 3 }];
		const all = Buffer.concat(frames.map(encode));
		const decoder = new Decoder();
		// Push byte-by-byte
		const results: unknown[] = [];
		for (let i = 0; i < all.length; i++) {
			results.push(...decoder.push(all.subarray(i, i + 1)));
		}
		expect(results).toEqual(frames);
	});
});

// ---------------------------------------------------------------------------
// Decoder — oversized frame rejection
// ---------------------------------------------------------------------------

describe("nm-framing Decoder — oversized frame", () => {
	it("throws when declared frame length exceeds 64MB", () => {
		const header = Buffer.allocUnsafe(4);
		const bigLen = 65 * 1024 * 1024; // 65 MB
		if (os.endianness() === "LE") {
			header.writeUInt32LE(bigLen, 0);
		} else {
			header.writeUInt32BE(bigLen, 0);
		}
		const decoder = new Decoder();
		expect(() => [...decoder.push(header)]).toThrow(/too large/i);
	});

	it("does not throw for exactly 64MB declared length (body not yet arrived)", () => {
		const header = Buffer.allocUnsafe(4);
		const borderLen = 64 * 1024 * 1024; // exactly 64 MB — allowed, just not arrived yet
		if (os.endianness() === "LE") {
			header.writeUInt32LE(borderLen, 0);
		} else {
			header.writeUInt32BE(borderLen, 0);
		}
		const decoder = new Decoder();
		expect(() => [...decoder.push(header)]).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// BE endianness branch
// ---------------------------------------------------------------------------

describe("nm-framing — big-endian branch (encode + decode)", () => {
	it("encode writes UInt32BE and Decoder reads UInt32BE when endianness returns BE", async () => {
		const { vi } = await import("vitest");
		const spy = vi.spyOn(os, "endianness").mockReturnValue("BE");
		try {
			const obj = { id: "r-be", op: "ping" };
			// encode uses BE
			const buf = encode(obj);
			const expectedBody = Buffer.from(JSON.stringify(obj), "utf-8");
			expect(buf.readUInt32BE(0)).toBe(expectedBody.length);
			// Decoder also reads BE (line 50 branch)
			const decoder = new Decoder();
			const results = [...decoder.push(buf)];
			expect(results).toHaveLength(1);
			expect(results[0]).toEqual(obj);
		} finally {
			spy.mockRestore();
		}
	});
});
