import { describe, expect, it, vi } from "vitest";

import createExtension, { __testDescribeBashFailure, __testFormatDuration } from "../src/index.js";

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
	it("re-registers the four built-in tools (read, bash, edit, write)", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		expect([...pi.tools.keys()].sort()).toEqual(["bash", "edit", "read", "write"]);
	});

	it("flags the edit tool with renderShell: 'self' so it owns its outer frame", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		expect(pi.tools.get("edit")?.renderShell).toBe("self");
		// Other tools intentionally leave renderShell undefined — they use the
		// default boxed shell.
		expect(pi.tools.get("read")?.renderShell).toBeUndefined();
		expect(pi.tools.get("bash")?.renderShell).toBeUndefined();
		expect(pi.tools.get("write")?.renderShell).toBeUndefined();
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
