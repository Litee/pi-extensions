import { describe, expect, it, vi } from "vitest";

import {
	RUNSTATE_ENTRY_TYPE,
	STATE_ENTRY_TYPE,
	STATE_MAX_AGE_MS,
	rehydrateFromSession,
	rehydrateRunStateFromSession,
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

	// -- issue #0016: lastUpdateAt no longer exposed on the rehydrated state --
	it("silently drops a lastUpdateAt field from legacy entries (issue #0016)", () => {
		// Old pi sessions wrote a `lastUpdateAt` alongside the snapshot. After
		// #0016 that field has no consumer, so the read path should accept the
		// entry (no console warn, no null) but the returned shape must not
		// expose it.
		const stamp = now() - 120_000;
		const ctx = makeCtx([
			entry("custom", { savedAt: now(), snapshot: FRESH_SNAPSHOT, lastUpdateAt: stamp }, STATE_ENTRY_TYPE),
		]);
		const got = rehydrateFromSession(ctx as never);
		expect(got).not.toBeNull();
		expect(got).not.toHaveProperty("lastUpdateAt");
	});

	it("skips a malformed newest entry and returns the older valid one (issue #0002)", () => {
		// Regression: previously, a single malformed entry anywhere in the walk
		// caused rehydrate to return null, discarding older valid baselines.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const validData = {
			savedAt: now(),
			snapshot: {
				"/db/skill-a/0001-x.json": {
					...FRESH_SNAPSHOT["/db/skill-a/0001-x.json"]!,
					mtimeNs: "777",
				},
			},
		};
		const ctx = makeCtx([
			// Older — valid.
			entry("custom", validData, STATE_ENTRY_TYPE),
			// Noise between state entries.
			entry("message", "noise"),
			// Newest — malformed snapshot (not an object).
			entry("custom", { savedAt: now(), snapshot: null }, STATE_ENTRY_TYPE),
		]);
		const got = rehydrateFromSession(ctx as never);
		expect(got).not.toBeNull();
		expect(got!.snapshot["/db/skill-a/0001-x.json"]!.mtimeNs).toBe(777n);
		warn.mockRestore();
	});

	it("skips a newest entry with missing data and returns the older valid one (issue #0002)", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const validData = {
			savedAt: now(),
			snapshot: FRESH_SNAPSHOT,
		};
		const ctx = makeCtx([
			entry("custom", validData, STATE_ENTRY_TYPE),
			entry("custom", undefined, STATE_ENTRY_TYPE), // newest, missing data
		]);
		const got = rehydrateFromSession(ctx as never);
		expect(got).not.toBeNull();
		expect(Object.keys(got!.snapshot)).toEqual(["/db/skill-a/0001-x.json"]);
		warn.mockRestore();
	});
});

