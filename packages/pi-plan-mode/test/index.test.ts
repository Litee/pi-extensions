import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Api, Model } from "@earendil-works/pi-ai";

vi.mock("node:fs");
import { readFileSync } from "node:fs";

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
		events: {
			emit: vi.fn(),
			on: vi.fn(),
		},
		sendMessage: vi.fn(),
		setModel: vi.fn(() => true),
		getThinkingLevel: vi.fn(() => "medium" as const),
		setThinkingLevel: vi.fn(),
		getFlag: vi.fn(() => false),
	};
}

function makeFakeCtx() {
	return {
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			theme: { fg: vi.fn((_color: string, text: string) => text) },
			select: vi.fn(() => "Stay in plan mode"),
		},
		hasUI: true,
		model: { id: "claude-sonnet-4-5", provider: "anthropic" } as unknown as Model<Api>,
		modelRegistry: {
			getAll: vi.fn((): Model<Api>[] => [
				{ id: "claude-sonnet-4-5", provider: "anthropic" } as unknown as Model<Api>,
				{ id: "claude-opus-4-20250514", provider: "anthropic" } as unknown as Model<Api>,
			]),
		},
	};
}

beforeEach(() => {
	// Default: config file does not exist.
	vi.mocked(readFileSync).mockImplementation(() => {
		const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
		err.code = "ENOENT";
		throw err;
	});
});

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

describe("agent_end pi.events emissions", () => {
	it("emits user_attention_requested before ctx.ui.select and user_attention_resolved after", async () => {
		// Arrange
		const callOrder: string[] = [];
		const pi = makeFakePi();
		(pi.events.emit as ReturnType<typeof vi.fn>).mockImplementation((channel: string) => {
			callOrder.push(`emit:${channel}`);
		});

		const ctx = makeFakeCtx();
		(ctx.ui.select as ReturnType<typeof vi.fn>).mockImplementation(() => {
			callOrder.push("select");
			return "Stay in plan mode";
		});

		planModeExtension(pi as never);

		// Enable plan mode via /plan command
		const commandCalls = pi.registerCommand.mock.calls as Array<
			[string, { handler: (args: unknown, ctx: unknown) => Promise<void> }]
		>;
		const planHandler = commandCalls.find(([name]) => name === "plan")![1].handler;
		await planHandler({}, ctx);

		// Trigger agent_end
		const onCalls = pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>;
		const agentEndHandler = onCalls.find(([e]) => e === "agent_end")![1];
		await agentEndHandler({}, ctx);

		// Assert — emit order: attention before select, resolved after
		expect(callOrder).toEqual(["emit:user_attention_requested", "select", "emit:user_attention_resolved"]);
		expect(pi.events.emit).toHaveBeenCalledWith("user_attention_requested", {
			source: "plan-mode",
			title: "Plan mode \u2014 what next?",
		});
		expect(pi.events.emit).toHaveBeenCalledWith("user_attention_resolved", { source: "plan-mode" });
	});

	it("does not emit attention events when plan mode is disabled", async () => {
		// Arrange — plan mode starts disabled
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		planModeExtension(pi as never);

		// Act — fire agent_end without enabling plan mode
		const onCalls = pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>;
		const agentEndHandler = onCalls.find(([e]) => e === "agent_end")![1];
		await agentEndHandler({}, ctx);

		// Assert — no events, no select
		expect(pi.events.emit).not.toHaveBeenCalled();
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});
});

