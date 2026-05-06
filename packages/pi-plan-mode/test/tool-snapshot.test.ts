import { describe, expect, it } from "vitest";

import { ToolSnapshot } from "../src/tool-snapshot.js";

describe("ToolSnapshot", () => {
	it("restore returns fallback when nothing has been saved", () => {
		const snap = new ToolSnapshot();
		expect(snap.restore(["read", "bash", "edit", "write"])).toEqual(["read", "bash", "edit", "write"]);
	});

	it("restore returns saved tools and clears the snapshot", () => {
		const snap = new ToolSnapshot();
		snap.save(["read", "bash", "edit", "write", "find", "grep", "ls"]);
		expect(snap.restore(["read", "bash"])).toEqual(["read", "bash", "edit", "write", "find", "grep", "ls"]);
		// After restore, snapshot is cleared — second restore falls back
		expect(snap.restore(["read", "bash"])).toEqual(["read", "bash"]);
	});

	it("save stores a copy so later mutations to the source array do not affect the snapshot", () => {
		const snap = new ToolSnapshot();
		const tools = ["read", "bash"];
		snap.save(tools);
		tools.push("edit");
		expect(snap.restore([])).toEqual(["read", "bash"]);
	});

	it("hasSaved returns false initially and true after save, false again after restore", () => {
		const snap = new ToolSnapshot();
		expect(snap.hasSaved()).toBe(false);
		snap.save(["read"]);
		expect(snap.hasSaved()).toBe(true);
		snap.restore([]);
		expect(snap.hasSaved()).toBe(false);
	});
});
