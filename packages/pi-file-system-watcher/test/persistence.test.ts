/**
 * Tests for persistence.ts
 */

import { describe, expect, it, vi } from "vitest";

import { rehydrateStateFromSession, STATE_CUSTOM_TYPE, writeState } from "../src/persistence.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEntry(data: unknown) {
	return { type: "custom", customType: STATE_CUSTOM_TYPE, data };
}

function makeCtx(entries: unknown[]) {
	return {
		sessionManager: {
			getEntries: () => entries as Array<{ type?: string; customType?: string; data?: unknown }>,
		},
	};
}

function makePi() {
	return { appendEntry: vi.fn() };
}

// ---------------------------------------------------------------------------
// rehydrateStateFromSession
// ---------------------------------------------------------------------------

describe("rehydrateStateFromSession", () => {
	it("returns null when no entries", () => {
		expect(rehydrateStateFromSession(makeCtx([]))).toBeNull();
	});

	it("returns null when no matching entry", () => {
		expect(rehydrateStateFromSession(makeCtx([
			{ type: "custom", customType: "other-watcher:state", data: {} },
		]))).toBeNull();
	});

	it("rehydrates a valid state entry", () => {
		const state = rehydrateStateFromSession(makeCtx([
			makeEntry({
				savedAt: 1000,
				paused: true,
				watches: [
					{
						watchId: "abc123",
						path: "/tmp/test.txt",
						target: "exists",
						mode: "poll",
						timeoutAt: undefined,
						addedAt: 900,
						lastPolledAt: undefined,
						baseline: { exists: false },
						terminal: false,
						consecutiveErrors: 0,
					},
				],
				baselines: { enabled: true, displayMode: "statusline" },
			}),
		]));

		expect(state).not.toBeNull();
		expect(state!.paused).toBe(true);
		expect(state!.enabled).toBe(true);
		expect(state!.displayMode).toBe("statusline");
		const w = state!.watches["abc123"];
		expect(w?.path).toBe("/tmp/test.txt");
		expect(w?.target).toBe("exists");
	});

	it("picks the most recent valid entry (newest-first walk)", () => {
		const older = makeEntry({
			savedAt: 500,
			paused: false,
			watches: [],
			baselines: { enabled: false, displayMode: "widget" },
		});
		const newer = makeEntry({
			savedAt: 1000,
			paused: true,
			watches: [],
			baselines: { enabled: true, displayMode: "statusline" },
		});
		const state = rehydrateStateFromSession(makeCtx([older, newer]));
		expect(state!.savedAt).toBe(1000);
		expect(state!.paused).toBe(true);
	});

	it("skips malformed entries and falls through to older valid ones", () => {
		const bad = makeEntry({ savedAt: "not-a-number", paused: false, watches: [] });
		const good = makeEntry({
			savedAt: 500,
			paused: false,
			watches: [],
			baselines: { enabled: false, displayMode: "widget" },
		});
		const state = rehydrateStateFromSession(makeCtx([good, bad]));
		expect(state!.savedAt).toBe(500);
	});

	it("drops watches with missing required fields", () => {
		const state = rehydrateStateFromSession(makeCtx([
			makeEntry({
				savedAt: 1000,
				paused: false,
				watches: [
					{ watchId: "ok", path: "/p", target: "exists", mode: "poll", addedAt: 0, baseline: undefined, terminal: false, consecutiveErrors: 0 },
					{ watchId: "bad" /* missing path */ },
				],
				baselines: { enabled: false, displayMode: "widget" },
			}),
		]));
		expect(Object.keys(state!.watches)).toEqual(["ok"]);
	});
});

// ---------------------------------------------------------------------------
// writeState
// ---------------------------------------------------------------------------

describe("writeState", () => {
	it("calls appendEntry with the correct customType", () => {
		const pi = makePi();
		writeState(pi, {
			paused: false,
			enabled: true,
			watches: {},
			displayMode: "widget",
		});
		expect(pi.appendEntry).toHaveBeenCalledOnce();
		expect(pi.appendEntry.mock.calls[0]![0]).toBe(STATE_CUSTOM_TYPE);
	});

	it("swallows appendEntry errors (best-effort)", () => {
		const pi = { appendEntry: vi.fn().mockImplementation(() => { throw new Error("boom"); }) };
		expect(() =>
			writeState(pi, { paused: false, enabled: false, watches: {}, displayMode: "widget" }),
		).not.toThrow();
	});
});
