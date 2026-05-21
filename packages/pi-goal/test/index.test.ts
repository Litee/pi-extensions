/**
 * Integration-style tests for the pi-goal extension wiring (issue #0004).
 *
 * The extension's `default export` takes an `ExtensionAPI` and registers
 * commands, shortcuts, event handlers, message renderers, and tools. We
 * stub the API in-process so we can drive each lifecycle event without
 * standing up the full pi runtime.
 *
 * Coverage focus:
 *   - `update_goal` is registered when the goal loop starts and not before.
 *   - `update_goal({summary})` signals a blocked state: warning notify +
 *     status follow-up that includes turns+tokens and the blocker summary.
 *   - Completion is NOT routed through this tool (verifier handles that).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import piGoal from "../src/index.js";
import { resetUpdateGoalToolRegisteredForTests } from "../src/updateGoalTool.js";

// ---------------------------------------------------------------------------
// Helpers — stub the slice of ExtensionAPI / ExtensionContext we need.
// ---------------------------------------------------------------------------

interface CommandSpec {
	description: string;
	handler: (args: string, ctx: unknown) => Promise<void> | void;
}

interface ToolSpec {
	name: string;
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<unknown>;
}

interface PiHarness {
	pi: ExtensionAPI;
	commands: Record<string, CommandSpec>;
	tools: Record<string, ToolSpec>;
	registerToolMock: ReturnType<typeof vi.fn>;
	setActiveToolsMock: ReturnType<typeof vi.fn>;
	sendMessageMock: ReturnType<typeof vi.fn>;
	appendEntryMock: ReturnType<typeof vi.fn>;
	getActiveTools: () => string[];
	activeTools: string[];
	/** Fire a registered pi.on handler by event name. */
	fireEvent: (name: string, event: unknown, ctx: unknown) => Promise<void>;
}

function makePi(): PiHarness {
	const commands: Record<string, CommandSpec> = {};
	const tools: Record<string, ToolSpec> = {};
	const registerToolMock = vi.fn((tool: ToolSpec) => {
		tools[tool.name] = tool;
	});
	const activeTools: string[] = [];
	const setActiveToolsMock = vi.fn((names: string[]) => {
		activeTools.length = 0;
		activeTools.push(...names);
	});
	const sendMessageMock = vi.fn();
	const appendEntryMock = vi.fn();
	const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers[name] = handlers[name] ?? [];
			handlers[name].push(handler);
		},
		registerCommand: (name: string, spec: CommandSpec) => {
			commands[name] = spec;
		},
		registerShortcut: vi.fn(),
		registerTool: registerToolMock,
		registerMessageRenderer: vi.fn(),
		sendMessage: sendMessageMock,
		appendEntry: appendEntryMock,
		getActiveTools: () => [...activeTools],
		setActiveTools: setActiveToolsMock,
		events: { emit: vi.fn(), on: vi.fn().mockReturnValue(() => {}) },
	} as unknown as ExtensionAPI;
	const fireEvent = async (name: string, event: unknown, ctx: unknown): Promise<void> => {
		for (const h of handlers[name] ?? []) {
			await h(event, ctx);
		}
	};
	return {
		pi,
		commands,
		tools,
		registerToolMock,
		setActiveToolsMock,
		sendMessageMock,
		appendEntryMock,
		getActiveTools: () => [...activeTools],
		activeTools,
		fireEvent,
	};
}

interface CtxOpts {
	tokens?: number;
	sessionEntries?: unknown[];
}

