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
function makeFakePi(activeTools: string[] = []) {
	const tools = [...activeTools];
	return {
		registerFlag: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		on: vi.fn(),
		getActiveTools: vi.fn(() => tools),
		setActiveTools: vi.fn(),
		appendEntry: vi.fn(),
	};
}

function makeFakeCtx() {
	return {
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			theme: { fg: vi.fn((_color: string, text: string) => text) },
		},
		hasUI: true,
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

describe("plan-mode exit notification", () => {
	it("notifies with restored tool count and a sample when toggling out of plan mode", async () => {
		// Arrange — set up pi with a realistic normal-mode tool set (>10 to test sampling)
		const normalTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "brave_search", "ask_user_question", "run_tests", "diff_apply", "symbol_search"];
		const pi = makeFakePi(normalTools);
		const ctx = makeFakeCtx();
		planModeExtension(pi as never);

		// Grab the /plan command handler
		const commandCalls = pi.registerCommand.mock.calls as Array<
			[string, { handler: (args: unknown, ctx: unknown) => Promise<void> }]
		>;
		const planCommand = commandCalls.find(([name]) => name === "plan");
		expect(planCommand).toBeDefined();
		const handler = planCommand![1].handler;

		// Act — first toggle enters plan mode, second toggle exits
		await handler({}, ctx);  // enter plan mode
		await handler({}, ctx);  // exit plan mode

		// Assert — the second notify call must mention the tool count and include tool names
		const notifyCalls = ctx.ui.notify.mock.calls as Array<[string]>;
		expect(notifyCalls.length).toBeGreaterThanOrEqual(2);

		const exitMessage = notifyCalls[1]![0];
		// Must mention the total tool count (12 tools)
		expect(exitMessage).toContain("12");
		// Must include at least one tool name from the sample
		expect(exitMessage).toMatch(/read|bash|edit|write/);
		// Must indicate plan mode is now disabled
		expect(exitMessage.toLowerCase()).toContain("plan mode disabled");
	});

	it("notifies with all tool names when restoring fewer than 10 tools", async () => {
		// Arrange — small normal-mode set (4 tools, all shown since ≤10)
		const smallTools = ["read", "bash", "edit", "write"];
		const pi = makeFakePi(smallTools);
		const ctx = makeFakeCtx();
		planModeExtension(pi as never);

		const commandCalls = pi.registerCommand.mock.calls as Array<
			[string, { handler: (args: unknown, ctx: unknown) => Promise<void> }]
		>;
		const handler = commandCalls.find(([name]) => name === "plan")![1].handler;

		// Enter then exit — snapshot saves smallTools, restore returns them
		await handler({}, ctx);  // enter
		await handler({}, ctx);  // exit

		const notifyCalls = ctx.ui.notify.mock.calls as Array<[string]>;
		const exitMessage = notifyCalls[1]![0];

		// All 4 tools must appear; no truncation since count ≤ 10
		expect(exitMessage).toContain("read");
		expect(exitMessage).toContain("bash");
		expect(exitMessage).toContain("edit");
		expect(exitMessage).toContain("write");
		expect(exitMessage.toLowerCase()).toContain("plan mode disabled");
		// No total-count annotation when all tools fit in the sample
		expect(exitMessage).not.toContain("total");
	});
});
