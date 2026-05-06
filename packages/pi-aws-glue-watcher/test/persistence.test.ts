import { describe, expect, it, vi } from "vitest";

import {
	normaliseWatches,
	rehydrateStateFromSession,
	STATE_CUSTOM_TYPE,
	writeState,
} from "../src/persistence.js";
import type { WatchMap } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(data: unknown, customType = STATE_CUSTOM_TYPE) {
	return { type: "custom", customType, data };
}

function makeSession(entries: unknown[]) {
	return {
		sessionManager: {
			getEntries: () =>
				entries as Array<{ type?: string; customType?: string; data?: unknown }>,
		},
	};
}

const VALID_DATA = {
	savedAt: 1_746_527_400_000,
	enabled: true,
	paused: false,
	watches: {} as WatchMap,
};

// ---------------------------------------------------------------------------
// rehydrateStateFromSession
// ---------------------------------------------------------------------------

describe("rehydrateStateFromSession", () => {
	it("returns null when the session has no entries", () => {
		expect(rehydrateStateFromSession(makeSession([]))).toBeNull();
	});

	it("returns null when no entries match the custom type", () => {
		const ctx = makeSession([makeEntry(VALID_DATA, "other:type")]);
		expect(rehydrateStateFromSession(ctx)).toBeNull();
	});

	it("returns null when the only entry has a non-custom type", () => {
		const ctx = makeSession([{ type: "message", customType: STATE_CUSTOM_TYPE, data: VALID_DATA }]);
		expect(rehydrateStateFromSession(ctx)).toBeNull();
	});

	it("returns hydrated state for a valid entry", () => {
		const ctx = makeSession([makeEntry(VALID_DATA)]);
		const result = rehydrateStateFromSession(ctx);
		expect(result).not.toBeNull();
		expect(result!.enabled).toBe(true);
		expect(result!.paused).toBe(false);
		expect(result!.savedAt).toBe(VALID_DATA.savedAt);
		expect(result!.watches).toEqual({});
	});

	it("reads entries newest-to-oldest, returning the last-appended valid one", () => {
		const older = makeEntry({ ...VALID_DATA, enabled: false, savedAt: 1_000 });
		const newer = makeEntry({ ...VALID_DATA, enabled: true, savedAt: 2_000 });
		const ctx = makeSession([older, newer]);
		const result = rehydrateStateFromSession(ctx);
		// newer is last in the array, so it wins (reversed iteration = last first)
		expect(result!.enabled).toBe(true);
		expect(result!.savedAt).toBe(2_000);
	});

	it("skips an entry with missing data and falls through to the next", () => {
		const bad = makeEntry(null);
		const good = makeEntry(VALID_DATA);
		// bad is appended after good, so iteration hits bad first (newest wins)
		// — but bad has null data, so it skips to good
		const ctx = makeSession([good, bad]);
		const result = rehydrateStateFromSession(ctx);
		expect(result!.enabled).toBe(true);
	});

	it("skips an entry with an invalid savedAt", () => {
		const bad = makeEntry({ ...VALID_DATA, savedAt: "not-a-number" });
		const ctx = makeSession([bad]);
		expect(rehydrateStateFromSession(ctx)).toBeNull();
	});

	it("skips an entry where enabled is not a boolean", () => {
		const bad = makeEntry({ ...VALID_DATA, enabled: "yes" });
		const ctx = makeSession([bad]);
		expect(rehydrateStateFromSession(ctx)).toBeNull();
	});

	it("skips an entry where paused is not a boolean", () => {
		const bad = makeEntry({ ...VALID_DATA, paused: 0 });
		const ctx = makeSession([bad]);
		expect(rehydrateStateFromSession(ctx)).toBeNull();
	});

	it("restores a watch record with all expected fields", () => {
		const data = {
			...VALID_DATA,
			watches: {
				aabb: {
					watchId: "aabb",
					type: "job",
					name: "my-job",
					runId: "jr_abc123",
					profile: "my-profile",
					region: "us-east-1",
					addedAt: 1_000,
					lastPolledAt: 2_000,
					baseline: { state: "RUNNING", errorMessage: "" },
					terminal: false,
				},
			},
		};
		const ctx = makeSession([makeEntry(data)]);
		const result = rehydrateStateFromSession(ctx);
		const watch = result!.watches["aabb"];
		expect(watch).toBeDefined();
		expect(watch!.watchId).toBe("aabb");
		expect(watch!.type).toBe("job");
		expect(watch!.name).toBe("my-job");
		expect(watch!.region).toBe("us-east-1");
		expect(watch!.terminal).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// writeState
// ---------------------------------------------------------------------------

describe("writeState", () => {
	it("calls appendEntry with STATE_CUSTOM_TYPE and the expected data shape", () => {
		const appendEntry = vi.fn();
		writeState({ appendEntry }, { enabled: true, paused: false, watches: {} });
		expect(appendEntry).toHaveBeenCalledOnce();
		const [ct, data] = appendEntry.mock.calls[0] as [string, Record<string, unknown>];
		expect(ct).toBe(STATE_CUSTOM_TYPE);
		expect(data["enabled"]).toBe(true);
		expect(data["paused"]).toBe(false);
		expect(typeof data["savedAt"]).toBe("number");
		expect(data["watches"]).toEqual({});
	});

	it("swallows errors thrown by appendEntry without propagating them", () => {
		const appendEntry = vi.fn().mockImplementation(() => {
			throw new Error("storage failure");
		});
		expect(() =>
			writeState({ appendEntry }, { enabled: false, paused: false, watches: {} }),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// normaliseWatches
// ---------------------------------------------------------------------------

describe("normaliseWatches", () => {
	it("returns an empty map for non-object inputs", () => {
		expect(normaliseWatches(null)).toEqual({});
		expect(normaliseWatches(undefined)).toEqual({});
		expect(normaliseWatches([])).toEqual({});
		expect(normaliseWatches(42)).toEqual({});
	});

	it("drops entries with missing required fields", () => {
		const raw = {
			bad1: { type: "job" }, // missing watchId, name, runId, profile
			bad2: { watchId: "aa", type: "unknown", name: "x", runId: "r", profile: "p" },
		};
		expect(normaliseWatches(raw)).toEqual({});
	});

	it("preserves valid entries and coerces optional fields", () => {
		const raw = {
			aabb: {
				watchId: "aabb",
				type: "workflow",
				name: "wf",
				runId: "wr_123",
				profile: "prod",
				// region absent → undefined
				addedAt: 999,
				// lastPolledAt absent → undefined
				terminal: true,
				baseline: null, // invalid → undefined
			},
		};
		const result = normaliseWatches(raw);
		expect(Object.keys(result)).toHaveLength(1);
		const w = result["aabb"]!;
		expect(w.type).toBe("workflow");
		expect(w.region).toBeUndefined();
		expect(w.lastPolledAt).toBeUndefined();
		expect(w.terminal).toBe(true);
		expect(w.baseline).toBeUndefined();
	});
});

describe("normaliseWatches — consecutiveErrors", () => {
	it("defaults consecutiveErrors to 0 when the field is absent", () => {
		const raw = {
			aa: {
				watchId: "aa", type: "job", name: "j", runId: "jr_1",
				profile: "p", addedAt: 1, terminal: false,
				// consecutiveErrors absent
			},
		};
		const result = normaliseWatches(raw);
		expect(result["aa"]!.consecutiveErrors).toBe(0);
	});

	it("preserves a valid consecutiveErrors value", () => {
		const raw = {
			aa: {
				watchId: "aa", type: "job", name: "j", runId: "jr_1",
				profile: "p", addedAt: 1, terminal: false,
				consecutiveErrors: 7,
			},
		};
		const result = normaliseWatches(raw);
		expect(result["aa"]!.consecutiveErrors).toBe(7);
	});

	it("defaults consecutiveErrors to 0 for a non-finite value", () => {
		const raw = {
			aa: {
				watchId: "aa", type: "job", name: "j", runId: "jr_1",
				profile: "p", addedAt: 1, terminal: false,
				consecutiveErrors: NaN,
			},
		};
		const result = normaliseWatches(raw);
		expect(result["aa"]!.consecutiveErrors).toBe(0);
	});
});
