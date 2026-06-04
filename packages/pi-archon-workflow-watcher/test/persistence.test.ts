import { describe, expect, it, vi } from "vitest";

import {
	STATE_ENTRY_TYPE,
	rehydrateStateFromSession,
	writeState,
} from "../src/persistence.js";
import type { RunSnapshot } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function entry(
	customType: string,
	data?: unknown,
): { type: string; customType: string; data?: unknown } {
	return { type: "custom", customType, data };
}

function makeCtx(
	entries: Array<{ type?: string; customType?: string; data?: unknown }>,
) {
	return {
		sessionManager: {
			getEntries: () => entries,
		},
	};
}

const SAMPLE_SNAPSHOT: RunSnapshot = {
	"run-1": {
		id: "run-1",
		status: "running",
		workflowName: "my-wf",
		workingPath: "/repo/main",
	},
};

function now(): number {
	return Date.now();
}

/** Build a valid combined state entry data payload */
function validData(
	overrides: {
		savedAt?: number;
		watchedIds?: string[];
		baselines?: RunSnapshot;
	} = {},
) {
	return {
		savedAt: overrides.savedAt ?? now(),
		watchedIds: overrides.watchedIds ?? [],
		baselines: overrides.baselines ?? {},
	};
}

// ---------------------------------------------------------------------------
// rehydrateStateFromSession
// ---------------------------------------------------------------------------

describe("rehydrateStateFromSession", () => {
	it("returns null when there are no entries", () => {
		expect(rehydrateStateFromSession(makeCtx([]))).toBeNull();
	});

	it("returns null when no entries match STATE_ENTRY_TYPE", () => {
		const ctx = makeCtx([
			entry("some-other-type", validData()),
		]);
		expect(rehydrateStateFromSession(ctx)).toBeNull();
	});

	it("reads entries newest-to-oldest; newest wins", () => {
		const older = entry(STATE_ENTRY_TYPE, validData({ savedAt: 1_000, watchedIds: ["run-old"] }));
		const newer = entry(STATE_ENTRY_TYPE, validData({ savedAt: 2_000, watchedIds: ["run-new"] }));
		const ctx = makeCtx([older, newer]);
		const got = rehydrateStateFromSession(ctx);
		expect(got).not.toBeNull();
		expect(got!.savedAt).toBe(2_000);
		expect(got!.watchedIds).toEqual(["run-new"]);
	});

	it("returns full state from a valid entry", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, validData({
				watchedIds: ["r1"],
				baselines: SAMPLE_SNAPSHOT,
			})),
		]);
		const got = rehydrateStateFromSession(ctx);
		expect(got).not.toBeNull();
		expect(got!.watchedIds).toEqual(["r1"]);
		expect(got!.snapshot).toEqual(SAMPLE_SNAPSHOT);
	});

	it("no TTL — stale entries are still returned", () => {
		const veryOld = now() - 7 * 24 * 60 * 60 * 1000;
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, validData({ savedAt: veryOld, watchedIds: ["r1"] })),
		]);
		const got = rehydrateStateFromSession(ctx);
		expect(got).not.toBeNull();
		expect(got!.watchedIds).toEqual(["r1"]);
	});

	it("skips entries with no data", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, validData({ watchedIds: ["r1"] })), // older valid
			entry(STATE_ENTRY_TYPE, undefined), // newer, no data
		]);
		const got = rehydrateStateFromSession(ctx);
		expect(got).not.toBeNull();
		expect(got!.watchedIds).toEqual(["r1"]);
	});

	it("skips entries with bad savedAt and falls through", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, validData({ watchedIds: ["r1"] })), // older valid
			entry(STATE_ENTRY_TYPE, { ...validData(), savedAt: "bad" }), // newer, bad savedAt
		]);
		const got = rehydrateStateFromSession(ctx);
		expect(got).not.toBeNull();
		expect(got!.watchedIds).toEqual(["r1"]);
	});

	it("skips entries with non-array watchedIds", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, validData({ watchedIds: ["r1"] })), // older valid
			entry(STATE_ENTRY_TYPE, { ...validData(), watchedIds: "r1" }), // newer, bad watchedIds
		]);
		const got = rehydrateStateFromSession(ctx);
		expect(got).not.toBeNull();
		expect(got!.watchedIds).toEqual(["r1"]);
	});

	it("filters watchedIds to strings only", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, validData({ watchedIds: ["r1", 42 as unknown as string, null as unknown as string, "r2"] })),
		]);
		const got = rehydrateStateFromSession(ctx);
		expect(got!.watchedIds).toEqual(["r1", "r2"]);
	});

	it("preserves open-ended RunSnapshot fields", () => {
		const snap: RunSnapshot = {
			r1: { id: "r1", status: "running", extra: "field", workflowName: "wf" },
		};
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, validData({ baselines: snap })),
		]);
		const got = rehydrateStateFromSession(ctx);
		expect(got!.snapshot["r1"]).toMatchObject(snap["r1"]!);
	});

	it("returns savedAt from the entry", () => {
		const ts = now();
		const ctx = makeCtx([entry(STATE_ENTRY_TYPE, validData({ savedAt: ts }))]);
		const got = rehydrateStateFromSession(ctx);
		expect(got!.savedAt).toBe(ts);
	});
});

// ---------------------------------------------------------------------------
// writeState
// ---------------------------------------------------------------------------

describe("writeState", () => {
	it("calls pi.appendEntry with STATE_ENTRY_TYPE and correct shape", () => {
		const appendEntry = vi.fn();
		writeState({ appendEntry }, {
			snapshot: SAMPLE_SNAPSHOT,
			watchedIds: new Set(["r1"]),
		});
		expect(appendEntry).toHaveBeenCalledOnce();
		const [ct, data] = appendEntry.mock.calls[0] as [string, Record<string, unknown>];
		expect(ct).toBe(STATE_ENTRY_TYPE);
		expect(typeof data["savedAt"]).toBe("number");
		expect(data["watchedIds"]).toEqual(["r1"]);
		expect(data["baselines"]).toEqual(SAMPLE_SNAPSHOT);
	});

	it("swallows errors from appendEntry", () => {
		const appendEntry = vi.fn().mockImplementation(() => {
			throw new Error("storage failure");
		});
		expect(() =>
			writeState({ appendEntry }, { snapshot: {}, watchedIds: new Set() }),
		).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
	it("STATE_ENTRY_TYPE uses the package-name-prefixed form", () => {
		expect(STATE_ENTRY_TYPE).toBe("pi-archon-workflow-watcher:state");
	});
});

// ---------------------------------------------------------------------------
// normaliseBaselines — falsy / non-object / array guards (lines 18-20)
// ---------------------------------------------------------------------------

describe("normaliseBaselines — falsy/non-object/array guards", () => {
	it("returns snapshot {} when baselines is null", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, { ...validData({ watchedIds: ["r1"] }), baselines: null }),
		]);
		const got = rehydrateStateFromSession(ctx);
		expect(got).not.toBeNull();
		expect(got!.snapshot).toEqual({});
	});

	it("returns snapshot {} when baselines is a string", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, { ...validData({ watchedIds: ["r1"] }), baselines: "not-an-object" }),
		]);
		const got = rehydrateStateFromSession(ctx);
		expect(got).not.toBeNull();
		expect(got!.snapshot).toEqual({});
	});

	it("returns snapshot {} when baselines is an array", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, { ...validData({ watchedIds: ["r1"] }), baselines: [{ id: "r1" }] }),
		]);
		const got = rehydrateStateFromSession(ctx);
		expect(got).not.toBeNull();
		expect(got!.snapshot).toEqual({});
	});
});
