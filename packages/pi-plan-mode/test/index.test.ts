import { describe, expect, it, vi } from "vitest";

import planModeExtension from "../src/index.js";

/**
 * Minimal stub of the pi ExtensionAPI surface consumed by `planModeExtension`
 * at registration time. `createExtension` only calls `registerFlag`,
 * `registerCommand`, `registerShortcut`, and `on` synchronously during init;
 * `getFlag`, `setActiveTools`, `appendEntry`, `sendMessage`,
 * `sendUserMessage`, `setBashAllowlist`, `setPrompt`, `setThinkingLevel`, and
 * `setActiveTools` only run from inside handlers we don't fire here.
 */
function makeFakePi() {
	return {
		registerFlag: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		on: vi.fn(),
	};
}

describe("plan-mode extension registration", () => {
	it("binds both Ctrl+Alt+P and Shift+Tab to the plan-mode toggle shortcut", () => {
		const pi = makeFakePi();
		planModeExtension(pi as never);

		// At least the two toggle bindings must be registered. (The extension
		// may register more shortcuts in the future — we only care that the
		// two toggle keys are present and each has a handler.)
		expect(pi.registerShortcut).toHaveBeenCalledTimes(2);

		const calls = pi.registerShortcut.mock.calls as Array<
			[string, { description: string; handler: (ctx: unknown) => unknown }]
		>;
		const keys = calls.map(([key]) => key);

		expect(keys).toContain("ctrl+alt+p");
		expect(keys).toContain("shift+tab");

		// Both bindings target the same toggle action — sanity check the
		// descriptions and that each has a callable handler.
		for (const [, opts] of calls) {
			expect(opts.description.toLowerCase()).toContain("plan");
			expect(typeof opts.handler).toBe("function");
		}
	});
});
