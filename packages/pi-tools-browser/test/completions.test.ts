import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { COMPLETION_DESC_WIDTH, getToolArgumentCompletions } from "../src/completions.js";

function mkTool(partial: Partial<ToolInfo> & { name: string }): ToolInfo {
	return {
		name: partial.name,
		description: partial.description ?? "",
		parameters: partial.parameters ?? {},
		sourceInfo:
			partial.sourceInfo ?? {
				source: "builtin",
				path: `<builtin:${partial.name}>`,
				scope: "temporary",
				origin: "top-level",
			},
	} as ToolInfo;
}

describe("getToolArgumentCompletions", () => {
	const tools = [
		mkTool({ name: "read", description: "Read a file from disk" }),
		mkTool({ name: "readlink", description: "" }),
		mkTool({ name: "write", description: "First line description\nSecond line ignored" }),
		mkTool({ name: "bash" }),
	];

	it("always offers --all along with tool names when prefix is empty", () => {
		const result = getToolArgumentCompletions("", tools);
		expect(result).not.toBeNull();
		const values = result!.map((c) => c.value);
		expect(values).toContain("--all");
		expect(values).toContain("read");
		expect(values).toContain("write");
	});

	it("filters candidates by prefix", () => {
		const result = getToolArgumentCompletions("rea", tools);
		expect(result!.map((c) => c.value).sort()).toEqual(["read", "readlink"]);
	});

	it("returns null when nothing matches", () => {
		expect(getToolArgumentCompletions("zzz", tools)).toBeNull();
	});

	it("matches --all when prefix starts with '--'", () => {
		const result = getToolArgumentCompletions("--", tools);
		expect(result!.map((c) => c.value)).toEqual(["--all"]);
	});

	it("includes description from the first description line only", () => {
		const result = getToolArgumentCompletions("write", tools);
		expect(result![0]!.description).toBe("First line description");
	});

	it("omits description when the tool has none or is --all", () => {
		const result = getToolArgumentCompletions("bas", tools);
		expect(result![0]!.description).toBeUndefined();
		const allOnly = getToolArgumentCompletions("--", tools);
		expect(allOnly![0]!.description).toBeUndefined();
	});

	it("truncates long descriptions to COMPLETION_DESC_WIDTH", () => {
		const longDesc = "x".repeat(COMPLETION_DESC_WIDTH * 2);
		const result = getToolArgumentCompletions("long", [mkTool({ name: "long", description: longDesc })]);
		expect(result![0]!.description!.length).toBeLessThanOrEqual(COMPLETION_DESC_WIDTH);
		expect(result![0]!.description).toMatch(/…$/);
	});

	it("omits description when the first line is whitespace only", () => {
		const result = getToolArgumentCompletions("ws", [mkTool({ name: "ws", description: "\nreal body" })]);
		// First split line is "" → falsy → no description field.
		expect(result![0]!.description).toBeUndefined();
	});
});