describe("plan-mode model and thinking level", () => {
	it("saves model snapshot on enable and restores it on disable (no config file)", async () => {
		// Arrange — readFileSync already mocked to throw ENOENT in beforeEach
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		planModeExtension(pi as never);

		const commandCalls = pi.registerCommand.mock.calls as Array<
			[string, { handler: (args: unknown, ctx: unknown) => Promise<void> }]
		>;
		const handler = commandCalls.find(([name]) => name === "plan")![1].handler;

		// Act
		await handler({}, ctx);  // enable
		await handler({}, ctx);  // disable

		// Assert — setModel called once on disable with ctx.model (the snapshot)
		expect(pi.setModel).toHaveBeenCalledTimes(1);
		expect(pi.setModel).toHaveBeenCalledWith(ctx.model);

		// setThinkingLevel called once on disable with the snapshotted value ("medium")
		expect(pi.setThinkingLevel).toHaveBeenCalledTimes(1);
		expect(pi.setThinkingLevel).toHaveBeenCalledWith("medium");
	});

	it("applies model and thinkingLevel from config on enable", async () => {
		// Arrange — config specifies a different model and thinking level
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({ model: "claude-opus-4-20250514", thinkingLevel: "high" }),
		);

		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		planModeExtension(pi as never);

		const commandCalls = pi.registerCommand.mock.calls as Array<
			[string, { handler: (args: unknown, ctx: unknown) => Promise<void> }]
		>;
		const handler = commandCalls.find(([name]) => name === "plan")![1].handler;

		// Act — enable only
		await handler({}, ctx);

		// Assert — setModel called with the resolved model object
		expect(pi.setModel).toHaveBeenCalledTimes(1);
		expect(pi.setModel).toHaveBeenCalledWith({ id: "claude-opus-4-20250514", provider: "anthropic" });

		// setThinkingLevel called with config value
		expect(pi.setThinkingLevel).toHaveBeenCalledTimes(1);
		expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
	});

	it("applies model with provider filter from config", async () => {
		// Arrange
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({ model: "claude-opus-4-20250514", provider: "anthropic", thinkingLevel: "xhigh" }),
		);

		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		planModeExtension(pi as never);

		const commandCalls = pi.registerCommand.mock.calls as Array<
			[string, { handler: (args: unknown, ctx: unknown) => Promise<void> }]
		>;
		const handler = commandCalls.find(([name]) => name === "plan")![1].handler;

		// Act
		await handler({}, ctx);

		// Assert — correct model resolved by both id and provider
		expect(pi.setModel).toHaveBeenCalledWith({ id: "claude-opus-4-20250514", provider: "anthropic" });
	});

	it("does not call setModel on disable when no snapshot exists (session-resumed plan mode)", async () => {
		// Arrange — simulate session_start restoring plan mode (no in-session enable, no snapshot)
		const pi = makeFakePi();
		// Provide a minimal sessionManager with a plan-mode-enabled entry
		const ctx = {
			...makeFakeCtx(),
			sessionManager: {
				getEntries: vi.fn(() => [
					{ type: "custom", customType: "plan-mode", data: { enabled: true } },
				]),
			},
		};
		pi.getFlag = vi.fn(() => false);

		planModeExtension(pi as never);

		// Fire session_start to restore plan-mode without a snapshot
		const onCalls = pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>;
		const sessionStartHandler = onCalls.find(([e]) => e === "session_start")![1];
		await sessionStartHandler({}, ctx);

		// Clear any setModel/setThinkingLevel calls made during session_start (config apply)
		(pi.setModel as ReturnType<typeof vi.fn>).mockClear();
		(pi.setThinkingLevel as ReturnType<typeof vi.fn>).mockClear();

		// Now disable plan mode via /plan command — no snapshot should be restored
		const commandCalls = pi.registerCommand.mock.calls as Array<
			[string, { handler: (args: unknown, ctx: unknown) => Promise<void> }]
		>;
		const handler = commandCalls.find(([name]) => name === "plan")![1].handler;
		await handler({}, ctx);  // disable (plan mode was on, this toggles it off)

		// Assert — setModel not called because there was no snapshot
		expect(pi.setModel).not.toHaveBeenCalled();
		expect(pi.setThinkingLevel).not.toHaveBeenCalled();

		// Assert — warning notification emitted
		const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string?]>;
		const warningCall = notifyCalls.find(([, type]) => type === "warning");
		expect(warningCall).toBeDefined();
		expect(warningCall![0]).toContain("previous session");
	});

	it("does not crash and skips model/thinking when config file is missing", async () => {
		// Arrange — readFileSync throws ENOENT (default from beforeEach)
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		planModeExtension(pi as never);

		const commandCalls = pi.registerCommand.mock.calls as Array<
			[string, { handler: (args: unknown, ctx: unknown) => Promise<void> }]
		>;
		const handler = commandCalls.find(([name]) => name === "plan")![1].handler;

		// Act — enable then disable; should not throw
		await expect(handler({}, ctx)).resolves.toBeUndefined();  // enable
		await expect(handler({}, ctx)).resolves.toBeUndefined();  // disable

		// setModel called exactly once on disable (restoring the snapshot, not config)
		expect(pi.setModel).toHaveBeenCalledTimes(1);
		expect(pi.setModel).toHaveBeenCalledWith(ctx.model);
	});
});

