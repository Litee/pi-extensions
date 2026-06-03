import { describe, expect, it, vi } from "vitest";

import {
	STATE_ENTRY_TYPE,
	STATE_MAX_AGE_MS,
	ENABLED_ENTRY_TYPE,
	rehydrateFromSession,
	rehydrateEnabledFromSession,
	persistSnapshot,
	persistEnabled,
} from "../src/persistence.js";
import type { Snapshot } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entry(customType: string, data?: unknown) {
	return { type: "custom", customType, data };
}

function makeCtx(entries: Array<{ type?: string; customType?: string; data?: unknown }>) {
	return {
		sessionManager: {
			getEntries: () => entries,
		},
	};
}

function now(): number {
	return Date.now();
}

/** Build a valid snapshot entry data payload. Items are Object.entries(serialisedSnapshot). */
function snapshotEntryData(
	items: Array<[string, unknown]> = [],
	savedAt = now(),
) {
	return {
		savedAt,
		snapshot: items,
		baselines: {},
	};
}

const SAMPLE_ISSUE_SERIALISED = {
	mtimeNs: "12345",
	issueId: "0001",
	status: "open",
	title: "Test issue",
	description: "desc",
	comments: [],
	skill: "skill-a",
	skillVersion: "1.0.0",
};

const SAMPLE_SNAPSHOT: Snapshot = {
	"/db/skill-a/0001-x.json": {
		mtimeNs: 12345n,
		issueId: "0001",
		status: "open",
		title: "Test issue",
		description: "desc",
		comments: [],
		skill: "skill-a",
		skillVersion: "1.0.0",
	},
};

// ---------------------------------------------------------------------------
// rehydrateFromSession
// ---------------------------------------------------------------------------

