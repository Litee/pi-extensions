import { describe, expect, it, vi } from "vitest";

import {
	RUNSTATE_ENTRY_TYPE,
	STATE_ENTRY_TYPE,
	STATE_MAX_AGE_MS,
	rehydrateFromSession,
	rehydrateRunStateFromSession,
	persistSnapshot,
	persistRunState,
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
		paused: false,
		snapshot: items,
		baselines: {},
	};
}

/** Build a valid runstate entry data payload. */
function runstateEntryData(paused: boolean, savedAt = now()) {
	return {
		savedAt,
		paused,
		items: [],
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

// ---------------------------------------------------------------------------
// rehydrateRunStateFromSession
// ---------------------------------------------------------------------------

describe("rehydrateRunStateFromSession", () => {
	it("returns null when no entries", () => {
		expect(rehydrateRunStateFromSession(makeCtx([]))).toBeNull();
	});

	it("returns the most recent run-state entry (paused=true)", () => {
		const ctx = makeCtx([
			entry(RUNSTATE_ENTRY_TYPE, runstateEntryData(false, now() - 1000)),
			entry(RUNSTATE_ENTRY_TYPE, runstateEntryData(true, now())),
		]);
		const got = rehydrateRunStateFromSession(ctx);
		expect(got!.paused).toBe(true);
	});

	it("returns the most recent run-state entry (paused=false)", () => {
		const ctx = makeCtx([
			entry(RUNSTATE_ENTRY_TYPE, runstateEntryData(true, now() - 1000)),
			entry(RUNSTATE_ENTRY_TYPE, runstateEntryData(false, now())),
		]);
		const got = rehydrateRunStateFromSession(ctx);
		expect(got!.paused).toBe(false);
	});

	it("no TTL — honours ancient entries", () => {
		const ancient = now() - 7 * 24 * 60 * 60 * 1000;
		const ctx = makeCtx([
			entry(RUNSTATE_ENTRY_TYPE, runstateEntryData(true, ancient)),
		]);
		const got = rehydrateRunStateFromSession(ctx);
		expect(got).not.toBeNull();
		expect(got!.paused).toBe(true);
	});

	it("skips malformed entries (bad paused) and falls through to next", () => {
		const ctx = makeCtx([
			entry(RUNSTATE_ENTRY_TYPE, runstateEntryData(true, now() - 1000)), // older, valid
			entry(RUNSTATE_ENTRY_TYPE, { ...runstateEntryData(false), paused: "yes" }), // newer, bad
		]);
		const got = rehydrateRunStateFromSession(ctx);
		expect(got!.paused).toBe(true);
	});

	it("skips entries with no data", () => {
		const ctx = makeCtx([
			entry(RUNSTATE_ENTRY_TYPE, undefined),
		]);
		expect(rehydrateRunStateFromSession(ctx)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// persistRunState
// ---------------------------------------------------------------------------

describe("persistRunState", () => {
	it("calls appendEntry with RUNSTATE_ENTRY_TYPE and paused=true", () => {
		const appendEntry = vi.fn();
		persistRunState({ appendEntry }, true);
		const [ct, data] = appendEntry.mock.calls[0] as [string, Record<string, unknown>];
		expect(ct).toBe(RUNSTATE_ENTRY_TYPE);
		expect(data["paused"]).toBe(true);
	});

	it("calls appendEntry with RUNSTATE_ENTRY_TYPE and paused=false", () => {
		const appendEntry = vi.fn();
		persistRunState({ appendEntry }, false);
		const [, data] = appendEntry.mock.calls[0] as [string, Record<string, unknown>];
		expect(data["paused"]).toBe(false);
	});

	it("swallows errors from appendEntry", () => {
		const appendEntry = vi.fn().mockImplementation(() => {
			throw new Error("storage failure");
		});
		expect(() => persistRunState({ appendEntry }, false)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
	it("STATE_ENTRY_TYPE uses colon separator (not dash)", () => {
		expect(STATE_ENTRY_TYPE).toBe("pi-local-issue-watcher:state");
	});

	it("RUNSTATE_ENTRY_TYPE uses colon separator (not dash)", () => {
		expect(RUNSTATE_ENTRY_TYPE).toBe("pi-local-issue-watcher:runstate");
	});
});
