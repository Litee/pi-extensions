import { describe, expect, it } from "vitest";

import {
	rehydrateStateFromSession,
	STATE_CUSTOM_TYPE,
	writeState,
} from "../src/persistence.js";
import type { S3Watch, WatchMap } from "../src/types.js";

function makeWatch(overrides: Partial<S3Watch> = {}): S3Watch {
	return {
		watchId: "w1",
		bucket: "b",
		key: "k",
		profile: "p",
		region: undefined,
		target: "exists",
		timeoutAt: undefined,
		addedAt: 1_000,
		lastPolledAt: undefined,
		baseline: undefined,
		terminal: false,
		consecutiveErrors: 0,
		...overrides,
	};
}

function makeSession(entries: Array<{ type: string; customType?: string; data?: unknown }>) {
	return { sessionManager: { getEntries: () => entries } };
}

describe("persistence round-trip", () => {
	it("writeState + rehydrate returns the same watches", () => {
		const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
		const pi = {
			appendEntry: (customType: string, data: unknown) => {
				entries.push({ type: "custom", customType, data });
			},
		};
		const watches: WatchMap = {
			a: makeWatch({ watchId: "a", target: "updated", baseline: { exists: true, etag: '"x"', contentLength: 5 } }),
			b: makeWatch({ watchId: "b", target: "removed", timeoutAt: 9_999 }),
		};
		writeState(pi, { paused: false, watches });

		const state = rehydrateStateFromSession(makeSession(entries));
		expect(state).not.toBeNull();
		expect(state!.paused).toBe(false);
		expect(Object.keys(state!.watches).sort()).toEqual(["a", "b"]);
		expect(state!.watches["a"]!.target).toBe("updated");
		expect(state!.watches["a"]!.baseline).toEqual({
			exists: true, etag: '"x"', contentLength: 5,
		});
		expect(state!.watches["b"]!.timeoutAt).toBe(9_999);
	});

	it("writeState is best-effort — appendEntry throwing never escapes", () => {
		const pi = {
			appendEntry: () => {
				throw new Error("disk full");
			},
		};
		expect(() => writeState(pi, { paused: false, watches: {} })).not.toThrow();
	});
});

describe("persistence malformed-entry tolerance", () => {
	it("returns null when no state entries are present", () => {
		expect(rehydrateStateFromSession(makeSession([]))).toBeNull();
	});

	it("skips entries with missing savedAt / paused", () => {
		const entries = [
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: { paused: false, watches: [] } },
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: { savedAt: 1, watches: [] } },
		];
		expect(rehydrateStateFromSession(makeSession(entries))).toBeNull();
	});

	it("skips malformed watches (missing target)", () => {
		const entries = [{
			type: "custom",
			customType: STATE_CUSTOM_TYPE,
			data: {
				savedAt: 1, paused: false,
				watches: [
					{ watchId: "a", bucket: "b", key: "k", profile: "p", target: "invalid" },
					{ watchId: "b", bucket: "b", key: "k", profile: "p", target: "exists" },
				],
			},
		}];
		const state = rehydrateStateFromSession(makeSession(entries));
		expect(state).not.toBeNull();
		expect(Object.keys(state!.watches)).toEqual(["b"]);
	});

	it("returns the newest valid entry when later entries are malformed", () => {
		const entries = [
			{
				type: "custom", customType: STATE_CUSTOM_TYPE,
				data: { savedAt: 1, paused: false, watches: [makeWatch({ watchId: "old" })] },
			},
			// Newer but malformed: 'watches' not an array.
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: { savedAt: 2, paused: false, watches: "nope" } },
		];
		const state = rehydrateStateFromSession(makeSession(entries));
		expect(state).not.toBeNull();
		expect(Object.keys(state!.watches)).toEqual(["old"]);
	});
});