describe("plan-mode persistence across session restarts", () => {
	it("persistState writes the full snapshot into a pi-plan-mode:state entry on enable", async () => {
		// Arrange — pi returns a realistic pre-plan tool set; getThinkingLevel returns "medium".
		const normalTools = ["read", "bash", "edit", "write"];
		const pi = makeFakePi(normalTools);
		const ctx = makeFakeCtx();
		planModeExtension(pi as never);

		const commandCalls = pi.registerCommand.mock.calls as Array<
			[string, { handler: (args: unknown, ctx: unknown) => Promise<void> }]
		>;
		const handler = commandCalls.find(([name]) => name === "plan")![1].handler;

		// Act — enable plan mode; this should persist the full snapshot.
		await handler({}, ctx);

		// Assert — appendEntry called with namespaced customType and full snapshot payload.
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		const [customType, data] = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, unknown];
		expect(customType).toBe("pi-plan-mode:state");
		expect(data).toEqual({
			enabled: true,
			modelSnapshot: { id: "claude-sonnet-4-5", provider: "anthropic" },
			thinkingLevelSnapshot: "medium",
			toolsSnapshot: normalTools,
		});
	});

	it("session_start restores snapshots from a pi-plan-mode:state entry", async () => {
		// Arrange — a previous session persisted a full snapshot. The registry already has the opus model.
		const persistedTools = ["read", "bash", "edit", "write", "grep"];
		const pi = makeFakePi();
		const ctx = {
			...makeFakeCtx(),
			sessionManager: {
				getEntries: vi.fn(() => [
					{
						type: "custom",
						customType: "pi-plan-mode:state",
						data: {
							enabled: true,
							modelSnapshot: { id: "claude-opus-4-20250514", provider: "anthropic" },
							thinkingLevelSnapshot: "high",
							toolsSnapshot: persistedTools,
						},
					},
				]),
			},
		};
		pi.getFlag = vi.fn(() => false);
		planModeExtension(pi as never);

		// Act — fire session_start (restores snapshot), then toggle /plan off.
		const onCalls = pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>;
		const sessionStartHandler = onCalls.find(([e]) => e === "session_start")![1];
		await sessionStartHandler({}, ctx);

		// Clear any setModel/setThinkingLevel/setActiveTools calls from session_start itself.
		(pi.setModel as ReturnType<typeof vi.fn>).mockClear();
		(pi.setThinkingLevel as ReturnType<typeof vi.fn>).mockClear();
		(pi.setActiveTools as ReturnType<typeof vi.fn>).mockClear();
		(ctx.ui.notify as ReturnType<typeof vi.fn>).mockClear();

		const commandCalls = pi.registerCommand.mock.calls as Array<
			[string, { handler: (args: unknown, ctx: unknown) => Promise<void> }]
		>;
		const handler = commandCalls.find(([name]) => name === "plan")![1].handler;
		await handler({}, ctx); // toggle off — should restore from rehydrated snapshot

		// Assert — model restored from the registry by id+provider.
		expect(pi.setModel).toHaveBeenCalledTimes(1);
		expect(pi.setModel).toHaveBeenCalledWith({ id: "claude-opus-4-20250514", provider: "anthropic" });

		// Assert — thinking level restored.
		expect(pi.setThinkingLevel).toHaveBeenCalledTimes(1);
		expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");

		// Assert — tools restored from the persisted snapshot.
		expect(pi.setActiveTools).toHaveBeenCalledWith(persistedTools);

		// Assert — no "restored from previous session" warning, since the snapshot rehydrated.
		const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls as Array<
			[string, string?]
		>;
		const warningCall = notifyCalls.find(([, type]) => type === "warning");
		expect(warningCall).toBeUndefined();
	});

	it("session_start honors the legacy plan-mode entry without snapshots and warns on disable", async () => {
		// Arrange — only the legacy customType with just `{ enabled: true }`.
		const pi = makeFakePi();
		const ctx = {
			...makeFakeCtx(),
			sessionManager: {
				getEntries: vi.fn(() => [
					{ type: "custom", customType: "plan-mode", data: { enabled: true } },
				]),
			},
		};
		pi.getFlag = vi.fn(() => false);
		planModeExtension(pi as never);

		// Act — restore then toggle off.
		const onCalls = pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>;
		const sessionStartHandler = onCalls.find(([e]) => e === "session_start")![1];
		await sessionStartHandler({}, ctx);

		(pi.setModel as ReturnType<typeof vi.fn>).mockClear();
		(pi.setThinkingLevel as ReturnType<typeof vi.fn>).mockClear();
		(ctx.ui.notify as ReturnType<typeof vi.fn>).mockClear();

		const commandCalls = pi.registerCommand.mock.calls as Array<
			[string, { handler: (args: unknown, ctx: unknown) => Promise<void> }]
		>;
		const handler = commandCalls.find(([name]) => name === "plan")![1].handler;
		await handler({}, ctx); // toggle off

		// Assert — no snapshot, so setModel/setThinkingLevel skipped.
		expect(pi.setModel).not.toHaveBeenCalled();
		expect(pi.setThinkingLevel).not.toHaveBeenCalled();

		// Assert — warning notification emitted.
		const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls as Array<
			[string, string?]
		>;
		const warningCall = notifyCalls.find(([, type]) => type === "warning");
		expect(warningCall).toBeDefined();
		expect(warningCall![0]).toContain("previous session");
	});

	it("session_start leaves modelSnapshot undefined when the persisted model is no longer in the registry", async () => {
		// Arrange — persisted snapshot references a ghost model not in the registry.
		const pi = makeFakePi();
		const ctx = {
			...makeFakeCtx(),
			sessionManager: {
				getEntries: vi.fn(() => [
					{
						type: "custom",
						customType: "pi-plan-mode:state",
						data: {
							enabled: true,
							modelSnapshot: { id: "claude-ghost-9000", provider: "anthropic" },
							thinkingLevelSnapshot: "low",
							toolsSnapshot: ["read", "bash"],
						},
					},
				]),
			},
		};
		pi.getFlag = vi.fn(() => false);
		planModeExtension(pi as never);

		const onCalls = pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>;
		const sessionStartHandler = onCalls.find(([e]) => e === "session_start")![1];
		await sessionStartHandler({}, ctx);

		(pi.setModel as ReturnType<typeof vi.fn>).mockClear();
		(pi.setThinkingLevel as ReturnType<typeof vi.fn>).mockClear();
		(pi.setActiveTools as ReturnType<typeof vi.fn>).mockClear();
		(ctx.ui.notify as ReturnType<typeof vi.fn>).mockClear();

		const commandCalls = pi.registerCommand.mock.calls as Array<
			[string, { handler: (args: unknown, ctx: unknown) => Promise<void> }]
		>;
		const handler = commandCalls.find(([name]) => name === "plan")![1].handler;
		await handler({}, ctx); // toggle off

		// Assert — model snapshot not restored (ghost model absent from registry).
		expect(pi.setModel).not.toHaveBeenCalled();

		// Assert — thinking level and tools still restored from their (present) snapshots.
		expect(pi.setThinkingLevel).toHaveBeenCalledTimes(1);
		expect(pi.setThinkingLevel).toHaveBeenCalledWith("low");
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash"]);

		// Assert — no warning, because at least one snapshot was rehydrated (thinking + tools).
		const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls as Array<
			[string, string?]
		>;
		const warningCall = notifyCalls.find(([, type]) => type === "warning");
		expect(warningCall).toBeUndefined();
	});

	it("disable persists enabled:false with no stale snapshot fields", async () => {
		// Arrange
		const pi = makeFakePi(["read", "bash", "edit", "write"]);
		const ctx = makeFakeCtx();
		planModeExtension(pi as never);

		const commandCalls = pi.registerCommand.mock.calls as Array<
			[string, { handler: (args: unknown, ctx: unknown) => Promise<void> }]
		>;
		const handler = commandCalls.find(([name]) => name === "plan")![1].handler;

		// Act — enable then disable.
		await handler({}, ctx);
		await handler({}, ctx);

		// Assert — two appendEntry calls; the second (disable) must be enabled:false
		// with no leftover snapshot fields (disablePlanMode clears them first).
		const appendCalls = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
		expect(appendCalls).toHaveLength(2);

		const [disableType, disableData] = appendCalls[1]!;
		expect(disableType).toBe("pi-plan-mode:state");
		expect(disableData).toEqual({ enabled: false });
		expect(disableData).not.toHaveProperty("modelSnapshot");
		expect(disableData).not.toHaveProperty("thinkingLevelSnapshot");
		expect(disableData).not.toHaveProperty("toolsSnapshot");
	});

	it("session_start with a disabled state entry leaves plan mode off (no PLAN_MODE_TOOLS applied)", async () => {
		// Arrange — the last persisted entry says plan mode was disabled.
		const pi = makeFakePi();
		const ctx = {
			...makeFakeCtx(),
			sessionManager: {
				getEntries: vi.fn(() => [
					{ type: "custom", customType: "pi-plan-mode:state", data: { enabled: false } },
				]),
			},
		};
		pi.getFlag = vi.fn(() => false);
		planModeExtension(pi as never);

		// Act — fire session_start.
		const onCalls = pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>;
		const sessionStartHandler = onCalls.find(([e]) => e === "session_start")![1];
		await sessionStartHandler({}, ctx);

		// Assert — no tool-set change, no model/thinking change, status cleared.
		expect(pi.setActiveTools).not.toHaveBeenCalled();
		expect(pi.setModel).not.toHaveBeenCalled();
		expect(pi.setThinkingLevel).not.toHaveBeenCalled();
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("plan-mode", undefined);
	});

	it("session_start picks the latest state entry when multiple entries exist", async () => {
		// Arrange — two pi-plan-mode:state entries: first enabled with snapshot,
		// second disabled. Latest (second) must win.
		const pi = makeFakePi();
		const ctx = {
			...makeFakeCtx(),
			sessionManager: {
				getEntries: vi.fn(() => [
					{
						type: "custom",
						customType: "pi-plan-mode:state",
						data: {
							enabled: true,
							modelSnapshot: { id: "claude-opus-4-20250514", provider: "anthropic" },
							thinkingLevelSnapshot: "high",
							toolsSnapshot: ["read", "bash", "edit", "write"],
						},
					},
					{ type: "custom", customType: "pi-plan-mode:state", data: { enabled: false } },
				]),
			},
		};
		pi.getFlag = vi.fn(() => false);
		planModeExtension(pi as never);

		// Act.
		const onCalls = pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>;
		const sessionStartHandler = onCalls.find(([e]) => e === "session_start")![1];
		await sessionStartHandler({}, ctx);

		// Assert — plan mode stays off: no PLAN_MODE_TOOLS activation, no model/thinking change.
		expect(pi.setActiveTools).not.toHaveBeenCalled();
		expect(pi.setModel).not.toHaveBeenCalled();
		expect(pi.setThinkingLevel).not.toHaveBeenCalled();
	});

	it("session_start: disabled state entry overrides --plan flag", async () => {
		// Arrange — user launched with --plan, but the resumed session's last entry
		// says enabled:false (they disabled plan mode before the restart). The
		// session entry must take precedence over the flag.
		const pi = makeFakePi();
		const ctx = {
			...makeFakeCtx(),
			sessionManager: {
				getEntries: vi.fn(() => [
					{ type: "custom", customType: "pi-plan-mode:state", data: { enabled: false } },
				]),
			},
		};
		pi.getFlag = vi.fn(() => true); // --plan was set
		planModeExtension(pi as never);

		const onCalls = pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>;
		const sessionStartHandler = onCalls.find(([e]) => e === "session_start")![1];
		await sessionStartHandler({}, ctx);

		expect(pi.setActiveTools).not.toHaveBeenCalled();
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("plan-mode", undefined);
	});

	it("enable→disable round-trip leaves the final persisted entry as enabled:false", async () => {
		// Arrange — integration-ish: simulate what a real user does over a session.
		const pi = makeFakePi(["read", "bash", "edit", "write"]);
		const ctx = makeFakeCtx();
		planModeExtension(pi as never);

		const commandCalls = pi.registerCommand.mock.calls as Array<
			[string, { handler: (args: unknown, ctx: unknown) => Promise<void> }]
		>;
		const handler = commandCalls.find(([name]) => name === "plan")![1].handler;

		// Act — toggle plan mode on, off, on, off.
		await handler({}, ctx);
		await handler({}, ctx);
		await handler({}, ctx);
		await handler({}, ctx);

		// Assert — 4 appendEntry calls, last one is enabled:false (no snapshot).
		const appendCalls = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls as Array<[string, unknown]>;
		expect(appendCalls).toHaveLength(4);

		const [finalType, finalData] = appendCalls[3]!;
		expect(finalType).toBe("pi-plan-mode:state");
		expect(finalData).toEqual({ enabled: false });

		// And the enable entries in between did carry snapshots.
		expect(appendCalls[0]![1]).toMatchObject({ enabled: true, toolsSnapshot: ["read", "bash", "edit", "write"] });
		expect(appendCalls[2]![1]).toMatchObject({ enabled: true });
	});
});