describe("rehydrateFromSession", () => {
	it("returns null when no entries", () => {
		expect(rehydrateFromSession(makeCtx([]))).toBeNull();
	});

	it("returns null when no matching entry (customType must be STATE_ENTRY_TYPE)", () => {
		const ctx = makeCtx([
			entry("some-other-type", snapshotEntryData()),
		]);
		expect(rehydrateFromSession(ctx)).toBeNull();
	});

	it("returns the newest matching entry (newest-to-oldest walk)", () => {
		const older = entry(STATE_ENTRY_TYPE, snapshotEntryData(
			[["/db/old/0001.json", { ...SAMPLE_ISSUE_SERIALISED, issueId: "old" }]],
			now() - 1000,
		));
		const newer = entry(STATE_ENTRY_TYPE, snapshotEntryData(
			[["/db/new/0002.json", { ...SAMPLE_ISSUE_SERIALISED, issueId: "new" }]],
			now(),
		));
		const ctx = makeCtx([older, newer]);
		const got = rehydrateFromSession(ctx);
		expect(got).not.toBeNull();
		expect(Object.keys(got!.snapshot)).toEqual(["/db/new/0002.json"]);
	});

	it("returns null when the entry is older than STATE_MAX_AGE_MS", () => {
		const stale = now() - STATE_MAX_AGE_MS - 1000;
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, snapshotEntryData([], stale)),
		]);
		expect(rehydrateFromSession(ctx)).toBeNull();
	});

	it("returns a valid entry when within TTL", () => {
		const fresh = now() - 1000;
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, snapshotEntryData(
				[["/db/skill-a/0001-x.json", SAMPLE_ISSUE_SERIALISED]],
				fresh,
			)),
		]);
		const got = rehydrateFromSession(ctx);
		expect(got).not.toBeNull();
		expect(Object.keys(got!.snapshot)).toEqual(["/db/skill-a/0001-x.json"]);
	});

	it("skips malformed entries (no data) and falls back to next valid one", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, snapshotEntryData([["/db/old.json", SAMPLE_ISSUE_SERIALISED]], now() - 1000)),
			entry(STATE_ENTRY_TYPE, undefined), // newer, no data
		]);
		const got = rehydrateFromSession(ctx);
		expect(got).not.toBeNull();
		expect(Object.keys(got!.snapshot)).toEqual(["/db/old.json"]);
	});

	it("skips malformed entries (bad savedAt) and falls back to next valid one", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, snapshotEntryData([["/db/old.json", SAMPLE_ISSUE_SERIALISED]], now() - 1000)),
			entry(STATE_ENTRY_TYPE, { ...snapshotEntryData(), savedAt: "bad" }), // newer, bad savedAt
		]);
		const got = rehydrateFromSession(ctx);
		expect(got).not.toBeNull();
		expect(Object.keys(got!.snapshot)).toEqual(["/db/old.json"]);
	});

	it("skips malformed entries (non-array snapshot) and falls back to next valid one", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, snapshotEntryData([["/db/old.json", SAMPLE_ISSUE_SERIALISED]], now() - 1000)),
			entry(STATE_ENTRY_TYPE, { ...snapshotEntryData(), snapshot: { not: "array" } }), // newer, bad shape
		]);
		const got = rehydrateFromSession(ctx);
		expect(got).not.toBeNull();
		expect(Object.keys(got!.snapshot)).toEqual(["/db/old.json"]);
	});

	it("deserialises mtimeNs back to bigint (from string '12345' → 12345n)", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, snapshotEntryData(
				[["/db/skill-a/0001-x.json", { ...SAMPLE_ISSUE_SERIALISED, mtimeNs: "12345" }]],
			)),
		]);
		const got = rehydrateFromSession(ctx);
		expect(got).not.toBeNull();
		expect(got!.snapshot["/db/skill-a/0001-x.json"]!.mtimeNs).toBe(12345n);
	});

	it("handles numeric mtimeNs (converts to bigint)", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, snapshotEntryData(
				[["/db/a.json", { ...SAMPLE_ISSUE_SERIALISED, mtimeNs: "42" }]],
			)),
		]);
		const got = rehydrateFromSession(ctx);
		expect(got!.snapshot["/db/a.json"]!.mtimeNs).toBe(42n);
	});

	it("falls back to 0n for invalid mtimeNs values", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, snapshotEntryData(
				[
					["/db/a.json", { ...SAMPLE_ISSUE_SERIALISED, mtimeNs: "not-a-number" }],
					["/db/b.json", { ...SAMPLE_ISSUE_SERIALISED, mtimeNs: "0" }],
				],
			)),
		]);
		const got = rehydrateFromSession(ctx);
		expect(got!.snapshot["/db/a.json"]!.mtimeNs).toBe(0n);
		expect(got!.snapshot["/db/b.json"]!.mtimeNs).toBe(0n);
	});

	it("skips null/invalid snapshot entries in the array", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, snapshotEntryData(
				[
					null as unknown as [string, unknown], // should be skipped
					["/db/valid.json", SAMPLE_ISSUE_SERIALISED],
					"bad-entry" as unknown as [string, unknown], // should be skipped
				],
			)),
		]);
		const got = rehydrateFromSession(ctx);
		expect(got).not.toBeNull();
		expect(Object.keys(got!.snapshot)).toEqual(["/db/valid.json"]);
	});
});

// persistSnapshot
// ---------------------------------------------------------------------------

describe("persistSnapshot", () => {
	it("calls appendEntry with STATE_ENTRY_TYPE", () => {
		const appendEntry = vi.fn();
		persistSnapshot({ appendEntry }, SAMPLE_SNAPSHOT);
		expect(appendEntry).toHaveBeenCalledOnce();
		const [ct, data] = appendEntry.mock.calls[0] as [string, Record<string, unknown>];
		expect(ct).toBe(STATE_ENTRY_TYPE);
		expect(typeof (data["savedAt"])).toBe("number");
	});

	it("stores the snapshot field as an array of [path, info] entries", () => {
		const appendEntry = vi.fn();
		persistSnapshot({ appendEntry }, SAMPLE_SNAPSHOT);
		const [, data] = appendEntry.mock.calls[0] as [string, Record<string, unknown>];
		expect(Array.isArray(data["snapshot"])).toBe(true);
		const items = data["snapshot"] as Array<[string, unknown]>;
		expect(items.length).toBe(1);
		expect(items[0]![0]).toBe("/db/skill-a/0001-x.json");
	});

	it("swallows errors from appendEntry", () => {
		const appendEntry = vi.fn().mockImplementation(() => {
			throw new Error("storage failure");
		});
		expect(() => persistSnapshot({ appendEntry }, SAMPLE_SNAPSHOT)).not.toThrow();
	});
});

// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
	it("STATE_ENTRY_TYPE uses colon separator (not dash)", () => {
		expect(STATE_ENTRY_TYPE).toBe("pi-local-issue-watcher:state");
	});

	it("ENABLED_ENTRY_TYPE uses colon separator", () => {
		expect(ENABLED_ENTRY_TYPE).toBe("pi-local-issue-watcher:enabled");
	});
});

// ---------------------------------------------------------------------------
// rehydrateEnabledFromSession
// ---------------------------------------------------------------------------

describe("rehydrateEnabledFromSession", () => {
	it("returns false when no entries", () => {
		expect(rehydrateEnabledFromSession(makeCtx([]))).toBe(false);
	});

	it("returns false when no matching entry exists", () => {
		const ctx = makeCtx([
			entry("some-other-type", { savedAt: now(), items: [], baselines: { enabled: true } }),
		]);
		expect(rehydrateEnabledFromSession(ctx)).toBe(false);
	});

	it("returns false when entry has enabled: false", () => {
		const ctx = makeCtx([
			entry(ENABLED_ENTRY_TYPE, { savedAt: now(), items: [], baselines: { enabled: false } }),
		]);
		expect(rehydrateEnabledFromSession(ctx)).toBe(false);
	});

	it("returns true when entry has enabled: true", () => {
		const ctx = makeCtx([
			entry(ENABLED_ENTRY_TYPE, { savedAt: now(), items: [], baselines: { enabled: true } }),
		]);
		expect(rehydrateEnabledFromSession(ctx)).toBe(true);
	});

	it("returns false when baselines has no enabled key", () => {
		const ctx = makeCtx([
			entry(ENABLED_ENTRY_TYPE, { savedAt: now(), items: [], baselines: {} }),
		]);
		expect(rehydrateEnabledFromSession(ctx)).toBe(false);
	});

	it("reads the newest entry (latest enabled state wins)", () => {
		const ctx = makeCtx([
			entry(ENABLED_ENTRY_TYPE, { savedAt: now() - 2000, items: [], baselines: { enabled: true } }),
			entry(ENABLED_ENTRY_TYPE, { savedAt: now(), items: [], baselines: { enabled: false } }),
		]);
		expect(rehydrateEnabledFromSession(ctx)).toBe(false);
	});

	it("ignores TTL — sticky flag regardless of age", () => {
		// Unlike the snapshot, the enabled flag has no expiry.
		const ctx = makeCtx([
			entry(ENABLED_ENTRY_TYPE, { savedAt: now() - 30 * 24 * 60 * 60 * 1000, items: [], baselines: { enabled: true } }),
		]);
		expect(rehydrateEnabledFromSession(ctx)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// persistEnabled
// ---------------------------------------------------------------------------

describe("persistEnabled", () => {
	it("calls appendEntry with ENABLED_ENTRY_TYPE and enabled:true", () => {
		const appendEntry = vi.fn();
		persistEnabled({ appendEntry }, true);
		expect(appendEntry).toHaveBeenCalledOnce();
		const [ct, data] = appendEntry.mock.calls[0] as [string, Record<string, unknown>];
		expect(ct).toBe(ENABLED_ENTRY_TYPE);
		expect((data["baselines"] as Record<string, unknown>)["enabled"]).toBe(true);
		expect(typeof data["savedAt"]).toBe("number");
	});

	it("calls appendEntry with ENABLED_ENTRY_TYPE and enabled:false", () => {
		const appendEntry = vi.fn();
		persistEnabled({ appendEntry }, false);
		const [ct, data] = appendEntry.mock.calls[0] as [string, Record<string, unknown>];
		expect(ct).toBe(ENABLED_ENTRY_TYPE);
		expect((data["baselines"] as Record<string, unknown>)["enabled"]).toBe(false);
	});

	it("swallows errors from appendEntry", () => {
		const appendEntry = vi.fn().mockImplementation(() => {
			throw new Error("storage failure");
		});
		expect(() => persistEnabled({ appendEntry }, true)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Additional _normaliseSnapshotItems branch coverage
// ---------------------------------------------------------------------------

describe("_normaliseSnapshotItems — additional branches", () => {
	it("skips single-element tuples (entry.length < 2)", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, snapshotEntryData(
				[
					["/db/single"] as unknown as [string, unknown], // length=1
					["/db/valid.json", SAMPLE_ISSUE_SERIALISED],
				],
			)),
		]);
		const got = rehydrateFromSession(ctx);
		expect(Object.keys(got!.snapshot)).toEqual(["/db/valid.json"]);
	});

	it("skips entries where first element is not a string", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, snapshotEntryData(
				[
					[42, SAMPLE_ISSUE_SERIALISED] as unknown as [string, unknown], // non-string key
					["/db/valid.json", SAMPLE_ISSUE_SERIALISED],
				],
			)),
		]);
		const got = rehydrateFromSession(ctx);
		expect(Object.keys(got!.snapshot)).toEqual(["/db/valid.json"]);
	});

	it("skips entries where value is null (entry[1] is falsy)", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, snapshotEntryData(
				[
					["/db/null-val.json", null] as unknown as [string, unknown],
					["/db/valid.json", SAMPLE_ISSUE_SERIALISED],
				],
			)),
		]);
		const got = rehydrateFromSession(ctx);
		expect(Object.keys(got!.snapshot)).toEqual(["/db/valid.json"]);
	});

	it("skips entries where value is a non-object primitive", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, snapshotEntryData(
				[
					["/db/string-val.json", "not-an-object"] as unknown as [string, unknown],
					["/db/valid.json", SAMPLE_ISSUE_SERIALISED],
				],
			)),
		]);
		const got = rehydrateFromSession(ctx);
		expect(Object.keys(got!.snapshot)).toEqual(["/db/valid.json"]);
	});

	it("uses default empty string when issueId is not a string", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, snapshotEntryData(
				[["/db/a.json", { ...SAMPLE_ISSUE_SERIALISED, issueId: 42 }]],
			)),
		]);
		const got = rehydrateFromSession(ctx);
		expect(got!.snapshot["/db/a.json"]?.issueId).toBe("");
	});

	it("uses empty array when comments is not an array", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, snapshotEntryData(
				[["/db/a.json", { ...SAMPLE_ISSUE_SERIALISED, comments: "not-an-array" }]],
			)),
		]);
		const got = rehydrateFromSession(ctx);
		expect(got!.snapshot["/db/a.json"]?.comments).toEqual([]);
	});

	it("uses \"0\" string (then 0n bigint) for mtimeNs when the raw value is not a string", () => {
		// rawInfo["mtimeNs"] is a number → `typeof rawInfo["mtimeNs"] === "string"` is false
		// → _normaliseSnapshotItems stores "0" → _toBigint("0") = 0n
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, snapshotEntryData(
				[["/db/a.json", { ...SAMPLE_ISSUE_SERIALISED, mtimeNs: 12345 as unknown as string }]],
			)),
		]);
		const got = rehydrateFromSession(ctx);
		expect(got!.snapshot["/db/a.json"]?.mtimeNs).toBe(0n);
	});

	it("uses default empty strings when status, title, description, skill, skillVersion are not strings", () => {
		// Each ternary `typeof rawInfo[field] === "string" ? rawInfo[field] : ""` has its
		// false branch hit when the value is not a string.
		const malformed = {
			...SAMPLE_ISSUE_SERIALISED,
			status: 1 as unknown as string,
			title: true as unknown as string,
			description: null as unknown as string,
			skill: [] as unknown as string,
			skillVersion: {} as unknown as string,
		};
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, snapshotEntryData(
				[["/db/b.json", malformed]],
			)),
		]);
		const got = rehydrateFromSession(ctx);
		const item = got!.snapshot["/db/b.json"]!;
		expect(item.status).toBe("");
		expect(item.title).toBe("");
		expect(item.description).toBe("");
		expect(item.skill).toBe("");
		expect(item.skillVersion).toBe("");
	});
});
