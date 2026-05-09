import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { pickSavedTools } from "../src/branchState.js";

function customEntry(id: string, customType: string, data: unknown, parentId: string | null = null): SessionEntry {
	return {
		id,
		parentId,
		timestamp: 0,
		type: "custom",
		customType,
		data,
	} as unknown as SessionEntry;
}

describe("pickSavedTools", () => {
	it("returns undefined when the branch is empty", () => {
		expect(pickSavedTools([])).toBeUndefined();
	});

	it("returns undefined when no tools-config custom entry is present", () => {
		const entries: SessionEntry[] = [customEntry("1", "other", { foo: 1 })];
		expect(pickSavedTools(entries)).toBeUndefined();
	});

	it("returns the enabledTools list from a tools-config entry", () => {
		const entries = [customEntry("1", "tools-config", { enabledTools: ["a", "b"] })];
		expect(pickSavedTools(entries)).toEqual(["a", "b"]);
	});

	it("uses the last tools-config entry when several are present (newest-wins for a flat branch)", () => {
		const entries = [
			customEntry("1", "tools-config", { enabledTools: ["old"] }),
			customEntry("2", "tools-config", { enabledTools: ["new"] }),
		];
		expect(pickSavedTools(entries)).toEqual(["new"]);
	});

	it("ignores tools-config entries whose data has no enabledTools field", () => {
		const entries = [
			customEntry("1", "tools-config", { enabledTools: ["keep"] }),
			customEntry("2", "tools-config", { other: true }),
		];
		expect(pickSavedTools(entries)).toEqual(["keep"]);
	});

	it("ignores non-custom entries", () => {
		const junk = { id: "x", type: "message", parentId: null, timestamp: 0 } as unknown as SessionEntry;
		const entries = [junk, customEntry("1", "tools-config", { enabledTools: ["ok"] })];
		expect(pickSavedTools(entries)).toEqual(["ok"]);
	});

	it("returns an empty array when the saved list was empty (distinct from missing state)", () => {
		const entries = [customEntry("1", "tools-config", { enabledTools: [] })];
		expect(pickSavedTools(entries)).toEqual([]);
	});
});
