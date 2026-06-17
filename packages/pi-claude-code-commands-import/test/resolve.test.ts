import { describe, expect, it } from "vitest";

import { resolveClaudeDir } from "../src/resolve.js";

describe("resolveClaudeDir", () => {
	it("returns <home>/.claude when no env override is set", () => {
		expect(resolveClaudeDir({}, "/home/user")).toBe("/home/user/.claude");
	});

	it("returns the $CLAUDE_CONFIG_DIR value when it is a non-empty string", () => {
		expect(
			resolveClaudeDir({ CLAUDE_CONFIG_DIR: "/custom/claude" }, "/home/user"),
		).toBe("/custom/claude");
	});

	it("falls back to the default when the override is the empty string", () => {
		expect(resolveClaudeDir({ CLAUDE_CONFIG_DIR: "" }, "/home/user")).toBe(
			"/home/user/.claude",
		);
	});

	it("uses the supplied home argument, not process.env.HOME", () => {
		expect(resolveClaudeDir({}, "/tmp/testuser")).toBe("/tmp/testuser/.claude");
	});

	it("applies join semantics so no trailing slash is added", () => {
		const result = resolveClaudeDir({}, "/home/user");
		expect(result.endsWith("/")).toBe(false);
	});
});