describe("agent_end — Execute and Refine choices", () => {
	async function setupAgentEndHandler(select: ReturnType<typeof vi.fn>, editorResult?: string) {
		const pi = {
			...makeFakePi(),
			sendUserMessage: vi.fn(),
		};
		const ctx = {
			...makeFakeCtx(),
			ui: {
				...makeFakeCtx().ui,
				select,
				editor: vi.fn(() => Promise.resolve(editorResult)),
			},
		};

		planModeExtension(pi as never);

		const commandCalls = pi.registerCommand.mock.calls as Array<
			[string, { handler: (args: unknown, ctx: unknown) => Promise<void> }]
		>;
		const planHandler = commandCalls.find(([name]) => name === "plan")![1].handler;
		await planHandler({}, ctx);

		const onCalls = pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>;
		const agentEndHandler = onCalls.find(([e]) => e === "agent_end")![1];
		await agentEndHandler({}, ctx);

		return { pi, ctx };
	}

	it("'Execute plan (track progress)' disables plan mode and sends execute message", async () => {
		const select = vi.fn().mockResolvedValue("Execute plan (track progress)");
		const { pi } = await setupAgentEndHandler(select);

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "plan-mode-execute" }),
			expect.objectContaining({ triggerTurn: true, deliverAs: "followUp" }),
		);
	});

	it("'Refine the plan' with non-empty text sends the refinement as a user message", async () => {
		const select = vi.fn().mockResolvedValue("Refine the plan");
		const { pi } = await setupAgentEndHandler(select, "Please add error handling.");

		expect((pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }).sendUserMessage)
			.toHaveBeenCalledWith("Please add error handling.", { deliverAs: "followUp" });
	});

	it("'Refine the plan' with empty/null text does not send a user message", async () => {
		const select = vi.fn().mockResolvedValue("Refine the plan");
		const { pi } = await setupAgentEndHandler(select, "");

		expect((pi as unknown as { sendUserMessage: ReturnType<typeof vi.fn> }).sendUserMessage)
			.not.toHaveBeenCalled();
	});
});

