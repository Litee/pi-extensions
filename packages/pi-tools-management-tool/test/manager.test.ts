import { describe, expect, it } from "vitest";

import { computeNext } from "../src/manager.js";

const KNOWN = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "manage_tools"]);
const PROTECTED = new Set(["manage_tools"]);

function setOf(...xs: string[]): Set<string> {
	return new Set(xs);
}

describe("computeNext — activate", () => {
	it("adds one name to the active set", () => {
		const out = computeNext({
			action: "activate",
			tools: ["edit"],
			currentActive: setOf("read", "bash"),
			startupActive: setOf("read", "bash"),
			knownTools: KNOWN,
			protectedTools: PROTECTED,
		});
		expect(out.nextActive).toEqual(setOf("read", "bash", "edit"));
		expect(out.ignoredUnknown).toEqual([]);
	});

	it("adds multiple names in one call", () => {
		const out = computeNext({
			action: "activate",
			tools: ["edit", "write", "grep"],
			currentActive: setOf("read"),
			startupActive: setOf("read"),
			knownTools: KNOWN,
			protectedTools: PROTECTED,
		});
		expect(out.nextActive).toEqual(setOf("read", "edit", "write", "grep"));
	});

	it("is idempotent (activating an already-active name is a no-op)", () => {
		const out = computeNext({
			action: "activate",
			tools: ["read", "read"],
			currentActive: setOf("read", "bash"),
			startupActive: setOf("read", "bash"),
			knownTools: KNOWN,
			protectedTools: PROTECTED,
		});
		expect(out.nextActive).toEqual(setOf("read", "bash"));
		expect(out.ignoredUnknown).toEqual([]);
	});

	it("silently drops unknown names, surfacing them via ignoredUnknown", () => {
		const out = computeNext({
			action: "activate",
			tools: ["edit", "does_not_exist", "also_missing"],
			currentActive: setOf("read"),
			startupActive: setOf("read"),
			knownTools: KNOWN,
			protectedTools: PROTECTED,
		});
		expect(out.nextActive).toEqual(setOf("read", "edit"));
		expect(out.ignoredUnknown.sort()).toEqual(["also_missing", "does_not_exist"]);
	});

	it("empty tools list leaves the active set unchanged", () => {
		const out = computeNext({
			action: "activate",
			tools: [],
			currentActive: setOf("read", "bash"),
			startupActive: setOf("read", "bash"),
			knownTools: KNOWN,
			protectedTools: PROTECTED,
		});
		expect(out.nextActive).toEqual(setOf("read", "bash"));
	});

	it("missing tools field treated as empty list", () => {
		const out = computeNext({
			action: "activate",
			currentActive: setOf("read"),
			startupActive: setOf("read"),
			knownTools: KNOWN,
			protectedTools: PROTECTED,
		});
		expect(out.nextActive).toEqual(setOf("read"));
	});
});

describe("computeNext — deactivate", () => {
	it("removes one name", () => {
		const out = computeNext({
			action: "deactivate",
			tools: ["edit"],
			currentActive: setOf("read", "bash", "edit"),
			startupActive: setOf("read", "bash", "edit"),
			knownTools: KNOWN,
			protectedTools: PROTECTED,
		});
		expect(out.nextActive).toEqual(setOf("read", "bash"));
	});

	it("removes multiple names in one call", () => {
		const out = computeNext({
			action: "deactivate",
			tools: ["edit", "write"],
			currentActive: setOf("read", "bash", "edit", "write"),
			startupActive: setOf("read", "bash", "edit", "write"),
			knownTools: KNOWN,
			protectedTools: PROTECTED,
		});
		expect(out.nextActive).toEqual(setOf("read", "bash"));
	});

	it("refuses to deactivate protected tools (surfaces via ignoredProtected)", () => {
		const out = computeNext({
			action: "deactivate",
			tools: ["manage_tools", "edit"],
			currentActive: setOf("read", "edit", "manage_tools"),
			startupActive: setOf("read", "edit", "manage_tools"),
			knownTools: KNOWN,
			protectedTools: PROTECTED,
		});
		expect(out.nextActive).toEqual(setOf("read", "manage_tools"));
		expect(out.ignoredProtected).toEqual(["manage_tools"]);
	});

	it("silently drops unknown names", () => {
		const out = computeNext({
			action: "deactivate",
			tools: ["edit", "nosuch"],
			currentActive: setOf("read", "edit"),
			startupActive: setOf("read", "edit"),
			knownTools: KNOWN,
			protectedTools: PROTECTED,
		});
		expect(out.nextActive).toEqual(setOf("read"));
		expect(out.ignoredUnknown).toEqual(["nosuch"]);
	});

	it("deactivating an inactive name is a no-op", () => {
		const out = computeNext({
			action: "deactivate",
			tools: ["write"],
			currentActive: setOf("read"),
			startupActive: setOf("read"),
			knownTools: KNOWN,
			protectedTools: PROTECTED,
		});
		expect(out.nextActive).toEqual(setOf("read"));
	});
});

describe("computeNext — reset", () => {
	it("restores the startup snapshot exactly", () => {
		const out = computeNext({
			action: "reset",
			currentActive: setOf("read"),
			startupActive: setOf("read", "bash", "manage_tools"),
			knownTools: KNOWN,
			protectedTools: PROTECTED,
		});
		expect(out.nextActive).toEqual(setOf("read", "bash", "manage_tools"));
	});

	it("restores the startup snapshot even if it trims previously-activated tools", () => {
		const out = computeNext({
			action: "reset",
			currentActive: setOf("read", "bash", "edit", "write"),
			startupActive: setOf("read", "manage_tools"),
			knownTools: KNOWN,
			protectedTools: PROTECTED,
		});
		expect(out.nextActive).toEqual(setOf("read", "manage_tools"));
	});

	it("always includes protected names in the reset result", () => {
		// startup snapshot accidentally excludes manage_tools — reset must re-add it.
		const out = computeNext({
			action: "reset",
			currentActive: setOf("read"),
			startupActive: setOf("read"),
			knownTools: KNOWN,
			protectedTools: PROTECTED,
		});
		expect(out.nextActive).toEqual(setOf("read", "manage_tools"));
	});

	it("ignores the tools field on reset", () => {
		const out = computeNext({
			action: "reset",
			tools: ["does", "not", "matter"],
			currentActive: setOf("read"),
			startupActive: setOf("read", "bash", "manage_tools"),
			knownTools: KNOWN,
			protectedTools: PROTECTED,
		});
		expect(out.nextActive).toEqual(setOf("read", "bash", "manage_tools"));
	});
});

describe("computeNext — list", () => {
	it("does not produce a nextActive (list is a pure query)", () => {
		const out = computeNext({
			action: "list",
			currentActive: setOf("read", "bash"),
			startupActive: setOf("read", "bash"),
			knownTools: KNOWN,
			protectedTools: PROTECTED,
		});
		expect(out.nextActive).toBeUndefined();
	});
});
