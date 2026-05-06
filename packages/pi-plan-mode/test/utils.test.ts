import { describe, expect, it } from "vitest";

import { formatToolList, isSafeCommand } from "../src/utils.js";

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

describe("formatToolList", () => {
	it("lists all tools when count is at or below 10", () => {
		const tools = ["read", "bash", "grep", "find", "ls", "ask_user_question"];
		expect(formatToolList(tools)).toBe("Tools: read, bash, grep, find, ls, ask_user_question");
	});

	it("shows exactly 10 tools and appends a total-count note when count exceeds 10", () => {
		const tools = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11", "t12"];
		expect(formatToolList(tools)).toBe("Tools: t1, t2, t3, t4, t5, t6, t7, t8, t9, t10 (12 total)");
	});

	it("shows exactly 10 tools with an 11-total note when count is exactly 11", () => {
		const tools = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11"];
		expect(formatToolList(tools)).toBe("Tools: t1, t2, t3, t4, t5, t6, t7, t8, t9, t10 (11 total)");
	});

	it("handles an empty list without crashing", () => {
		expect(formatToolList([])).toBe("Tools: ");
	});
});
