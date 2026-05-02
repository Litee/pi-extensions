import { describe, expect, it } from "vitest";

import { resolveClaudeDir } from "../src/resolve.js";

describe("resolveClaudeDir", () => {
	it("returns $CLAUDE_CONFIG_DIR when it is set to a non-empty string", () => {
		const result = resolveClaudeDir({ CLAUDE_CONFIG_DIR: "/custom/claude" }, "/home/user");
		expect(result).toBe("/custom/claude");
	});

	it("falls back to <home>/.claude when $CLAUDE_CONFIG_DIR is unset", () => {
		const result = resolveClaudeDir({}, "/home/user");
		expect(result).toBe("/home/user/.claude");
	});

	it("falls back to <home>/.claude when $CLAUDE_CONFIG_DIR is the empty string", () => {
		const result = resolveClaudeDir({ CLAUDE_CONFIG_DIR: "" }, "/home/user");
		expect(result).toBe("/home/user/.claude");
	});

	it("ignores unrelated environment entries", () => {
		const result = resolveClaudeDir({ PATH: "/usr/bin", HOME: "/elsewhere" }, "/home/user");
		expect(result).toBe("/home/user/.claude");
	});
});
