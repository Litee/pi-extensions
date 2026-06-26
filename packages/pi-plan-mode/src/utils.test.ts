import { describe, expect, it } from "vitest";
import { computePlanModeTools, PLAN_MODE_DISABLED_TOOLS } from "./utils.js";

describe("computePlanModeTools", () => {
	const basics = ["read", "bash", "grep", "find", "ls", "ask_user_question"];

	it("removes edit and write from a standard full tool set", () => {
		const active = ["read", "bash", "edit", "write", "grep", "find", "ls"];
		const result = computePlanModeTools(active, basics);
		expect(result).not.toContain("edit");
		expect(result).not.toContain("write");
	});

	it("keeps third-party tools that are not in the disabled set", () => {
		// This was the bug: the old code replaced the entire list with PLAN_MODE_TOOLS,
		// silently dropping any user-added tools (e.g. MCP servers).
		const active = ["read", "bash", "edit", "write", "my-mcp-tool", "grep"];
		const result = computePlanModeTools(active, basics);
		expect(result).toContain("my-mcp-tool");
		expect(result).not.toContain("edit");
		expect(result).not.toContain("write");
	});

	it("always includes all plan-mode basics even when missing from active set", () => {
		const active = ["read", "bash"]; // missing grep, find, ls, ask_user_question
		const result = computePlanModeTools(active, basics);
		for (const t of basics) {
			expect(result).toContain(t);
		}
	});

	it("does not duplicate basics that are already in active set", () => {
		const active = ["read", "bash", "grep", "find", "ls", "ask_user_question"];
		const result = computePlanModeTools(active, basics);
		const counts = new Map<string, number>();
		for (const t of result) {
			counts.set(t, (counts.get(t) ?? 0) + 1);
		}
		for (const t of basics) {
			expect(counts.get(t)).toBe(1);
		}
	});

	it("handles an empty active tool set (fallback to basics)", () => {
		const result = computePlanModeTools([], basics);
		expect(result).toEqual(basics);
	});

	it("handles active set that has no write tools (no-op on disable side)", () => {
		const active = ["read", "bash", "grep", "find", "ls", "ask_user_question", "brave-search"];
		const result = computePlanModeTools(active, basics);
		expect(result).toContain("brave-search");
		expect(result).not.toContain("edit");
		expect(result).not.toContain("write");
	});

	it("accepts a custom disabled-tools set for extensibility", () => {
		const active = ["read", "bash", "edit", "write", "danger-tool"];
		const custom = new Set(["edit", "write", "danger-tool"]);
		const result = computePlanModeTools(active, basics, custom);
		expect(result).not.toContain("danger-tool");
		expect(result).not.toContain("edit");
		expect(result).not.toContain("write");
	});

	it("PLAN_MODE_DISABLED_TOOLS contains exactly edit and write", () => {
		expect(PLAN_MODE_DISABLED_TOOLS.has("edit")).toBe(true);
		expect(PLAN_MODE_DISABLED_TOOLS.has("write")).toBe(true);
		expect(PLAN_MODE_DISABLED_TOOLS.size).toBe(2);
	});
});
