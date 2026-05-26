import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

vi.mock("../src/config.js", () => ({
	loadConfig: vi.fn(() => ({})),
	saveConfig: vi.fn(() => true),
}));
import { loadConfig, saveConfig } from "../src/config.js";

import { createExtensionWithClient } from "../src/index.js";
import { STATE_CUSTOM_TYPE } from "../src/persistence.js";
import { CUSTOM_MESSAGE_TYPE } from "../src/runtime.js";
import type { Ec2Client, InstanceStateResult } from "../src/ec2-client.js";
import { resetToolRegisteredForTests } from "../src/toolAction.js";

interface Handlers {
	sessionStart?: (event: unknown, ctx: unknown) => Promise<void> | void;
	sessionShutdown?: (event: unknown, ctx: unknown) => Promise<void> | void;
	turnEnd?: (event: unknown, ctx: unknown) => Promise<void> | void;
}

interface CommandSpec {
	description: string;
	handler: (args: string, ctx: unknown) => Promise<void> | void;
}

function makePi(opts: { activeTools?: () => string[] } = {}): {
	pi: ExtensionAPI;
	handlers: Handlers;
	commands: Record<string, CommandSpec>;
	sendMessage: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
	registerTool: ReturnType<typeof vi.fn>;
	setActiveTools: ReturnType<typeof vi.fn>;
	registerMessageRenderer: ReturnType<typeof vi.fn>;
} {
	const handlers: Handlers = {};
	const commands: Record<string, CommandSpec> = {};
	const sendMessage = vi.fn();
	const appendEntry = vi.fn();
	const registerTool = vi.fn();
	const setActiveTools = vi.fn();
	const registerMessageRenderer = vi.fn();
	const pi = {
		on: (event: string, handler: (e: unknown, ctx: unknown) => Promise<void> | void) => {
			if (event === "session_start") handlers.sessionStart = handler;
			else if (event === "session_shutdown") handlers.sessionShutdown = handler;
			else if (event === "turn_end") handlers.turnEnd = handler;
		},
		sendMessage,
		appendEntry,
		registerTool,
		getActiveTools: opts.activeTools ?? (() => []),
		setActiveTools,
		registerMessageRenderer,
		registerCommand: (name: string, spec: CommandSpec) => {
			commands[name] = spec;
		},
		events: { on: vi.fn().mockReturnValue(() => {}), emit: vi.fn() },
	} as unknown as ExtensionAPI;
	return {
		pi,
		handlers,
		commands,
		sendMessage,
		appendEntry,
		registerTool,
		setActiveTools,
		registerMessageRenderer,
	};
}

function makeCtx(stateEntries: unknown[] = []) {
	return {
		hasUI: false,
		sessionManager: { getEntries: () => stateEntries },
	};
}

function makeClient(resp: InstanceStateResult = { state: "running" }): Ec2Client {
	return { describeInstance: vi.fn().mockResolvedValue(resp), stopInstance: vi.fn().mockResolvedValue(undefined), startInstance: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
	resetToolRegisteredForTests();
	vi.mocked(loadConfig).mockReturnValue({});
	vi.mocked(saveConfig).mockReset();
	vi.mocked(saveConfig).mockReturnValue(true);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createExtensionWithClient — session lifecycle", () => {
	it("registers the tool and message renderer; removes auto-added tool when enabled=false", async () => {
		const { pi, handlers, registerTool, setActiveTools, registerMessageRenderer } = makePi({
			activeTools: () => ["ec2_instance_watcher", "read"],
		});
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, makeCtx());
		expect(registerTool).toHaveBeenCalledOnce();
		expect(setActiveTools).toHaveBeenCalledWith(["read"]);
		expect(registerMessageRenderer).toHaveBeenCalledWith(CUSTOM_MESSAGE_TYPE, expect.any(Function));
	});

	it("does NOT remove tool from active when enabled=true is persisted", async () => {
		const { pi, handlers, setActiveTools } = makePi({
			activeTools: () => ["ec2_instance_watcher", "read"],
		});
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!(
			{},
			makeCtx([
				{
					type: "custom",
					customType: STATE_CUSTOM_TYPE,
					data: {
						savedAt: 1,
						paused: false,
						watches: [],
						baselines: { enabled: true },
					},
				},
			]),
		);
		expect(setActiveTools).not.toHaveBeenCalled();
	});

	it("registers the /ec2-watcher command", () => {
		const { pi, commands } = makePi();
		createExtensionWithClient(pi, makeClient());
		expect(commands["ec2-watcher"]).toBeDefined();
		expect(commands["ec2-watcher"]!.description).toMatch(/EC2/i);
	});

	it("rehydrates persisted watches and re-seeds missing baselines", async () => {
		const { pi, handlers } = makePi();
		const persisted = {
			savedAt: 1,
			paused: false,
			baselines: { enabled: true, displayMode: "widget" },
			watches: [
				{
					watchId: "w1",
					instanceId: "i-1234abcd",
					profile: "p",
					stopOnStopped: false,
					addedAt: 0,
					terminal: false,
					consecutiveErrors: 0,
				},
			],
		};
		const client = makeClient({ state: "running" });
		createExtensionWithClient(pi, client);
		await handlers.sessionStart!({}, makeCtx([{ type: "custom", customType: STATE_CUSTOM_TYPE, data: persisted }]));
		expect(client.describeInstance).toHaveBeenCalledWith("i-1234abcd", "p", undefined);
	});

	it("emits a deferred startup chat message when watches are present", async () => {
		vi.useFakeTimers();
		const { pi, handlers, sendMessage } = makePi();
		const persisted = {
			savedAt: 1,
			paused: false,
			baselines: { enabled: true, displayMode: "widget" },
			watches: [
				{
					watchId: "w1",
					instanceId: "i-1234abcd",
					profile: "p",
					stopOnStopped: false,
					addedAt: 0,
					baseline: { state: "running" },
					terminal: false,
					consecutiveErrors: 0,
				},
			],
		};
		createExtensionWithClient(pi, makeClient({ state: "running" }));
		await handlers.sessionStart!(
			{},
			makeCtx([{ type: "custom", customType: STATE_CUSTOM_TYPE, data: persisted }]),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(sendMessage).toHaveBeenCalledOnce();
		const [msg, opts] = sendMessage.mock.calls[0]! as [
			{ customType: string; content: string },
			{ triggerTurn: boolean },
		];
		expect(msg.customType).toBe(CUSTOM_MESSAGE_TYPE);
		expect(msg.content).toMatch(/watching 1 instance/);
		expect(opts.triggerTurn).toBe(false);
	});

	it("session_shutdown stops polling", async () => {
		const { pi, handlers } = makePi();
		const client = makeClient({ state: "running" });
		createExtensionWithClient(pi, client);
		await handlers.sessionStart!({}, makeCtx());
		await handlers.sessionShutdown!({}, makeCtx());
		// just verify it doesn't throw
	});

	it("turn_end activates when tool is newly in active list", async () => {
		const activeToolsRef = { tools: [] as string[] };
		const { pi, handlers, appendEntry } = makePi({
			activeTools: () => activeToolsRef.tools,
		});
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, makeCtx());
		// Simulate user activating the tool
		activeToolsRef.tools = ["ec2_instance_watcher"];
		await handlers.turnEnd!({}, makeCtx());
		// Should have written state with enabled=true (appendEntry called)
		expect(appendEntry).toHaveBeenCalled();
	});
});
