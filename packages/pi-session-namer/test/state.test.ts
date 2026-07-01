import { describe, expect, it } from "vitest";

import { STATE_CUSTOM_TYPE, pickLatestState } from "../src/state.js";
import type { StateCandidateEntry } from "../src/state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStateEntry(lastAppliedName: string): StateCandidateEntry {
	return {
		type: "custom",
		customType: STATE_CUSTOM_TYPE,
		data: { lastAppliedName, herdrWorkspaceId: "w123", appliedAt: 0 },
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pickLatestState", () => {
	it("returns undefined when entries is empty", () => {
		expect(pickLatestState([])).toBeUndefined();
	});

	it("returns undefined when no entries have type === 'custom'", () => {
		const entries: StateCandidateEntry[] = [
			{ type: "user", data: { lastAppliedName: "foo" } },
			{ type: "assistant" },
		];
		expect(pickLatestState(entries)).toBeUndefined();
	});

	it("returns undefined when customType does not match STATE_CUSTOM_TYPE", () => {
		const entries: StateCandidateEntry[] = [
			{ type: "custom", customType: "other-extension:state", data: { lastAppliedName: "foo" } },
		];
		expect(pickLatestState(entries)).toBeUndefined();
	});

	it("returns undefined when data.lastAppliedName is not a string", () => {
		const entries: StateCandidateEntry[] = [
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: { lastAppliedName: 42 } },
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: { lastAppliedName: null } },
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: {} },
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: undefined },
		];
		expect(pickLatestState(entries)).toBeUndefined();
	});

	it("returns the most recent (last) matching entry", () => {
		const entries: StateCandidateEntry[] = [
			makeStateEntry("first"),
			makeStateEntry("second"),
			makeStateEntry("newest"),
		];
		const result = pickLatestState(entries);
		expect(result?.lastAppliedName).toBe("newest");
	});

	it("ignores other custom types interspersed with matching ones", () => {
		const entries: StateCandidateEntry[] = [
			makeStateEntry("old"),
			{ type: "custom", customType: "other:state", data: { lastAppliedName: "other" } },
			makeStateEntry("newer"),
			{ type: "custom", customType: "yet-another:state", data: { lastAppliedName: "yet-another" } },
		];
		const result = pickLatestState(entries);
		expect(result?.lastAppliedName).toBe("newer");
	});

	it("returns matching entry even when surrounded by non-custom entries", () => {
		const entries: StateCandidateEntry[] = [
			{ type: "user" },
			makeStateEntry("the-one"),
			{ type: "assistant" },
		];
		const result = pickLatestState(entries);
		expect(result?.lastAppliedName).toBe("the-one");
	});
});
