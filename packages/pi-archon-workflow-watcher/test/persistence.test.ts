import { describe, expect, it, vi } from "vitest";

import {
	RUNSTATE_ENTRY_TYPE,
	STATE_ENTRY_TYPE,
	rehydrateRunStateFromSession,
	rehydrateSnapshotFromSession,
	writeRunState,
	writeSnapshot,
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

// ---------------------------------------------------------------------------
// rehydrateSnapshotFromSession
// ---------------------------------------------------------------------------

describe("rehydrateSnapshotFromSession", () => {
	it("returns null when there are no entries", () => {
		expect(rehydrateSnapshotFromSession(makeCtx([]) as never)).toBeNull();
	});

	it("returns null when no entries match STATE_ENTRY_TYPE", () => {
		const ctx = makeCtx([
			entry("some-other-type", { savedAt: now(), snapshot: SAMPLE_SNAPSHOT }),
			entry(RUNSTATE_ENTRY_TYPE, { savedAt: now(), paused: false }),
		]);
		expect(rehydrateSnapshotFromSession(ctx as never)).toBeNull();
	});

	it("returns the most recent matching entry (walks newest to oldest)", () => {
		const older: RunSnapshot = {
			"run-old": { id: "run-old", status: "running" },
		};
		const newer: RunSnapshot = {
			"run-new": { id: "run-new", status: "completed" },
		};
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, { savedAt: now() - 1000, snapshot: older }),
			entry("noise", "hello"),
			entry(STATE_ENTRY_TYPE, { savedAt: now(), snapshot: newer }),
		]);
		const got = rehydrateSnapshotFromSession(ctx as never);
		expect(got).not.toBeNull();
		expect(Object.keys(got!.snapshot)).toEqual(["run-new"]);
	});

	it("returns a stale entry (no TTL — entries never expire)", () => {
		// The old design had a 5-minute TTL; the new design has no TTL.
		const veryOld = now() - 7 * 24 * 60 * 60 * 1000; // 7 days ago
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, { savedAt: veryOld, snapshot: SAMPLE_SNAPSHOT }),
		]);
		const got = rehydrateSnapshotFromSession(ctx as never);
		expect(got).not.toBeNull();
		expect(got!.snapshot).toEqual(SAMPLE_SNAPSHOT);
	});

	it("returns a valid entry", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, { savedAt: now(), snapshot: SAMPLE_SNAPSHOT }),
		]);
		const got = rehydrateSnapshotFromSession(ctx as never);
		expect(got).not.toBeNull();
		expect(got!.snapshot).toEqual(SAMPLE_SNAPSHOT);
	});

	it("returns null when entry data is missing", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ctx = makeCtx([entry(STATE_ENTRY_TYPE, undefined)]);
		expect(rehydrateSnapshotFromSession(ctx as never)).toBeNull();
		warn.mockRestore();
	});

	it("skips malformed entry (missing snapshot) and falls through to next", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const older: RunSnapshot = { "run-old": { id: "run-old", status: "running" } };
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, { savedAt: now() - 2000, snapshot: older }), // older, valid
			entry(STATE_ENTRY_TYPE, { savedAt: now() /* no snapshot */ }), // newer, malformed
		]);
		const got = rehydrateSnapshotFromSession(ctx as never);
		expect(got).not.toBeNull();
		expect(Object.keys(got!.snapshot)).toEqual(["run-old"]);
		warn.mockRestore();
	});

	it("returns the savedAt from the entry", () => {
		const ts = now();
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, { savedAt: ts, snapshot: SAMPLE_SNAPSHOT }),
		]);
		const got = rehydrateSnapshotFromSession(ctx as never);
		expect(got!.savedAt).toBe(ts);
	});

	it("preserves all ArchonRun fields in the rehydrated snapshot", () => {
		const snap: RunSnapshot = {
			r1: {
				id: "r1",
				status: "running",
				workflowName: "wf",
				workingPath: "/repo/main",
				startedAt: "2024-01-01T00:00:00Z",
				lastActivityAt: "2024-01-01T01:00:00Z",
				extra: "field",
			},
		};
		const ctx = makeCtx([entry(STATE_ENTRY_TYPE, { savedAt: now(), snapshot: snap })]);
		const got = rehydrateSnapshotFromSession(ctx as never);
		expect(got!.snapshot["r1"]).toMatchObject(snap["r1"]!);
	});
});

// ---------------------------------------------------------------------------
// rehydrateRunStateFromSession
// ---------------------------------------------------------------------------