function makeCtx(opts: CtxOpts = {}): unknown {
	return {
		hasUI: true,
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			input: vi.fn(),
		},
		getContextUsage: () => ({ tokens: opts.tokens ?? 0 }),
		sessionManager: {
			getEntries: () => opts.sessionEntries ?? [],
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
	resetUpdateGoalToolRegisteredForTests();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("pi-goal /goal command — update_goal tool registration (#0004)", () => {
	it("does NOT register update_goal at extension load time", () => {
		const h = makePi();
		piGoal(h.pi);
		const calls = h.registerToolMock.mock.calls.map((c) => (c[0] as ToolSpec).name);
		expect(calls).not.toContain("update_goal");
	});

	it("registers update_goal when /goal <objective> kicks off the loop", async () => {
		const h = makePi();
		piGoal(h.pi);
		const ctx = makeCtx();
		await h.commands["goal"]!.handler("ship the feature", ctx);

		expect(h.tools["update_goal"]).toBeDefined();
		// Tool must be added to the active set so the LLM can see it.
		expect(h.activeTools).toContain("update_goal");
	});

	it("removes update_goal from active set when /goal stop disables the loop", async () => {
		const h = makePi();
		piGoal(h.pi);
		const ctx = makeCtx();
		await h.commands["goal"]!.handler("ship the feature", ctx);
		expect(h.activeTools).toContain("update_goal");

		await h.commands["goal"]!.handler("stop", ctx);
		expect(h.activeTools).not.toContain("update_goal");
	});
});

describe("pi-goal update_goal tool — blocked path (#0004)", () => {
	it("ends the loop on the blocked path with a labelled notify + follow-up", async () => {
		const h = makePi();
		piGoal(h.pi);
		const ctx = makeCtx({ tokens: 4321 });
		await h.commands["goal"]!.handler("deploy the service", ctx);

		const tool = h.tools["update_goal"]!;
		await tool.execute(
			"call-1",
			{ status: "blocked", summary: "missing IAM role to deploy" },
			undefined,
			undefined,
			ctx,
		);

		const ctxUI = (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui;
		// Notify clearly labels this as blocked and surfaces the blocker.
		const blockedNotify = ctxUI.notify.mock.calls.find(
			(c) =>
				typeof c[0] === "string" &&
				/blocked/i.test(c[0]) &&
				c[0].includes("missing IAM role"),
		);
		expect(blockedNotify).toBeDefined();
		// Severity warns the user — this is not a clean success.
		expect(blockedNotify?.[1]).toBe("warning");

		// Follow-up message body mirrors success/abort shape (#0003): turns
		// + tokens + objective + the blocker summary.
		const followUpCall = h.sendMessageMock.mock.calls.find((c) => {
			const arg = c[0] as { content?: unknown };
			return typeof arg.content === "string" && /blocked/i.test(arg.content);
		});
		expect(followUpCall).toBeDefined();
		const content = (followUpCall?.[0] as { content: string }).content;
		expect(content).toContain("deploy the service");
		expect(content).toContain("missing IAM role to deploy");
		expect(content).toMatch(/turn\(s\)/);
		expect(content).toMatch(/tokens used/);

		// Active tool removed once the loop exits.
		expect(h.activeTools).not.toContain("update_goal");
	});
});

describe("pi-goal session_start — restore resumed goal with update_goal (#0004 D1)", () => {
	it("re-registers and re-activates update_goal when a persisted enabled goal is restored", async () => {
		const h = makePi();
		piGoal(h.pi);

		const persistedEntry = {
			type: "custom",
			customType: "pi-goal:state",
			data: {
				enabled: true,
				objective: "resumed objective",
				iterations: 3,
				maxIterations: 20,
				tokenBudget: 200_000,
				tokenBaseline: 500,
			},
		};
		const ctx = makeCtx({ tokens: 1000, sessionEntries: [persistedEntry] });

		await h.fireEvent("session_start", {}, ctx);

		// Tool must be registered so the LLM can see it.
		const registeredNames = h.registerToolMock.mock.calls.map(
			(c) => (c[0] as { name: string }).name,
		);
		expect(registeredNames).toContain("update_goal");
		// Tool must be in the active set.
		expect(h.activeTools).toContain("update_goal");
	});

	it("calling update_goal after restore exits the loop correctly", async () => {
		const h = makePi();
		piGoal(h.pi);

		const persistedEntry = {
			type: "custom",
			customType: "pi-goal:state",
			data: {
				enabled: true,
				objective: "deploy the app",
				iterations: 2,
				maxIterations: 20,
				tokenBudget: 200_000,
				tokenBaseline: 100,
			},
		};
		const ctx = makeCtx({ tokens: 2000, sessionEntries: [persistedEntry] });
		await h.fireEvent("session_start", {}, ctx);

		const tool = h.tools["update_goal"]!;
		await tool.execute(
			"call-restored",
			{ status: "blocked", summary: "missing deploy credentials" },
			undefined,
			undefined,
			ctx,
		);

		const ctxUI = (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui;
		const blockedNotify = ctxUI.notify.mock.calls.find(
			(c) => typeof c[0] === "string" && /blocked/i.test(c[0]),
		);
		expect(blockedNotify).toBeDefined();
		expect(blockedNotify?.[1]).toBe("warning");
		expect(h.activeTools).not.toContain("update_goal");
	});
});

describe("pi-goal update_goal tool — !goalEnabled guard (#0004 T2)", () => {
	it("does not fire notify or sendMessage when goal mode was already disabled before execute runs", async () => {
		const h = makePi();
		piGoal(h.pi);
		const ctx = makeCtx();
		await h.commands["goal"]!.handler("finish the report", ctx);

		// Disable goal mode before the tool execute arrives.
		await h.commands["goal"]!.handler("stop", ctx);
		expect(h.activeTools).not.toContain("update_goal");

		const sendCallsBefore = h.sendMessageMock.mock.calls.length;
		const ctxUI = (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui;
		const notifyCallsBefore = ctxUI.notify.mock.calls.length;

		// Tool execute arrives late — goal is already off.
		const tool = h.tools["update_goal"]!;
		await tool.execute(
			"late-call",
			{ status: "blocked", summary: "this should be a no-op" },
			undefined,
			undefined,
			ctx,
		);

		// Neither a new notify nor a new sendMessage must have fired.
		expect(h.sendMessageMock.mock.calls.length).toBe(sendCallsBefore);
		expect(ctxUI.notify.mock.calls.length).toBe(notifyCallsBefore);
	});
});

describe("pi-goal update_goal tool — persistState after blocked (#0004 T4)", () => {
	it("appends a disabled state entry after the blocked path ends the loop", async () => {
		const h = makePi();
		piGoal(h.pi);
		const ctx = makeCtx({ tokens: 999 });
		await h.commands["goal"]!.handler("write the spec", ctx);

		h.appendEntryMock.mockClear();

		const tool = h.tools["update_goal"]!;
		await tool.execute(
			"call-1",
			{ status: "blocked", summary: "spec format unclear" },
			undefined,
			undefined,
			ctx,
		);

		// At least one appendEntry call must carry enabled:false so that a
		// subsequent session_start does not re-enter goal mode.
		const disablingCalls = h.appendEntryMock.mock.calls.filter((c) => {
			const data = c[1] as { enabled?: boolean } | undefined;
			return data?.enabled === false;
		});
		expect(disablingCalls.length).toBeGreaterThan(0);
	});
});
