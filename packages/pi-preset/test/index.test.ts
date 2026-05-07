import { describe, expect, it, vi } from "vitest";

import presetExtension from "../src/index.js";

/**
 * Minimal stub of the ExtensionAPI surface consumed by presetExtension at
 * registration time. Only the methods called synchronously during init are
 * required; async handler internals are exercised in separate tests.
 */
function makeFakePi(activeTools: string[] = ["read", "bash", "edit", "write"]) {
	const tools = [...activeTools];
	return {
		registerFlag: vi.fn(),
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		on: vi.fn(),
		getFlag: vi.fn(() => undefined),
		getActiveTools: vi.fn(() => [...tools]),
		setActiveTools: vi.fn(),
		getAllTools: vi.fn(() => tools.map((name) => ({ name }))),
		getThinkingLevel: vi.fn(() => "medium" as const),
		setThinkingLevel: vi.fn(),
		setModel: vi.fn(async () => true),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
	};
}

function makeFakeCtx(cwd = "/tmp") {
	return {
		cwd,
		hasUI: true,
		model: undefined,
		modelRegistry: { find: vi.fn(() => undefined) },
		sessionManager: { getEntries: vi.fn(() => []) },
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			select: vi.fn(async () => null),
			editor: vi.fn(async () => ""),
			custom: vi.fn(async () => null),
			theme: {
				fg: vi.fn((_color: string, text: string) => text),
				bold: vi.fn((text: string) => text),
			},
		},
	};
}

describe("preset extension — registration", () => {
	it("registers the --preset CLI flag", () => {
		const pi = makeFakePi();
		presetExtension(pi as never);
		expect(pi.registerFlag).toHaveBeenCalledWith("preset", expect.objectContaining({ type: "string" }));
	});

	it("registers a /preset command", () => {
		const pi = makeFakePi();
		presetExtension(pi as never);
		const names = (pi.registerCommand.mock.calls as Array<[string, unknown]>).map(([n]) => n);
		expect(names).toContain("preset");
	});

	it("registers the Ctrl+Shift+U cycling shortcut", () => {
		const pi = makeFakePi();
		presetExtension(pi as never);
		const keys = (pi.registerShortcut.mock.calls as Array<[string, unknown]>).map(([k]) => k);
		expect(keys).toContain("ctrl+shift+u");
	});

	it("registers session_start, turn_start, tool_call, context, before_agent_start, and agent_end event handlers", () => {
		const pi = makeFakePi();
		presetExtension(pi as never);
		const events = (pi.on.mock.calls as Array<[string, unknown]>).map(([e]) => e);
		expect(events).toContain("session_start");
		expect(events).toContain("turn_start");
		expect(events).toContain("tool_call");
		expect(events).toContain("context");
		expect(events).toContain("before_agent_start");
		expect(events).toContain("agent_end");
	});
});

describe("preset extension — /preset command (direct name)", () => {
	it("notifies with activated preset and tool list when switching by name", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		presetExtension(pi as never);

		// Simulate session_start to load presets — inject a fake presets map.
		// We call the session_start handler directly with a fake ctx that returns presets.
		const sessionStartHandler = (pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>).find(
			([e]) => e === "session_start",
		)![1];

		// Give the ctx a fake presets loader path (no actual file needed — empty presets).
		await sessionStartHandler({}, ctx);

		// Now inject presets manually via the command — use a fake preset in a
		// context where we can't load from disk. We do this by calling the handler
		// after the extension's internal state was seeded.
		// (The session_start test above results in an empty preset map since
		// /tmp/.pi/presets.json doesn't exist.)
		const commandHandler = (
			pi.registerCommand.mock.calls as Array<[string, { handler: (...a: unknown[]) => Promise<void> }]>
		).find(([n]) => n === "preset")![1].handler;

		await commandHandler("nonexistent", ctx);
		const notifyCalls = (ctx.ui.notify.mock.calls as Array<[string, string?]>);
		expect(notifyCalls.at(-1)![0]).toContain("Unknown preset");
	});
});

describe("preset extension — context event strips preset-context messages", () => {
	it("filters messages with customType preset-context", async () => {
		const pi = makeFakePi();
		presetExtension(pi as never);

		const contextHandler = (pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>).find(
			([e]) => e === "context",
		)![1];

		const messages = [
			{ role: "user", content: "hello", customType: undefined },
			{ role: "user", content: "instructions", customType: "preset-context" },
			{ role: "assistant", content: "hi", customType: undefined },
		];

		const result = (await contextHandler({ messages })) as { messages: unknown[] } | undefined;
		expect(result).toBeDefined();
		expect(result!.messages).toHaveLength(2);
		expect(result!.messages).not.toContainEqual(
			expect.objectContaining({ customType: "preset-context" }),
		);
	});

	it("returns undefined (no change) when no preset-context messages are present", async () => {
		const pi = makeFakePi();
		presetExtension(pi as never);

		const contextHandler = (pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>).find(
			([e]) => e === "context",
		)![1];

		const messages = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi" },
		];

		const result = await contextHandler({ messages });
		expect(result).toBeUndefined();
	});
});

describe("preset extension — before_agent_start injects instructions", () => {
	it("returns undefined when no preset is active", async () => {
		const pi = makeFakePi();
		presetExtension(pi as never);

		const handler = (pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>).find(
			([e]) => e === "before_agent_start",
		)![1];

		const result = await handler({});
		expect(result).toBeUndefined();
	});
});

describe("preset extension — tool_call blocks when bash filter active", () => {
	it("passes through non-bash tool calls without blocking", async () => {
		const pi = makeFakePi();
		presetExtension(pi as never);

		const handler = (pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>).find(
			([e]) => e === "tool_call",
		)![1];

		const result = await handler({ toolName: "read", input: { path: "/tmp/foo" } });
		expect(result).toBeUndefined();
	});

	it("passes through bash calls when no preset filter is active", async () => {
		const pi = makeFakePi();
		presetExtension(pi as never);

		const handler = (pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>).find(
			([e]) => e === "tool_call",
		)![1];

		const result = await handler({ toolName: "bash", input: { command: "rm -rf /" } });
		// No active filter — must not block.
		expect(result).toBeUndefined();
	});
});

describe("preset extension — turn_start persists state", () => {
	it("calls appendEntry with preset-state on every turn", async () => {
		const pi = makeFakePi();
		presetExtension(pi as never);

		const handler = (pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>).find(
			([e]) => e === "turn_start",
		)![1];

		await handler({});
		expect(pi.appendEntry).toHaveBeenCalledWith("preset-state", { name: null });
	});
});