describe("rehydrateRunStateFromSession", () => {
	it("returns null when there are no entries", () => {
		expect(rehydrateRunStateFromSession(makeCtx([]) as never)).toBeNull();
	});

	it("returns null when no entries match RUNSTATE_ENTRY_TYPE", () => {
		const ctx = makeCtx([
			entry(STATE_ENTRY_TYPE, { savedAt: now(), snapshot: SAMPLE_SNAPSHOT }),
		]);
		expect(rehydrateRunStateFromSession(ctx as never)).toBeNull();
	});

	it("returns the most recent run-state entry (paused=true)", () => {
		const ctx = makeCtx([
			entry(RUNSTATE_ENTRY_TYPE, { savedAt: now() - 1000, paused: false }),
			entry(RUNSTATE_ENTRY_TYPE, { savedAt: now(), paused: true }),
		]);
		const got = rehydrateRunStateFromSession(ctx as never);
		expect(got!.paused).toBe(true);
	});

	it("returns the most recent run-state entry (paused=false)", () => {
		const ctx = makeCtx([
			entry(RUNSTATE_ENTRY_TYPE, { savedAt: now() - 2000, paused: true }),
			entry(RUNSTATE_ENTRY_TYPE, { savedAt: now(), paused: false }),
		]);
		const got = rehydrateRunStateFromSession(ctx as never);
		expect(got!.paused).toBe(false);
	});

	it("has no TTL — honours a paused entry from a long time ago", () => {
		const ancient = now() - 7 * 24 * 60 * 60 * 1000; // 7 days ago
		const ctx = makeCtx([
			entry(RUNSTATE_ENTRY_TYPE, { savedAt: ancient, paused: true }),
		]);
		const got = rehydrateRunStateFromSession(ctx as never);
		expect(got).not.toBeNull();
		expect(got!.paused).toBe(true);
	});

	it("skips entries with missing data and falls through", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ctx = makeCtx([
			entry(RUNSTATE_ENTRY_TYPE, { savedAt: now() - 1000, paused: true }), // older, valid
			entry(RUNSTATE_ENTRY_TYPE, undefined), // newer, no data
		]);
		const got = rehydrateRunStateFromSession(ctx as never);
		expect(got!.paused).toBe(true);
		warn.mockRestore();
	});

	it("skips entries where paused is not a boolean", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ctx = makeCtx([
			entry(RUNSTATE_ENTRY_TYPE, { savedAt: now() - 1000, paused: false }), // older, valid
			entry(RUNSTATE_ENTRY_TYPE, {
				savedAt: now(),
				paused: "yes" as unknown as boolean,
			}), // newer, malformed
		]);
		const got = rehydrateRunStateFromSession(ctx as never);
		expect(got!.paused).toBe(false);
		warn.mockRestore();
	});

	it("returns null when all entries are malformed", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const ctx = makeCtx([
			entry(RUNSTATE_ENTRY_TYPE, undefined),
			entry(RUNSTATE_ENTRY_TYPE, { savedAt: "bad" }),
		]);
		expect(rehydrateRunStateFromSession(ctx as never)).toBeNull();
		warn.mockRestore();
	});
});

// ---------------------------------------------------------------------------
// writeSnapshot
// ---------------------------------------------------------------------------

describe("writeSnapshot", () => {
	it("calls pi.appendEntry with STATE_ENTRY_TYPE and snapshot", () => {
		const appendEntry = vi.fn();
		const pi = { appendEntry };
		writeSnapshot(pi, SAMPLE_SNAPSHOT, new Set());
		expect(appendEntry).toHaveBeenCalledOnce();
		const [type, data] = appendEntry.mock.calls[0] as [
			string,
			{ savedAt: number; snapshot: RunSnapshot },
		];
		expect(type).toBe(STATE_ENTRY_TYPE);
		expect(data.snapshot).toEqual(SAMPLE_SNAPSHOT);
		expect(typeof data.savedAt).toBe("number");
	});

	it("does not throw when appendEntry throws", () => {
		const pi = {
			appendEntry: vi.fn(() => {
				throw new Error("storage failure");
			}),
		};
		expect(() => writeSnapshot(pi, SAMPLE_SNAPSHOT, new Set())).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// writeRunState
// ---------------------------------------------------------------------------

describe("writeRunState", () => {
	it("calls pi.appendEntry with RUNSTATE_ENTRY_TYPE and paused=true", () => {
		const appendEntry = vi.fn();
		writeRunState({ appendEntry }, true);
		const [type, data] = appendEntry.mock.calls[0] as [
			string,
			{ savedAt: number; paused: boolean },
		];
		expect(type).toBe(RUNSTATE_ENTRY_TYPE);
		expect(data.paused).toBe(true);
		expect(typeof data.savedAt).toBe("number");
	});

	it("calls pi.appendEntry with paused=false", () => {
		const appendEntry = vi.fn();
		writeRunState({ appendEntry }, false);
		const [, data] = appendEntry.mock.calls[0] as [
			string,
			{ savedAt: number; paused: boolean },
		];
		expect(data.paused).toBe(false);
	});

	it("does not throw when appendEntry throws", () => {
		const pi = {
			appendEntry: vi.fn(() => {
				throw new Error("storage failure");
			}),
		};
		expect(() => writeRunState(pi, false)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("constants", () => {
	it("STATE_ENTRY_TYPE uses the package-name-prefixed form", () => {
		expect(STATE_ENTRY_TYPE).toBe("pi-archon-workflow-watcher:state");
	});

	it("RUNSTATE_ENTRY_TYPE uses the package-name-prefixed form", () => {
		expect(RUNSTATE_ENTRY_TYPE).toBe("pi-archon-workflow-watcher:runstate");
	});

});
