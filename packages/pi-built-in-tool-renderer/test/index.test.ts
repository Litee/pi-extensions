import { describe, expect, it, vi } from "vitest";

import createExtension, { __testCountLines, __testDescribeBashFailure, __testFormatDuration } from "../src/index.js";

// ---------------------------------------------------------------------------
// Smoke test for extension wiring + unit tests for the small bits of logic
// that we layered on top of the upstream example (inline timer + exit-code
// description). The renderer bodies themselves need a live pi-tui theme to
// exercise meaningfully, so those are covered by hand.
// ---------------------------------------------------------------------------

interface StubPi {
	registerTool: ReturnType<typeof vi.fn>;
	readonly tools: Map<string, { name: string; label: string; renderShell?: string }>;
}

function makeFakePi(): StubPi {
	const tools = new Map<string, { name: string; label: string; renderShell?: string }>();
	const registerTool = vi.fn((def: { name: string; label: string; renderShell?: string }) => {
		tools.set(def.name, def);
	});
	return { registerTool, tools };
}

describe("default export", () => {
	it("re-registers all seven built-in tools (read, bash, edit, write, grep, ls, find)", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		expect([...pi.tools.keys()].sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
	});

	it("all tools use the default boxed shell (no renderShell override)", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		for (const tool of pi.tools.values()) {
			expect(tool.renderShell).toBeUndefined();
		}
	});
});

describe("countLines", () => {
	it("returns 0 for the grep no-match sentinel", () => {
		expect(__testCountLines("No matches found")).toBe(0);
	});

	it("returns 0 for the find no-match sentinel", () => {
		expect(__testCountLines("No files found matching pattern")).toBe(0);
	});

	it("returns 0 for the ls empty sentinel", () => {
		expect(__testCountLines("(empty directory)")).toBe(0);
	});

	it("returns 0 for an empty string", () => {
		expect(__testCountLines("")).toBe(0);
	});

	it("counts non-empty lines in multi-line output", () => {
		expect(__testCountLines("a\nb\nc")).toBe(3);
	});

	it("ignores trailing blank lines", () => {
		expect(__testCountLines("a\nb\n\n")).toBe(2);
	});

	it("counts a single result as 1", () => {
		expect(__testCountLines("src/index.ts:1: foo")).toBe(1);
	});
});

describe("formatDuration", () => {
	it("renders whole and sub-second values to one decimal", () => {
		expect(__testFormatDuration(0)).toBe("0.0s");
		expect(__testFormatDuration(1234)).toBe("1.2s");
		expect(__testFormatDuration(59999)).toBe("60.0s");
	});
});

describe("describeBashFailure", () => {
	it("parses a non-zero exit from the built-in bash.js sentinel", () => {
		expect(__testDescribeBashFailure("stderr...\n\nCommand exited with code 1")).toBe("exit 1");
		expect(__testDescribeBashFailure("stderr...\n\nCommand exited with code 137")).toBe("exit 137");
		expect(__testDescribeBashFailure("Command exited with code -1")).toBe("exit -1");
	});

	it("parses the timeout sentinel and keeps the seconds value", () => {
		expect(__testDescribeBashFailure("partial output\nCommand timed out after 30 seconds")).toBe("timeout 30s");
	});

	it("recognises the abort sentinel", () => {
		expect(__testDescribeBashFailure("partial...\nCommand aborted")).toBe("aborted");
	});

	it("falls back to 'failed' when no sentinel matches", () => {
		expect(__testDescribeBashFailure("some generic error text")).toBe("failed");
		expect(__testDescribeBashFailure("")).toBe("failed");
	});
});
