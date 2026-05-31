import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
import { readFileSync } from "node:fs";

import {
	DEFAULT_MAX_ITERATIONS,
	DEFAULT_TOKEN_BUDGET,
	loadGoalConfig,
	pickLatestGoalState,
	type GoalStateCandidateEntry,
	type PersistedGoalState,
	STATE_CUSTOM_TYPE,
} from "../src/state.js";

beforeEach(() => {
	vi.mocked(readFileSync).mockImplementation(() => {
		const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
		err.code = "ENOENT";
		throw err;
	});
});

describe("DEFAULT_MAX_ITERATIONS", () => {
	// Issue #0002: cap loop at 20 iterations so a misconfigured/stuck goal
	// can't burn tokens indefinitely. 20 is a reasonable upper bound for
	// most goals; users who need more can override via ~/.pi/agent/pi-goal.json.
	it("is 20 (issue #0002)", () => {
		expect(DEFAULT_MAX_ITERATIONS).toBe(20);
	});
});

describe("DEFAULT_TOKEN_BUDGET", () => {
	it("is at least 100k tokens", () => {
		expect(DEFAULT_TOKEN_BUDGET).toBeGreaterThanOrEqual(100_000);
	});
});

describe("loadGoalConfig", () => {
	it("returns {} when the config file is missing", () => {
		expect(loadGoalConfig()).toEqual({});
	});

	it("returns parsed config when the file exists", () => {
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({ maxIterations: 50, tokenBudget: 50000 }),
		);
		expect(loadGoalConfig()).toEqual({ maxIterations: 50, tokenBudget: 50000 });
	});

	it("returns {} when the file contains invalid JSON", () => {
		vi.mocked(readFileSync).mockReturnValue("not json");
		expect(loadGoalConfig()).toEqual({});
	});

	it("returns {} when the file read throws a non-ENOENT error", () => {
		vi.mocked(readFileSync).mockImplementation(() => {
			throw new Error("EACCES: permission denied");
		});
		expect(loadGoalConfig()).toEqual({});
	});
});

describe("pickLatestGoalState", () => {
	const sample: PersistedGoalState = {
		enabled: true,
		objective: "fix all tests",
		iterations: 3,
		maxIterations: 100,
		tokenBudget: 200000,
		tokenBaseline: 1000,
	};

	it("returns undefined for an empty entry list", () => {
		expect(pickLatestGoalState([])).toBeUndefined();
	});

	it("returns undefined when no goal state entry is present", () => {
		const entries: GoalStateCandidateEntry[] = [
			{ type: "message" },
			{ type: "custom", customType: "other" },
		];
		expect(pickLatestGoalState(entries)).toBeUndefined();
	});

	it("returns the latest state when one is present", () => {
		const entries: GoalStateCandidateEntry[] = [
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: sample },
		];
		expect(pickLatestGoalState(entries)).toEqual(sample);
	});

	it("returns the most recent state when multiple are present", () => {
		const older: PersistedGoalState = {
			enabled: false,
			objective: "previous",
			iterations: 0,
			maxIterations: 100,
			tokenBudget: 200000,
			tokenBaseline: 0,
		};
		const entries: GoalStateCandidateEntry[] = [
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: older },
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: sample },
		];
		expect(pickLatestGoalState(entries)).toEqual(sample);
	});

	it("ignores custom entries with a different customType", () => {
		const entries: GoalStateCandidateEntry[] = [
			{ type: "custom", customType: "pi-other:state", data: { hello: "world" } },
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: sample },
		];
		expect(pickLatestGoalState(entries)).toEqual(sample);
	});

	it("skips entries with missing data", () => {
		const entries: GoalStateCandidateEntry[] = [
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: undefined },
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: sample },
		];
		expect(pickLatestGoalState(entries)).toEqual(sample);
	});

	it("skips the NEWEST entry when it has undefined data, returning an older valid entry", () => {
		// The loop walks newest-last. Put undefined data last so it is visited first
		// and the !data branch (continue) is actually exercised before falling back.
		const entries: GoalStateCandidateEntry[] = [
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: sample },
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: undefined },
		];
		expect(pickLatestGoalState(entries)).toEqual(sample);
	});

	it("handles a null/undefined element in the entries array (!entry guard)", () => {
		// TypeScript types prevent null here, but real session arrays can be sparse.
		// Put null last so it is visited first in the reverse walk.
		const entries = [
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: sample },
			null as unknown as GoalStateCandidateEntry,
		] as readonly GoalStateCandidateEntry[];
		expect(pickLatestGoalState(entries)).toEqual(sample);
	});
});

describe("loadGoalConfig — HOME/USERPROFILE fallback", () => {
	it("uses USERPROFILE when HOME is not set", () => {
		const savedHome = process.env["HOME"];
		const savedUserProfile = process.env["USERPROFILE"];
		try {
			delete process.env["HOME"];
			process.env["USERPROFILE"] = "/test/userprofile";
			// readFileSync is still mocked to throw ENOENT — config falls back to {}
			expect(loadGoalConfig()).toEqual({});
		} finally {
			if (savedHome !== undefined) process.env["HOME"] = savedHome;
			else delete process.env["HOME"];
			if (savedUserProfile !== undefined) process.env["USERPROFILE"] = savedUserProfile;
			else delete process.env["USERPROFILE"];
		}
	});

	it("falls back to empty string when neither HOME nor USERPROFILE is set", () => {
		const savedHome = process.env["HOME"];
		const savedUserProfile = process.env["USERPROFILE"];
		try {
			delete process.env["HOME"];
			delete process.env["USERPROFILE"];
			expect(loadGoalConfig()).toEqual({});
		} finally {
			if (savedHome !== undefined) process.env["HOME"] = savedHome;
			else delete process.env["HOME"];
			if (savedUserProfile !== undefined) process.env["USERPROFILE"] = savedUserProfile;
			else delete process.env["USERPROFILE"];
		}
	});
});
