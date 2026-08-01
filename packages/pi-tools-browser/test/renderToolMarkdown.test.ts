import type { ToolInfo } from "@earendil-works/pi-coding-agent";
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

	it("handles description being undefined (?.) nullish branch", () => {
		const tool = { name: "x", description: undefined, parameters: {} } as unknown as ToolInfo;
		const md = renderToolMarkdown(tool, new Set());
		expect(md).toContain("_(no description)_");
	});

	it("handles parameters being undefined (?? nullish branch)", () => {
		const tool = { name: "x", description: "test", parameters: undefined } as unknown as ToolInfo;
		const md = renderToolMarkdown(tool, new Set());
		expect(md).toContain("```json");
		expect(md).not.toContain("[schema unavailable]");
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

describe("renderToolMarkdown — inPrompt annotation", () => {
	const tool = mkTool({ name: "bash", description: "Run commands" });

	it("omits the In-prompt line when inPrompt is not provided", () => {
		const md = renderToolMarkdown(tool, new Set());
		expect(md).not.toContain("**In prompt:**");
	});

	it("shows 'yes' when inPrompt is provided and tool is in the set", () => {
		const md = renderToolMarkdown(tool, new Set(), new Set(["bash"]));
		expect(md).toContain("**In prompt:** ✓ yes");
		expect(md).not.toContain("✗ no");
	});

	it("shows 'no' when inPrompt is provided but tool is absent from the set", () => {
		const md = renderToolMarkdown(tool, new Set(), new Set());
		expect(md).toContain("**In prompt:** ✗ no");
		expect(md).not.toContain("✓ yes");
	});

	it("In-prompt annotation is on the same metadata line as Source and Tokens", () => {
		const md = renderToolMarkdown(tool, new Set(["bash"]), new Set(["bash"]));
		const metaLine = md.split("\n").find((l) => l.includes("**Source:**"))!;
		expect(metaLine).toMatch(/\*\*Source:\*\*.*\*\*Tokens:\*\*.*\*\*In prompt:\*\*/);
	});

	it("in-prompt annotation is independent of active/inactive status", () => {
		// active + in prompt
		const md1 = renderToolMarkdown(tool, new Set(["bash"]), new Set(["bash"]));
		expect(md1).toContain("✅ active");
		expect(md1).toContain("✓ yes");

		// inactive + in prompt
		const md2 = renderToolMarkdown(tool, new Set(), new Set(["bash"]));
		expect(md2).toContain("⛔ inactive");
		expect(md2).toContain("✓ yes");

		// active + not in prompt
		const md3 = renderToolMarkdown(tool, new Set(["bash"]), new Set());
		expect(md3).toContain("✅ active");
		expect(md3).toContain("✗ no");

		// inactive + not in prompt
		const md4 = renderToolMarkdown(tool, new Set(), new Set());
		expect(md4).toContain("⛔ inactive");
		expect(md4).toContain("✗ no");
	});

	it("gracefully falls back (no annotation) when inPrompt is undefined", () => {
		// Simulates older pi where getSystemPromptOptions() does not exist.
		const md = renderToolMarkdown(tool, new Set(["bash"]), undefined);
		expect(md).not.toContain("**In prompt:**");
		// Should still render all other fields correctly.
		expect(md).toContain("✅ active");
		expect(md).toContain("**Source:**");
		expect(md).toContain("**Tokens:**");
	});
});
