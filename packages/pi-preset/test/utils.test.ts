import { describe, expect, it } from "vitest";

import { formatToolList } from "../src/utils.js";

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
