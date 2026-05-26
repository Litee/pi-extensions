import { describe, expect, it } from "vitest";

import {
	rehydrateStateFromSession,
	STATE_CUSTOM_TYPE,
	writeState,
} from "../src/persistence.js";
import type { Ec2Watch, WatchMap } from "../src/types.js";

function makeWatch(overrides: Partial<Ec2Watch> = {}): Ec2Watch {
	return {
		watchId: "w1",
		instanceId: "i-1234abcd",
		profile: "p",
		region: undefined,
		stopOnStopped: false,
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
			a: makeWatch({
				watchId: "a",
				baseline: { state: "running", nameTag: "my-vm", instanceType: "t3.micro" },
			}),
			b: makeWatch({ watchId: "b", stopOnStopped: true, timeoutAt: 9_999 }),
		};
		writeState(pi, { paused: false, enabled: false, watches, displayMode: "widget" });

		const state = rehydrateStateFromSession(makeSession(entries));
		expect(state).not.toBeNull();
		expect(state!.paused).toBe(false);
		expect(Object.keys(state!.watches).sort()).toEqual(["a", "b"]);
		expect(state!.watches["a"]!.baseline).toEqual({
			state: "running",
			nameTag: "my-vm",
			instanceType: "t3.micro",
		});
		expect(state!.watches["b"]!.stopOnStopped).toBe(true);
		expect(state!.watches["b"]!.timeoutAt).toBe(9_999);
	});

	it("writeState is best-effort — appendEntry throwing never escapes", () => {
		const pi = {
			appendEntry: () => {
				throw new Error("disk full");
			},
		};
		expect(() =>
			writeState(pi, { paused: false, enabled: false, watches: {}, displayMode: "widget" }),
		).not.toThrow();
	});

	it("round-trips enabled=true and displayMode=statusline", () => {
		const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
		const pi = {
			appendEntry: (customType: string, data: unknown) => {
				entries.push({ type: "custom", customType, data });
			},
		};
		writeState(pi, {
			paused: true,
			enabled: true,
			watches: {},
			displayMode: "statusline",
		});
		const state = rehydrateStateFromSession(makeSession(entries));
		expect(state!.paused).toBe(true);
		expect(state!.enabled).toBe(true);
		expect(state!.displayMode).toBe("statusline");
	});
});

describe("persistence malformed-entry tolerance", () => {
	it("returns null when no state entries are present", () => {
		expect(rehydrateStateFromSession(makeSession([]))).toBeNull();
	});

	it("skips entries with missing savedAt / paused", () => {
		const entries = [
			{
				type: "custom",
				customType: STATE_CUSTOM_TYPE,
				data: { paused: false, watches: [] },
			},
			{
				type: "custom",
				customType: STATE_CUSTOM_TYPE,
				data: { savedAt: 1, watches: [] },
			},
		];
		expect(rehydrateStateFromSession(makeSession(entries))).toBeNull();
	});

	it("skips malformed watches (missing instanceId)", () => {
		const entries = [
			{
				type: "custom",
				customType: STATE_CUSTOM_TYPE,
				data: {
					savedAt: 1,
					paused: false,
					watches: [{ watchId: "x" /* no instanceId */ }],
					baselines: { enabled: false, displayMode: "widget" },
				},
			},
		];
		const state = rehydrateStateFromSession(makeSession(entries));
		expect(state).not.toBeNull();
		expect(Object.keys(state!.watches)).toHaveLength(0);
	});

	it("uses the latest entry when multiple exist", () => {
		const entries = [
			{
				type: "custom",
				customType: STATE_CUSTOM_TYPE,
				data: {
					savedAt: 1,
					paused: false,
					watches: [],
					baselines: { enabled: false, displayMode: "widget" },
				},
			},
			{
				type: "custom",
				customType: STATE_CUSTOM_TYPE,
				data: {
					savedAt: 2,
					paused: true,
					watches: [],
					baselines: { enabled: true, displayMode: "statusline" },
				},
			},
		];
		const state = rehydrateStateFromSession(makeSession(entries));
		expect(state!.paused).toBe(true);
		expect(state!.enabled).toBe(true);
	});
});
