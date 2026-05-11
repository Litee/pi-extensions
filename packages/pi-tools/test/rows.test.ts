import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { buildToolRows, type RowTheme } from "../src/rows.js";

function mkTool(
	name: string,
	source: string,
	description = "",
	parameters: Record<string, unknown> = {},
): ToolInfo {
	return {
		name,
		description,
		parameters,
		sourceInfo: {
			source,
			path: source === "builtin" ? `<builtin:${name}>` : `/p/${name}.ts`,
			scope: "temporary",
			origin: "top-level",
		},
	} as ToolInfo;
}

// Pass-through theme: returns input unchanged, prefixed with a tag so we can
// verify the right styling calls were made without brittle ANSI assertions.
const theme: RowTheme = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
	bold: (text) => `<b>${text}</b>`,
};

const layout = { listRowWidth: 100, minDescWidth: 20 };

describe("buildToolRows", () => {
	it("emits groups in the fixed source order: builtin, sdk, extension, skill, unknown", () => {
		const tools = [
			mkTool("z-skill", "skill"),
			mkTool("a-ext", "extension"),
			mkTool("m-builtin", "builtin"),
			mkTool("q-sdk", "sdk"),
			mkTool("u-unknown", "unknown"),
		];
		const rows = buildToolRows(tools, new Set(), theme, layout);
		const headers = rows.filter((r) => r.toolName === undefined).map((r) => r.label);
		expect(headers).toEqual([
			"<dim>── builtin (1) ──</dim>",
			"<dim>── sdk (1) ──</dim>",
			"<dim>── extension (1) ──</dim>",
			"<dim>── skill (1) ──</dim>",
			"<dim>── unknown (1) ──</dim>",
		]);
	});

	it("skips empty groups (no header emitted for sources with zero tools)", () => {
		const tools = [mkTool("a", "builtin"), mkTool("b", "skill")];
		const rows = buildToolRows(tools, new Set(), theme, layout);
		const headers = rows.filter((r) => r.toolName === undefined).map((r) => r.label);
		expect(headers).toEqual(["<dim>── builtin (1) ──</dim>", "<dim>── skill (1) ──</dim>"]);
	});

	it("appends groups with unknown sources after the fixed order, preserving first-seen order", () => {
		const tools = [
			mkTool("a", "mystery-b"),
			mkTool("b", "builtin"),
			mkTool("c", "mystery-a"),
			mkTool("d", "mystery-b"),
		];
		const rows = buildToolRows(tools, new Set(), theme, layout);
		const headers = rows.filter((r) => r.toolName === undefined).map((r) => r.label);
		expect(headers[0]).toContain("builtin");
		// mystery-b appears first in the input, so it should come before mystery-a.
		expect(headers[1]).toContain("mystery-b");
		expect(headers[2]).toContain("mystery-a");
	});

	it("falls back to 'unknown' when sourceInfo is missing", () => {
		const tool = { name: "orphan", description: "", parameters: {} } as ToolInfo;
		const rows = buildToolRows([tool], new Set(), theme, layout);
		expect(rows[0]!.label).toContain("unknown (1)");
		expect(rows[1]!.toolName).toBe("orphan");
	});

	it("sorts tools within a group by name", () => {
		const tools = [
			mkTool("charlie", "builtin"),
			mkTool("alpha", "builtin"),
			mkTool("bravo", "builtin"),
		];
		const rows = buildToolRows(tools, new Set(), theme, layout);
		const names = rows.filter((r) => r.toolName).map((r) => r.toolName);
		expect(names).toEqual(["alpha", "bravo", "charlie"]);
	});

	it("marks active tools with ● (accent) and inactive with ○ (dim)", () => {
		const tools = [mkTool("on", "builtin"), mkTool("off", "builtin")];
		const rows = buildToolRows(tools, new Set(["on"]), theme, layout);
		const rowOn = rows.find((r) => r.toolName === "on")!;
		const rowOff = rows.find((r) => r.toolName === "off")!;
		expect(rowOn.label).toContain("<accent>●</accent>");
		expect(rowOff.label).toContain("<dim>○</dim>");
	});

	it("appends the first description line with ' — ' and truncates to the width budget", () => {
		const desc = "x".repeat(500);
		const tools = [mkTool("wide", "builtin", `${desc}\nSecond line ignored`)];
		const rows = buildToolRows(tools, new Set(), theme, layout);
		const row = rows.find((r) => r.toolName === "wide")!;
		expect(row.label).toContain("—");
		// Description should be truncated — our stub preserves the ellipsis.
		expect(row.label).toMatch(/…/);
	});

	it("omits the description tail when the first line is empty", () => {
		const tools = [mkTool("bare", "builtin", "")];
		const rows = buildToolRows(tools, new Set(), theme, layout);
		const row = rows.find((r) => r.toolName === "bare")!;
		expect(row.label).not.toContain("—");
	});

	it("respects minDescWidth even when the row budget would otherwise go negative", () => {
		const desc = "a short description";
		const tools = [mkTool("x".repeat(200), "builtin", desc)];
		const rows = buildToolRows(tools, new Set(), theme, {
			listRowWidth: 10, // absurdly small
			minDescWidth: desc.length + 5,
		});
		const row = rows.find((r) => r.toolName)!;
		// With a generous minDescWidth, the whole description should survive.
		expect(row.label).toContain(desc);
	});
});
