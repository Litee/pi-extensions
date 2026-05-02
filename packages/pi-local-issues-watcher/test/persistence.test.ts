import { describe, expect, it, vi } from "vitest";

import {
	STATE_ENTRY_TYPE,
	STATE_MAX_AGE_MS,
	rehydrateFromSession,
} from "../src/persistence.js";
import type { Snapshot } from "../src/types.js";

function entry(type: string, data?: unknown, customType?: string) {
	return customType === undefined ? { type, data } : { type, customType, data };
}

function makeCtx(entries: Array<{ type: string; customType?: string; data?: unknown }>) {
	return {
		sessionManager: {
			getEntries: () => entries,
		},
	};
}

const FRESH_SNAPSHOT: Snapshot = {
	"/db/skill-a/0001-x.json": {
		mtimeNs: 1n,
		issueId: "0001",
		status: "open",
		title: "t",
		description: "d",
		comments: [],
		skill: "skill-a",
		skillVersion: "1.0.0",
	},
};

function now(): number {
	return Date.now();
}

describe("rehydrateFromSession", () => {
	it("returns null when there are no entries at all", () => {
		expect(rehydrateFromSession(makeCtx([]) as never)).toBeNull();
	});

	it("returns null when no entries match the expected customType", () => {
		const ctx = makeCtx([
			entry("custom", { savedAt: now(), snapshot: FRESH_SNAPSHOT }, "some-other-type"),
			entry("message", "hello"),
		]);
		expect(rehydrateFromSession(ctx as never)).toBeNull();
	});

	it("returns the most recent matching entry (walks newest to oldest)", () => {
		const older: Snapshot = {
			"/db/old/0001-a.json": { ...FRESH_SNAPSHOT["/db/skill-a/0001-x.json"]! },
		};
		const newer: Snapshot = {
			"/db/new/0002-b.json": { ...FRESH_SNAPSHOT["/db/skill-a/0001-x.json"]! },
		};
		const ctx = makeCtx([
			entry("custom", { savedAt: now(), snapshot: older }, STATE_ENTRY_TYPE),
			entry("message", "noise"),
			entry("custom", { savedAt: now(), snapshot: newer }, STATE_ENTRY_TYPE),
		]);
		const got = rehydrateFromSession(ctx as never);
		expect(got).not.toBeNull();
		expect(Object.keys(got!.snapshot)).toEqual(["/db/new/0002-b.json"]);
	});

	it("returns null when the most recent matching entry is older than STATE_MAX_AGE_MS", () => {
		const stale = now() - STATE_MAX_AGE_MS - 1000;
		const ctx = makeCtx([
			entry("custom", { savedAt: stale, snapshot: FRESH_SNAPSHOT }, STATE_ENTRY_TYPE),
		]);
		expect(rehydrateFromSession(ctx as never)).toBeNull();
	});

	it("returns null when the entry data is malformed (missing snapshot / savedAt)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ctx = makeCtx([
			entry("custom", { savedAt: now() /* no snapshot */ }, STATE_ENTRY_TYPE),
		]);
		expect(rehydrateFromSession(ctx as never)).toBeNull();
		warn.mockRestore();
	});

	it("deserialises mtimeNs back into bigint when reading from a persisted snapshot", () => {
		// Custom entries stored via `pi.appendEntry` typically round-trip through
		// JSON, which means bigint fields come back as strings. The rehydrator
		// must convert them back so downstream diff logic keeps working.
		const serialised = {
			"/db/skill-a/0001-x.json": {
				...FRESH_SNAPSHOT["/db/skill-a/0001-x.json"]!,
				mtimeNs: "12345",
			},
		};
		const ctx = makeCtx([
			entry("custom", { savedAt: now(), snapshot: serialised }, STATE_ENTRY_TYPE),
		]);
		const got = rehydrateFromSession(ctx as never);
		expect(got).not.toBeNull();
		expect(got!.snapshot["/db/skill-a/0001-x.json"]!.mtimeNs).toBe(12345n);
	});

	it("accepts numeric mtimeNs and falls back to 0n for garbage values", () => {
		const ctx = makeCtx([
			entry("custom", {
				savedAt: now(),
				snapshot: {
					"/a": { ...FRESH_SNAPSHOT["/db/skill-a/0001-x.json"]!, mtimeNs: 42 },
					"/b": { ...FRESH_SNAPSHOT["/db/skill-a/0001-x.json"]!, mtimeNs: "not-a-number" },
					"/c": { ...FRESH_SNAPSHOT["/db/skill-a/0001-x.json"]!, mtimeNs: undefined },
					"/d": null, // should be skipped entirely
				},
			}, STATE_ENTRY_TYPE),
		]);
		const got = rehydrateFromSession(ctx as never);
		expect(got).not.toBeNull();
		expect(got!.snapshot["/a"]!.mtimeNs).toBe(42n);
		expect(got!.snapshot["/b"]!.mtimeNs).toBe(0n);
		expect(got!.snapshot["/c"]!.mtimeNs).toBe(0n);
		expect(got!.snapshot["/d"]).toBeUndefined();
	});

	it("returns null when the persisted data field is completely missing", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ctx = makeCtx([entry("custom", undefined, STATE_ENTRY_TYPE)]);
		expect(rehydrateFromSession(ctx as never)).toBeNull();
		warn.mockRestore();
	});
});
