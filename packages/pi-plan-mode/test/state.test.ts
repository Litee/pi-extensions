import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs");
import { readFileSync } from "node:fs";

import {
	LEGACY_STATE_CUSTOM_TYPE,
	loadPlanModeConfig,
	pickLatestPlanState,
	type PlanStateCandidateEntry,
	STATE_CUSTOM_TYPE,
} from "../src/state.js";

beforeEach(() => {
	// Default: config file does not exist.
	vi.mocked(readFileSync).mockImplementation(() => {
		const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
		err.code = "ENOENT";
		throw err;
	});
});

describe("loadPlanModeConfig", () => {
	it("returns {} when the config file is missing", () => {
		expect(loadPlanModeConfig()).toEqual({});
	});

	it("returns {} when the config file contains invalid JSON", () => {
		// Arrange
		vi.mocked(readFileSync).mockReturnValue("not json");

		// Act
		const result = loadPlanModeConfig();

		// Assert
		expect(result).toEqual({});
	});

	it("returns the parsed payload when the file is present and valid", () => {
		// Arrange
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({
				model: "claude-opus-4-20250514",
				provider: "anthropic",
				thinkingLevel: "high",
			}),
		);

		// Act
		const result = loadPlanModeConfig();

		// Assert
		expect(result).toEqual({
			model: "claude-opus-4-20250514",
			provider: "anthropic",
			thinkingLevel: "high",
		});
	});
});

describe("pickLatestPlanState", () => {
	it("returns undefined when the entry list is empty", () => {
		expect(pickLatestPlanState([])).toBeUndefined();
	});

	it("returns undefined when no custom entries match either key", () => {
		// Arrange
		const entries: PlanStateCandidateEntry[] = [
			{ type: "user_message", customType: "whatever" },
			{ type: "custom", customType: "some-other-extension:state", data: { enabled: true } },
		];

		// Act / Assert
		expect(pickLatestPlanState(entries)).toBeUndefined();
	});

	it("returns the new-key entry with source=new and snapshots intact", () => {
		// Arrange
		const state = {
			enabled: true,
			modelSnapshot: { id: "claude-sonnet-4-5", provider: "anthropic" },
			thinkingLevelSnapshot: "high" as const,
			toolsSnapshot: ["read", "edit"],
		};
		const entries: PlanStateCandidateEntry[] = [
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: state },
		];

		// Act
		const picked = pickLatestPlanState(entries);

		// Assert
		expect(picked).toEqual({ state, source: "new" });
	});

	it("returns source=legacy for the legacy key and strips any accidental snapshot fields", () => {
		// Arrange — some older writers may have accidentally stored snapshots
		// under the legacy key; the picker must not trust them.
		const entries: PlanStateCandidateEntry[] = [
			{
				type: "custom",
				customType: LEGACY_STATE_CUSTOM_TYPE,
				data: {
					enabled: true,
					modelSnapshot: { id: "x", provider: "y" },
					thinkingLevelSnapshot: "medium",
					toolsSnapshot: ["read"],
				},
			},
		];

		// Act
		const picked = pickLatestPlanState(entries);

		// Assert
		expect(picked).toEqual({ state: { enabled: true }, source: "legacy" });
	});

	it("prefers the newest entry when both legacy and new keys are present", () => {
		// Arrange — a legacy entry followed by a new entry. The new one wins.
		const newState = { enabled: false };
		const entries: PlanStateCandidateEntry[] = [
			{
				type: "custom",
				customType: LEGACY_STATE_CUSTOM_TYPE,
				data: { enabled: true },
			},
			{
				type: "custom",
				customType: STATE_CUSTOM_TYPE,
				data: newState,
			},
		];

		// Act
		const picked = pickLatestPlanState(entries);

		// Assert
		expect(picked).toEqual({ state: newState, source: "new" });
	});

	it("prefers a later legacy entry over an earlier new entry (strict recency, no key preference)", () => {
		// Arrange — strict latest-wins regardless of key format.
		const entries: PlanStateCandidateEntry[] = [
			{
				type: "custom",
				customType: STATE_CUSTOM_TYPE,
				data: { enabled: true, modelSnapshot: { id: "a", provider: "b" } },
			},
			{
				type: "custom",
				customType: LEGACY_STATE_CUSTOM_TYPE,
				data: { enabled: false },
			},
		];

		// Act
		const picked = pickLatestPlanState(entries);

		// Assert
		expect(picked).toEqual({ state: { enabled: false }, source: "legacy" });
	});

	it("returns the latest of many new-key entries", () => {
		// Arrange
		const entries: PlanStateCandidateEntry[] = [
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: { enabled: true } },
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: { enabled: false } },
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: { enabled: true } },
		];

		// Act
		const picked = pickLatestPlanState(entries);

		// Assert
		expect(picked?.state.enabled).toBe(true);
		expect(picked?.source).toBe("new");
	});

	it("skips custom entries with no data payload", () => {
		// Arrange
		const entries: PlanStateCandidateEntry[] = [
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: { enabled: true } },
			{ type: "custom", customType: STATE_CUSTOM_TYPE /* data missing */ },
		];

		// Act
		const picked = pickLatestPlanState(entries);

		// Assert — falls back to the only entry with data.
		expect(picked?.state.enabled).toBe(true);
	});

	it("ignores entries whose type is not 'custom'", () => {
		// Arrange
		const entries: PlanStateCandidateEntry[] = [
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: { enabled: true } },
			{ type: "assistant_message", customType: STATE_CUSTOM_TYPE, data: { enabled: false } },
		];

		// Act
		const picked = pickLatestPlanState(entries);

		// Assert
		expect(picked?.state.enabled).toBe(true);
	});
});

describe("loadPlanModeConfig — HOME/USERPROFILE fallback", () => {
	it("uses USERPROFILE when HOME is not set", () => {
		const savedHome = process.env["HOME"];
		const savedUserProfile = process.env["USERPROFILE"];
		try {
			delete process.env["HOME"];
			process.env["USERPROFILE"] = "/test/userprofile";
			// readFileSync is mocked to throw ENOENT — config falls back to {}
			vi.mocked(readFileSync).mockClear();
			expect(loadPlanModeConfig()).toEqual({});
			expect(vi.mocked(readFileSync).mock.calls[0]![0]).toBe("/test/userprofile/.pi/agent/pi-plan-mode.json");
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
			vi.mocked(readFileSync).mockClear();
			expect(loadPlanModeConfig()).toEqual({});
			expect(vi.mocked(readFileSync).mock.calls[0]![0]).toBe(".pi/agent/pi-plan-mode.json");
		} finally {
			if (savedHome !== undefined) process.env["HOME"] = savedHome;
			else delete process.env["HOME"];
			if (savedUserProfile !== undefined) process.env["USERPROFILE"] = savedUserProfile;
			else delete process.env["USERPROFILE"];
		}
	});
});