describe("plan-mode — applyPlanModeConfig edge cases", () => {
	it("does not call setModel when configured model is not in registry", async () => {
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({ model: "nonexistent-model" }),
		);
		const pi = makeFakePi();
		const ctx = {
			...makeFakeCtx(),
			modelRegistry: {
				getAll: vi.fn(() => [
					{ id: "claude-3", provider: "anthropic" },
				]),
			},
		};
		planModeExtension(pi as never);

		const commandCalls = pi.registerCommand.mock.calls as Array<
			[string, { handler: (args: unknown, ctx: unknown) => Promise<void> }]
		>;
		const handler = commandCalls.find(([name]) => name === "plan")![1].handler;
		await handler({}, ctx);

		// Model not in registry → setModel not called
		expect(pi.setModel).not.toHaveBeenCalled();
	});

	it("does nothing when config has no model and no thinkingLevel", async () => {
		vi.mocked(readFileSync).mockReturnValue(JSON.stringify({}));
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		planModeExtension(pi as never);

		const commandCalls = pi.registerCommand.mock.calls as Array<
			[string, { handler: (args: unknown, ctx: unknown) => Promise<void> }]
		>;
		const handler = commandCalls.find(([name]) => name === "plan")![1].handler;
		await handler({}, ctx);

		expect(pi.setModel).not.toHaveBeenCalled();
		expect(pi.setThinkingLevel).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// context event handler — branch coverage (lines 218-219 in index.ts)
// ---------------------------------------------------------------------------

describe("plan-mode context handler", () => {
	it("returns early (undefined) when plan mode is enabled — filters are bypassed", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		planModeExtension(pi as never);

		// Enable plan mode by calling the /plan command handler
		const commandCalls = pi.registerCommand.mock.calls as Array<
			[string, { handler: (args: unknown, ctx: unknown) => Promise<void> }]
		>;
		const planHandler = commandCalls.find(([name]) => name === "plan")![1].handler;
		// Select "Stay in plan mode" so the handler enables plan mode and leaves
		ctx.ui.select = vi.fn(() => "Stay in plan mode");
		await planHandler({}, ctx);

		// Retrieve the "context" handler
		const onCalls = pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>;
		const contextHandler = onCalls.find(([e]) => e === "context")?.[1];
		expect(contextHandler).toBeDefined();

		// When plan mode is enabled, the handler must return early (falsy / undefined)
		// so pi doesn't apply the filter that strips plan-mode messages.
		const fakeMessages = [{ role: "assistant", content: "plan mode content" }];
		const result = contextHandler?.({ messages: fakeMessages });
		expect(result).toBeUndefined();
	});

	it("returns filtered messages when plan mode is disabled", () => {
		const pi = makeFakePi();
		planModeExtension(pi as never);

		// Plan mode starts disabled; retrieve the context handler
		const onCalls = pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>;
		const contextHandler = onCalls.find(([e]) => e === "context")?.[1];
		expect(contextHandler).toBeDefined();

		// With plan mode disabled the handler should return a filtered messages object
		const fakeMessages: unknown[] = [];
		const result = contextHandler?.({ messages: fakeMessages });
		// The result is { messages: [...] }; we only care that it's not undefined
		expect(result).toMatchObject({ messages: expect.any(Array) as unknown });
	});
});

// ---------------------------------------------------------------------------
// before_agent_start event handler — branch coverage (lines 224-225 in index.ts)
// ---------------------------------------------------------------------------

describe("plan-mode before_agent_start handler", () => {
	it("returns undefined when plan mode is disabled", () => {
		const pi = makeFakePi();
		planModeExtension(pi as never);

		const onCalls = pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>;
		const handler = onCalls.find(([e]) => e === "before_agent_start")?.[1];
		expect(handler).toBeDefined();

		// Plan mode is disabled by default — handler should return undefined
		expect(handler?.()).toBeUndefined();
	});

	it("returns a plan-mode context message when plan mode is enabled", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		planModeExtension(pi as never);

		// Enable plan mode
		const commandCalls = pi.registerCommand.mock.calls as Array<
			[string, { handler: (args: unknown, ctx: unknown) => Promise<void> }]
		>;
		const planHandler = commandCalls.find(([name]) => name === "plan")![1].handler;
		ctx.ui.select = vi.fn(() => "Stay in plan mode");
		await planHandler({}, ctx);

		// Retrieve the before_agent_start handler
		const onCalls = pi.on.mock.calls as Array<[string, (...args: unknown[]) => unknown]>;
		const handler = onCalls.find(([e]) => e === "before_agent_start")?.[1];
		expect(handler).toBeDefined();

		// Should return a { message: ... } object
		const result = handler?.() as { message?: unknown } | undefined;
		expect(result).not.toBeUndefined();
		expect(result).toMatchObject({ message: expect.anything() as unknown });
	});
});

// ---------------------------------------------------------------------------
// Shortcut handler coverage (lines 196-197, 208-209 in index.ts)
// ---------------------------------------------------------------------------

describe("plan-mode shortcut handlers", () => {
	it("ctrl+alt+p shortcut handler toggles plan mode and persists state", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		// Set select to "Stay in plan mode" so that toggling into plan mode works
		ctx.ui.select = vi.fn(() => "Stay in plan mode");
		planModeExtension(pi as never);

		const calls = pi.registerShortcut.mock.calls as Array<
			[string, { description: string; handler: (ctx: unknown) => Promise<void> }]
		>;
		const ctrlAltP = calls.find(([key]) => key === "ctrl+alt+p");
		expect(ctrlAltP).toBeDefined();

		// Calling the handler should toggle plan mode (lines 196-197)
		await ctrlAltP![1].handler(ctx);

		// Verify appendEntry was called (persistState writes a session entry)
		expect(pi.appendEntry).toHaveBeenCalled();
	});

	it("shift+tab shortcut handler toggles plan mode and persists state", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		ctx.ui.select = vi.fn(() => "Stay in plan mode");
		planModeExtension(pi as never);

		const calls = pi.registerShortcut.mock.calls as Array<
			[string, { description: string; handler: (ctx: unknown) => Promise<void> }]
		>;
		const shiftTab = calls.find(([key]) => key === "shift+tab");
		expect(shiftTab).toBeDefined();

		// Calling the handler should toggle plan mode (lines 208-209)
		await shiftTab![1].handler(ctx);

		// Verify appendEntry was called (persistState writes a session entry)
		expect(pi.appendEntry).toHaveBeenCalled();
	});
});
