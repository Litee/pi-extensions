import { describe, expect, it } from "vitest";

import { applyToggle } from "../src/toggle.js";

describe("applyToggle", () => {
	it("adds id to the set when newValue is 'disabled'", () => {
		const set = new Set<string>();
		const result = applyToggle("a", "disabled", set);
		expect(result.changed).toBe(true);
		expect([...set]).toEqual(["a"]);
	});

	it("is a no-op when disabling an already-disabled id (changed=false)", () => {
		const set = new Set<string>(["a"]);
		const result = applyToggle("a", "disabled", set);
		expect(result.changed).toBe(false);
		expect([...set]).toEqual(["a"]);
	});

	it("removes id from the set when newValue is 'enabled'", () => {
		const set = new Set<string>(["a", "b"]);
		const result = applyToggle("a", "enabled", set);
		expect(result.changed).toBe(true);
		expect([...set].sort()).toEqual(["b"]);
	});

	it("is a no-op when enabling an already-enabled id (changed=false)", () => {
		const set = new Set<string>(["b"]);
		const result = applyToggle("a", "enabled", set);
		expect(result.changed).toBe(false);
		expect([...set]).toEqual(["b"]);
	});

	it("mutates the input set in place", () => {
		const set = new Set<string>();
		applyToggle("x", "disabled", set);
		expect(set.has("x")).toBe(true);
	});
});
