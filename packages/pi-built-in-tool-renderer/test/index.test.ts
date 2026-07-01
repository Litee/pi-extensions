import { describe, expect, it, vi } from "vitest";

import createExtension from "../src/index.js";

// ---------------------------------------------------------------------------
// Smoke test for extension wiring. Renderer / helper behaviour is covered
// directly by renderers.test.ts and helpers.test.ts; this file only asserts
// that the default export registers the expected six built-in tools with
// the default boxed shell.
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
	it("re-registers six built-in tools (read, bash, write, grep, ls, find — edit delegated to pi-diff)", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		expect([...pi.tools.keys()].sort()).toEqual(["bash", "find", "grep", "ls", "read", "write"]);
	});

	it("all tools use the default boxed shell (no renderShell override)", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		for (const tool of pi.tools.values()) {
			expect(tool.renderShell).toBeUndefined();
		}
	});
});
