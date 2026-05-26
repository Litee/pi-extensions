import { describe, it, expect } from "vitest";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { formatCommands } from "../src/commandsTool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCommand(
	name: string,
	description?: string,
): SlashCommandInfo {
	const base = {
		name,
		source: "extension" as const,
		sourceInfo: {
			path: "/fake/extension.ts",
			source: "test",
			scope: "user" as const,
			origin: "top-level" as const,
		},
	};
	return description !== undefined ? { ...base, description } : base;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe("formatCommands", () => {
	it("empty commands list → shows zero total and no-commands message", () => {
		const result = formatCommands([]);

		expect(result).toContain("## Registered Slash Commands");
		expect(result).toContain("**Total:** 0 commands");
		expect(result).toContain("(no commands registered)");
	});

	it("single command uses singular 'command'", () => {
		const result = formatCommands([makeCommand("help", "Show help")]);

		expect(result).toContain("**Total:** 1 command");
		expect(result).not.toContain("1 commands");
	});

	it("command with description → shows name and description", () => {
		const result = formatCommands([makeCommand("plan", "Manage the current plan")]);

		expect(result).toContain("**/plan**");
		expect(result).toContain("Manage the current plan");
	});

	it("command without description → shows (no description)", () => {
		const result = formatCommands([makeCommand("debug")]);

		expect(result).toContain("**/debug**");
		expect(result).toContain("(no description)");
	});

	it("multiple commands → all listed with correct count", () => {
		const commands: SlashCommandInfo[] = [
			makeCommand("plan", "Manage the plan"),
			makeCommand("goal", "Set the goal"),
			makeCommand("reload"),
		];

		const result = formatCommands(commands);

		expect(result).toContain("**Total:** 3 commands");
		expect(result).toContain("**/plan**");
		expect(result).toContain("Manage the plan");
		expect(result).toContain("**/goal**");
		expect(result).toContain("Set the goal");
		expect(result).toContain("**/reload**");
		expect(result).toContain("(no description)");
	});

	it("mix of commands with and without descriptions → each rendered correctly", () => {
		const commands: SlashCommandInfo[] = [
			makeCommand("compact", "Compact the session"),
			makeCommand("mystery"),
		];

		const result = formatCommands(commands);

		expect(result).toContain("**Total:** 2 commands");
		expect(result).toContain("Compact the session");
		expect(result).toContain("(no description)");
	});
});
