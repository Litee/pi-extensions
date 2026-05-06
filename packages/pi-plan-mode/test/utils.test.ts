import { describe, expect, it } from "vitest";

import { cleanStepText, extractDoneSteps, extractTodoItems, isSafeCommand } from "../src/utils.js";

// ---------------------------------------------------------------------------
// Smoke tests only — the source lives upstream at
// https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/plan-mode
// and any meaningful coverage should land there. These cases guard against
// regressions caused by a sloppy re-sync.
// ---------------------------------------------------------------------------

describe("isSafeCommand", () => {
	it("allows read-only commands from the allowlist", () => {
		expect(isSafeCommand("ls -la")).toBe(true);
		expect(isSafeCommand("cat README.md")).toBe(true);
		expect(isSafeCommand("git status")).toBe(true);
		expect(isSafeCommand("rg foo src/")).toBe(true);
	});

	it("blocks destructive commands even when a safe prefix is present", () => {
		expect(isSafeCommand("rm -rf node_modules")).toBe(false);
		expect(isSafeCommand("git commit -am wip")).toBe(false);
		expect(isSafeCommand("sudo ls")).toBe(false);
		// Redirect to file — blocked by the `>` pattern
		expect(isSafeCommand("echo hi > /tmp/x")).toBe(false);
	});

	it("rejects commands that are neither allow-listed nor destructive", () => {
		expect(isSafeCommand("someRandomBinary --help")).toBe(false);
	});
});

describe("extractTodoItems", () => {
	it("pulls numbered steps under a Plan: header and cleans them", () => {
		const msg = [
			"Here is what I propose.",
			"",
			"Plan:",
			"1. Run the linter",
			"2. **Fix any errors**",
			"3. Commit the change",
		].join("\n");

		const items = extractTodoItems(msg);
		expect(items).toHaveLength(3);
		expect(items[0]).toEqual({ step: 1, text: "Linter", completed: false });
		// Leading "Fix" is stripped by cleanStepText
		expect(items[1]?.text.toLowerCase()).toContain("any errors");
		expect(items[2]?.completed).toBe(false);
	});

	it("returns [] when there is no Plan: header", () => {
		expect(extractTodoItems("just some prose, no plan here")).toEqual([]);
	});
});

describe("extractDoneSteps", () => {
	it("pulls integer step numbers from [DONE:n] markers anywhere in the text", () => {
		expect(extractDoneSteps("doing things [DONE:1] more stuff [done:3]")).toEqual([1, 3]);
	});

	it("ignores malformed markers", () => {
		expect(extractDoneSteps("[DONE:foo] [DONE] nothing")).toEqual([]);
	});
});

describe("cleanStepText", () => {
	it("strips markdown emphasis and leading imperatives", () => {
		expect(cleanStepText("**Run the tests**")).toBe("Tests");
		// "Create " is stripped (the optional "(the\s+)?" doesn't match "a ")
		expect(cleanStepText("Create a new file `foo.ts`")).toBe("A new file foo.ts");
	});

	it("truncates overly long steps to 50 chars with an ellipsis", () => {
		const long = `x`.repeat(80);
		const cleaned = cleanStepText(long);
		expect(cleaned.length).toBe(50);
		expect(cleaned.endsWith("...")).toBe(true);
	});
});
