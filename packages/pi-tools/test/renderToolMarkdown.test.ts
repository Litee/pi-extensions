import type { ToolInfo } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { renderToolMarkdown } from "../src/renderToolMarkdown.js";

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

describe("renderToolMarkdown", () => {
	it("marks active tools with ✅ and inactive with ⛔", () => {
		const tool = mkTool({ name: "read", description: "Reads files" });
		expect(renderToolMarkdown(tool, new Set(["read"]))).toContain("✅ active");
		expect(renderToolMarkdown(tool, new Set())).toContain("⛔ inactive");
	});

	it("substitutes a placeholder when description is empty or whitespace", () => {
		const tool = mkTool({ name: "noop", description: "   " });
		expect(renderToolMarkdown(tool, new Set())).toContain("_(no description)_");
	});

	it("includes the rendered source label and token estimate", () => {
		const tool = mkTool({ name: "read", description: "x" });
		const md = renderToolMarkdown(tool, new Set());
		expect(md).toMatch(/\*\*Source:\*\* builtin/);
		expect(md).toMatch(/\*\*Tokens:\*\* ~\d+/);
	});

	it("wraps the JSON schema in a fenced json block", () => {
		const tool = mkTool({ name: "x", parameters: { a: 1 } });
		const md = renderToolMarkdown(tool, new Set());
		expect(md).toContain("```json");
		expect(md).toContain('"a": 1');
		expect(md).toContain("```");
	});

	it("does not throw on non-serializable parameters", () => {
		const cyclic: Record<string, unknown> = { a: 1 };
		cyclic["self"] = cyclic;
		const tool = mkTool({ name: "x", parameters: cyclic });
		expect(() => renderToolMarkdown(tool, new Set())).not.toThrow();
	});

	it("starts with a level-2 heading containing the tool name", () => {
		const tool = mkTool({ name: "grep" });
		expect(renderToolMarkdown(tool, new Set())).toMatch(/^## grep\s/);
	});
});