describe("rehydrateRunStateFromSession", () => {
	it("returns null when there are no entries", () => {
		expect(rehydrateRunStateFromSession(makeCtx([]) as never)).toBeNull();
	});

	it("returns null when no entries match the RUNSTATE_ENTRY_TYPE", () => {
		const ctx = makeCtx([
			entry("custom", { savedAt: now(), snapshot: FRESH_SNAPSHOT }, STATE_ENTRY_TYPE),
			entry("message", "hello"),
		]);
		expect(rehydrateRunStateFromSession(ctx as never)).toBeNull();
	});

	it("returns the most recent run-state entry (paused)", () => {
		const ctx = makeCtx([
			entry("custom", { savedAt: now() - 1000, paused: false }, RUNSTATE_ENTRY_TYPE),
			entry("custom", { savedAt: now(), paused: true }, RUNSTATE_ENTRY_TYPE),
		]);
		const got = rehydrateRunStateFromSession(ctx as never);
		expect(got).not.toBeNull();
		expect(got!.paused).toBe(true);
	});

	it("returns the most recent run-state entry (running)", () => {
		const ctx = makeCtx([
			entry("custom", { savedAt: now() - 2000, paused: true }, RUNSTATE_ENTRY_TYPE),
			entry("custom", { savedAt: now(), paused: false }, RUNSTATE_ENTRY_TYPE),
		]);
		const got = rehydrateRunStateFromSession(ctx as never);
		expect(got).not.toBeNull();
		expect(got!.paused).toBe(false);
	});

	it("has no TTL — honours a paused entry that is older than STATE_MAX_AGE_MS", () => {
		const ancient = now() - STATE_MAX_AGE_MS - 1_000_000;
		const ctx = makeCtx([
			entry("custom", { savedAt: ancient, paused: true }, RUNSTATE_ENTRY_TYPE),
		]);
		const got = rehydrateRunStateFromSession(ctx as never);
		expect(got).not.toBeNull();
		expect(got!.paused).toBe(true);
	});

	it("skips malformed entries (missing paused field) and falls through to the next", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ctx = makeCtx([
			entry("custom", { savedAt: now() - 1000, paused: true }, RUNSTATE_ENTRY_TYPE),
			entry("custom", { savedAt: now() /* no paused field */ }, RUNSTATE_ENTRY_TYPE),
		]);
		const got = rehydrateRunStateFromSession(ctx as never);
		expect(got).not.toBeNull();
		expect(got!.paused).toBe(true);
		warn.mockRestore();
	});

	it("skips entries with missing data entirely", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ctx = makeCtx([entry("custom", undefined, RUNSTATE_ENTRY_TYPE)]);
		expect(rehydrateRunStateFromSession(ctx as never)).toBeNull();
		warn.mockRestore();
	});

	it("skips entries where paused is not a boolean", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ctx = makeCtx([
			entry("custom", { savedAt: now(), paused: "yes" as unknown as boolean }, RUNSTATE_ENTRY_TYPE),
		]);
		expect(rehydrateRunStateFromSession(ctx as never)).toBeNull();
		warn.mockRestore();
	});

	it("ignores unrelated custom-typed entries (e.g. STATE_ENTRY_TYPE)", () => {
		const ctx = makeCtx([
			entry("custom", { savedAt: now(), snapshot: FRESH_SNAPSHOT }, STATE_ENTRY_TYPE),
		]);
		expect(rehydrateRunStateFromSession(ctx as never)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Back-compat with the pre-#0017 entry types.
//
// Before #0017 this extension wrote entries under the customTypes
// `issue-watcher-state` and `issue-watcher-runstate`. Rehydration must
// still read those so in-flight session logs survive the rename cutover.
// ---------------------------------------------------------------------------

describe("rehydrateFromSession \u2014 legacy entry type (#0017)", () => {
	it("rehydrates a legacy 'issue-watcher-state' entry", () => {
		const ctx = makeCtx([
			entry("custom", { savedAt: now(), snapshot: FRESH_SNAPSHOT }, "issue-watcher-state"),
		]);
		const got = rehydrateFromSession(ctx as never);
		expect(got).not.toBeNull();
		expect(Object.keys(got!.snapshot)).toEqual(["/db/skill-a/0001-x.json"]);
	});

	it("prefers the newest entry regardless of which customType it carries", () => {
		// Newer legacy entry should win over an older new-name entry.
		const older: Snapshot = {
			"/db/old/0001-a.json": { ...FRESH_SNAPSHOT["/db/skill-a/0001-x.json"]! },
		};
		const newer: Snapshot = {
			"/db/new/0002-b.json": { ...FRESH_SNAPSHOT["/db/skill-a/0001-x.json"]! },
		};
		const ctx = makeCtx([
			entry("custom", { savedAt: now() - 1000, snapshot: older }, STATE_ENTRY_TYPE),
			entry("custom", { savedAt: now(), snapshot: newer }, "issue-watcher-state"),
		]);
		const got = rehydrateFromSession(ctx as never);
		expect(Object.keys(got!.snapshot)).toEqual(["/db/new/0002-b.json"]);
	});
});

describe("rehydrateRunStateFromSession \u2014 legacy entry type (#0017)", () => {
	it("rehydrates a legacy 'issue-watcher-runstate' entry", () => {
		const ctx = makeCtx([
			entry("custom", { savedAt: now(), paused: true }, "issue-watcher-runstate"),
		]);
		const got = rehydrateRunStateFromSession(ctx as never);
		expect(got).not.toBeNull();
		expect(got!.paused).toBe(true);
	});

	it("prefers the newest run-state entry regardless of customType", () => {
		const ctx = makeCtx([
			entry("custom", { savedAt: now() - 1000, paused: true }, RUNSTATE_ENTRY_TYPE),
			entry("custom", { savedAt: now(), paused: false }, "issue-watcher-runstate"),
		]);
		const got = rehydrateRunStateFromSession(ctx as never);
		expect(got!.paused).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// #0020 — state keys now carry the full package-name prefix
// (`pi-local-issue-watcher-state` / `-runstate`). Entries written by
// pre-#0017 builds (`issue-watcher-*`) and #0017…#0019 builds
// (`local-issue-watcher-*`) both remain readable via the LEGACY_ arrays.
// ---------------------------------------------------------------------------

describe("rehydrateFromSession — #0020 package-name-prefixed keys", () => {
	it("STATE_ENTRY_TYPE is prefixed with the full package name", () => {
		expect(STATE_ENTRY_TYPE).toBe("pi-local-issue-watcher-state");
	});

	it("RUNSTATE_ENTRY_TYPE is prefixed with the full package name", () => {
		expect(RUNSTATE_ENTRY_TYPE).toBe("pi-local-issue-watcher-runstate");
	});

	it("rehydrates from a mixed log containing all three legacy variants; newest wins", () => {
		// Interleave the three generations in arbitrary order; the
		// per-entry `savedAt` decides the winner, not the customType.
		const a: Snapshot = {
			"/db/a/0001-aaa.json": { ...FRESH_SNAPSHOT["/db/skill-a/0001-x.json"]! },
		};
		const b: Snapshot = {
			"/db/b/0002-bbb.json": { ...FRESH_SNAPSHOT["/db/skill-a/0001-x.json"]! },
		};
		const c: Snapshot = {
			"/db/c/0003-ccc.json": { ...FRESH_SNAPSHOT["/db/skill-a/0001-x.json"]! },
		};
		const ctx = makeCtx([
			entry(
				"custom",
				{ savedAt: now() - 3000, snapshot: a },
				"issue-watcher-state",
			),
			entry(
				"custom",
				{ savedAt: now() - 1000, snapshot: b },
				"local-issue-watcher-state",
			),
			entry(
				"custom",
				{ savedAt: now(), snapshot: c },
				STATE_ENTRY_TYPE,
			),
		]);
		const got = rehydrateFromSession(ctx as never);
		expect(Object.keys(got!.snapshot)).toEqual(["/db/c/0003-ccc.json"]);
	});

	it("rehydrates from a `local-issue-watcher-state` entry alone (#0017…#0019 legacy)", () => {
		const ctx = makeCtx([
			entry(
				"custom",
				{ savedAt: now(), snapshot: FRESH_SNAPSHOT },
				"local-issue-watcher-state",
			),
		]);
		const got = rehydrateFromSession(ctx as never);
		expect(got).not.toBeNull();
		expect(Object.keys(got!.snapshot)).toEqual(["/db/skill-a/0001-x.json"]);
	});
});

describe("rehydrateRunStateFromSession — #0020 package-name-prefixed keys", () => {
	it("rehydrates from a mixed run-state log containing all three legacy variants; newest wins", () => {
		const ctx = makeCtx([
			entry(
				"custom",
				{ savedAt: now() - 3000, paused: true },
				"issue-watcher-runstate",
			),
			entry(
				"custom",
				{ savedAt: now() - 1000, paused: false },
				"local-issue-watcher-runstate",
			),
			entry(
				"custom",
				{ savedAt: now(), paused: true },
				RUNSTATE_ENTRY_TYPE,
			),
		]);
		const got = rehydrateRunStateFromSession(ctx as never);
		expect(got!.paused).toBe(true);
	});

	it("rehydrates from a `local-issue-watcher-runstate` entry alone", () => {
		const ctx = makeCtx([
			entry(
				"custom",
				{ savedAt: now(), paused: true },
				"local-issue-watcher-runstate",
			),
		]);
		const got = rehydrateRunStateFromSession(ctx as never);
		expect(got!.paused).toBe(true);
	});
});
