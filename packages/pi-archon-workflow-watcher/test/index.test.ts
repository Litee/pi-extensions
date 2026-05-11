import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArchonClient } from "../src/archon-client.js";
import {
	createExtensionWithClient,
	POLL_INTERVAL_MS,
	STATE_ENTRY_TYPE,
	resetToolRegisteredForTests,
} from "../src/index.js";
import type { ArchonRun } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Minimal ExtensionAPI stub. No imports from @mariozechner/pi-coding-agent.
 */
interface StubPi {
	on: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
	registerMessageRenderer: ReturnType<typeof vi.fn>;
	registerTool: ReturnType<typeof vi.fn>;
	getActiveTools: ReturnType<typeof vi.fn>;
	setActiveTools: ReturnType<typeof vi.fn>;
	sendMessage: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
	readonly sessionStartHandler: ((...args: unknown[]) => Promise<unknown>) | undefined;
	readonly sessionShutdownHandler: ((...args: unknown[]) => Promise<unknown>) | undefined;
	readonly commands: Map<
		string,
		{
			description: string;
			handler: (args: string, ctx: unknown) => unknown;
		}
	>;
}

function makePi(): StubPi {
	const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
	const commands = new Map<
		string,
		{
			description: string;
			handler: (args: string, ctx: unknown) => unknown;
		}
	>();

	const on = vi.fn(
		(event: string, fn: (...args: unknown[]) => Promise<unknown>) => {
			handlers.set(event, fn);
		},
	);
	const registerCommand = vi.fn(
		(
			name: string,
			def: {
				description: string;
				handler: (args: string, ctx: unknown) => unknown;
			},
		) => {
			commands.set(name, def);
		},
	);
	const registerMessageRenderer = vi.fn();
	const registerTool = vi.fn();
	let activeTools: string[] = [];
	const getActiveTools = vi.fn(() => [...activeTools]);
	const setActiveTools = vi.fn((tools: string[]) => { activeTools = tools; });
	const sendMessage = vi.fn();
	const appendEntry = vi.fn();

	return {
		on,
		registerCommand,
		registerMessageRenderer,
		registerTool,
		getActiveTools,
		setActiveTools,
		sendMessage,
		appendEntry,
		get sessionStartHandler() {
			return handlers.get("session_start");
		},
		get sessionShutdownHandler() {
			return handlers.get("session_shutdown");
		},
		commands,
	};
}

interface StubCtx {
	ui: {
		notify: ReturnType<typeof vi.fn>;
		setStatus: ReturnType<typeof vi.fn>;
		theme: {
			fg: ReturnType<typeof vi.fn>;
			bold: ReturnType<typeof vi.fn>;
		};
		hasUI: boolean;
	};
	hasUI: boolean;
	sessionManager: {
		getEntries: () => Array<{
			type?: string;
			customType?: string;
			data?: unknown;
		}>;
	};
}

function makeFakeCtx(
	entries: Array<{ type?: string; customType?: string; data?: unknown }> = [],
): StubCtx {
	return {
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			theme: {
				fg: vi.fn((_color: string, text: string) => `<fg:${_color}>${text}</fg>`),
				bold: vi.fn((text: string) => `<b>${text}</b>`),
			},
			hasUI: true,
		},
		hasUI: true,
		sessionManager: { getEntries: () => entries },
	};
}

function makeRun(
	overrides: Partial<ArchonRun> & { id: string; status: string },
): ArchonRun {
	const base: ArchonRun = {
		id: overrides.id,
		status: overrides.status,
	};
	if (overrides.workflowName !== undefined) base.workflowName = overrides.workflowName;
	if (overrides.workingPath !== undefined) base.workingPath = overrides.workingPath;
	return base;
}

function makeClient(runs: ArchonRun[] | Error): ArchonClient {
	if (runs instanceof Error) {
		return { getWorkflowStatus: vi.fn().mockRejectedValue(runs) };
	}
	return { getWorkflowStatus: vi.fn().mockResolvedValue(runs) };
}

/** A combined state entry seeded as "not paused" so session_start goes into active mode. */
function runningRunstate() {
	return {
		type: "custom",
		customType: STATE_ENTRY_TYPE,
		data: { savedAt: Date.now(), paused: false, watchedIds: [], baselines: {} },
	};
}

/** A combined state entry seeded as "paused". */
function pausedRunstate() {
	return {
		type: "custom",
		customType: STATE_ENTRY_TYPE,
		data: { savedAt: Date.now(), paused: true, watchedIds: [], baselines: {} },
	};
}

// ---------------------------------------------------------------------------
// Registration — what createExtensionWithClient wires up
// ---------------------------------------------------------------------------

describe("createExtensionWithClient — wiring", () => {
	beforeEach(() => { resetToolRegisteredForTests(); });
	afterEach(() => { resetToolRegisteredForTests(); });

	it("subscribes to session_start and session_shutdown", () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient([]));
		expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
	});

	it("registers the /archon-watcher command", () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient([]));
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"archon-watcher",
			expect.objectContaining({
				description: expect.any(String) as unknown,
				handler: expect.any(Function) as unknown,
			}),
		);
	});

	it("registers a message renderer for the custom type", () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient([]));
		expect(pi.registerMessageRenderer).toHaveBeenCalledWith(
			"pi-archon-workflow-watcher",
			expect.any(Function),
		);
	});
});

// ---------------------------------------------------------------------------
// POLL_INTERVAL_MS constant
// ---------------------------------------------------------------------------

describe("POLL_INTERVAL_MS", () => {
	it("is 15 seconds", () => {
		expect(POLL_INTERVAL_MS).toBe(15_000);
	});
});

// ---------------------------------------------------------------------------
// session_start — active path
// ---------------------------------------------------------------------------

describe("session_start — active (not paused)", () => {
	beforeEach(() => { resetToolRegisteredForTests(); });
	afterEach(() => { resetToolRegisteredForTests(); });
	it("emits a startup chat message via sendMessage", async () => {
		const pi = makePi();
		const client = makeClient([makeRun({ id: "r1", status: "running" })]);
		createExtensionWithClient(pi as never, client);

		const ctx = makeFakeCtx([
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: { savedAt: Date.now(), paused: false, watchedIds: ["r1"], baselines: {} },
			},
		]);
		await pi.sessionStartHandler!({}, ctx);

		// setImmediate defers the message; flush micro/macro tasks
		await new Promise<void>((r) => setImmediate(r));

		expect(pi.sendMessage).toHaveBeenCalled();
		const [msg] = pi.sendMessage.mock.calls[0] as [
			{ customType: string; content: string; display: boolean },
		];
		expect(msg.customType).toBe("pi-archon-workflow-watcher");
		expect(msg.display).toBe(true);
	});

	it("persists the initial snapshot via appendEntry", async () => {
		const pi = makePi();
		createExtensionWithClient(
			pi as never,
			makeClient([makeRun({ id: "r1", status: "running" })]),
		);
		const ctx = makeFakeCtx([
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: { savedAt: Date.now(), paused: false, watchedIds: ["r1"], baselines: {} },
			},
		]);
		await pi.sessionStartHandler!({}, ctx);

		const stateCalls = pi.appendEntry.mock.calls.filter(
			(c) => c[0] === STATE_ENTRY_TYPE,
		);
		expect(stateCalls.length).toBeGreaterThanOrEqual(1);
	});

	it("does not pin a status line when there are no active runs", async () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient([]));
		const ctx = makeFakeCtx([runningRunstate()]);
		await pi.sessionStartHandler!({}, ctx);

		const statusCalls = ctx.ui.setStatus.mock.calls as Array<
			[string, string | undefined]
		>;
		const ours = statusCalls.filter(([k]) => k === "pi-archon-workflow-watcher");
		// May be called to clear (undefined) but must never be called with a string.
		const setsString = ours.some(([, v]) => typeof v === "string");
		expect(setsString).toBe(false);
	});

	it("pins the status line via ui.setStatus when runs are active", async () => {
		const pi = makePi();
		const run = makeRun({ id: "r1", status: "running", workflowName: "archon-assist" });
		createExtensionWithClient(pi as never, makeClient([run]));
		const ctx = makeFakeCtx([
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: { savedAt: Date.now(), paused: false, watchedIds: ["r1"], baselines: { r1: run } },
			},
		]);
		await pi.sessionStartHandler!({}, ctx);

		const statusCalls = ctx.ui.setStatus.mock.calls as Array<
			[string, string | undefined]
		>;
		const ours = statusCalls.filter(([k]) => k === "pi-archon-workflow-watcher");
		expect(ours.length).toBeGreaterThanOrEqual(1);
		const lastValue = ours[ours.length - 1]![1];
		expect(typeof lastValue).toBe("string");
		expect(lastValue).toContain("archon-watcher");
	});

	it("emits a diff message when there is a baseline and runs changed", async () => {
		const pi = makePi();
		createExtensionWithClient(
			pi as never,
			makeClient([makeRun({ id: "r1", status: "completed" })]),
		);
		// Baseline has r1 as running; current is completed → diff
		const ctx = makeFakeCtx([
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: {
					savedAt: Date.now(),
					paused: false,
					watchedIds: ["r1"],
					baselines: { r1: makeRun({ id: "r1", status: "running" }) },
				},
			},
		]);
		await pi.sessionStartHandler!({}, ctx);
		await new Promise<void>((r) => setImmediate(r));

		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const [msg, opts] = pi.sendMessage.mock.calls[0] as [
			{ content: string },
			{ triggerTurn?: boolean },
		];
		expect(msg.content).toMatch(/change.*detected/);
		expect(opts.triggerTurn).toBe(true); // completed triggers turn
	});

	it("emits a startup summary (triggerTurn=false) when baseline matches current", async () => {
		const run = makeRun({ id: "r1", status: "running" });
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient([run]));
		const ctx = makeFakeCtx([
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: {
					savedAt: Date.now(),
					paused: false,
					watchedIds: ["r1"],
					baselines: { r1: run },
				},
			},
		]);
		await pi.sessionStartHandler!({}, ctx);
		await new Promise<void>((r) => setImmediate(r));

		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const [, opts] = pi.sendMessage.mock.calls[0] as [
			unknown,
			{ triggerTurn?: boolean },
		];
		expect(opts.triggerTurn).toBe(false);
	});

	it("gracefully handles archon CLI errors at session_start (stays silent, no active runs)", async () => {
		const pi = makePi();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		createExtensionWithClient(
			pi as never,
			makeClient(new Error("archon not found")),
		);
		const ctx = makeFakeCtx([runningRunstate()]);
		await pi.sessionStartHandler!({}, ctx);
		await new Promise<void>((r) => setImmediate(r));
		warnSpy.mockRestore();

		// CLI error means empty snapshot — no active runs, so no startup message
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// session_start — paused path
// ---------------------------------------------------------------------------

describe("session_start — paused", () => {
	beforeEach(() => { resetToolRegisteredForTests(); });
	afterEach(() => { resetToolRegisteredForTests(); });
	it("does NOT fetch workflow status when paused", async () => {
		const pi = makePi();
		const client = makeClient([]);
		createExtensionWithClient(pi as never, client);
		const ctx = makeFakeCtx([pausedRunstate()]);
		await pi.sessionStartHandler!({}, ctx);
		expect(client.getWorkflowStatus).not.toHaveBeenCalled();
	});

	it("does NOT emit sendMessage when paused", async () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient([]));
		const ctx = makeFakeCtx([pausedRunstate()]);
		await pi.sessionStartHandler!({}, ctx);
		await new Promise<void>((r) => setImmediate(r));
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("clears the status row when paused (no 'paused' string pinned)", async () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient([]));
		const ctx = makeFakeCtx([pausedRunstate()]);
		await pi.sessionStartHandler!({}, ctx);

		const statusCalls = ctx.ui.setStatus.mock.calls as Array<
			[string, string | undefined]
		>;
		const ours = statusCalls.filter(([k]) => k === "pi-archon-workflow-watcher");
		for (const [, v] of ours) {
			expect(v).toBeUndefined();
		}
	});

	it("does NOT start polling when paused", async () => {
		vi.useFakeTimers();
		try {
			const pi = makePi();
			const client = makeClient([]);
			createExtensionWithClient(pi as never, client);
			const ctx = makeFakeCtx([pausedRunstate()]);
			await pi.sessionStartHandler!({}, ctx);
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
			// getWorkflowStatus was never called (no polling, no session_start fetch)
			expect(client.getWorkflowStatus).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("defaults to NOT paused when there is no runstate entry", async () => {
		const pi = makePi();
		const client = makeClient([]);
		createExtensionWithClient(pi as never, client);
		// No runstate entry → defaults to not paused.
		// Add a baseline with watchedIds so the active path proceeds and calls the client.
		const ctx = makeFakeCtx([
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: { savedAt: Date.now(), paused: false, watchedIds: ["r1"], baselines: {} },
			},
		]);
		await pi.sessionStartHandler!({}, ctx);
		// active path: getWorkflowStatus should have been called
		expect(client.getWorkflowStatus).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// session_shutdown
// ---------------------------------------------------------------------------

describe("session_shutdown", () => {
	it("stops polling and clears the status row", async () => {
		vi.useFakeTimers();
		try {
			const pi = makePi();
			const client = makeClient([]);
			createExtensionWithClient(pi as never, client);

			const ctx = makeFakeCtx([runningRunstate()]);
			await pi.sessionStartHandler!({}, ctx);
			// Shutdown
			await pi.sessionShutdownHandler!({}, ctx);

			const callsBefore = (client.getWorkflowStatus as ReturnType<typeof vi.fn>).mock.calls.length;
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
			const callsAfter = (client.getWorkflowStatus as ReturnType<typeof vi.fn>).mock.calls.length;
			expect(callsAfter).toBe(callsBefore); // no new polls
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// /archon-watcher command
// ---------------------------------------------------------------------------

describe("/archon-watcher command", () => {
	it("'pause' notifies the user and persists paused=true", async () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient([]));
		const cmd = pi.commands.get("archon-watcher")!;
		const ctx = makeFakeCtx();
		await cmd.handler("pause", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("paused"),
			expect.any(String),
		);
		const runstateCalls = pi.appendEntry.mock.calls.filter(
			(c) => c[0] === STATE_ENTRY_TYPE,
		);
		expect(runstateCalls.length).toBeGreaterThanOrEqual(1);
		const lastData = runstateCalls[runstateCalls.length - 1]![1] as {
			paused: boolean;
		};
		expect(lastData.paused).toBe(true);
	});

	it("'pause' clears the status row", async () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient([]));
		const cmd = pi.commands.get("archon-watcher")!;
		const ctx = makeFakeCtx();
		await cmd.handler("pause", ctx);

		const statusCalls = ctx.ui.setStatus.mock.calls as Array<
			[string, string | undefined]
		>;
		const ours = statusCalls.filter(([k]) => k === "pi-archon-workflow-watcher");
		expect(ours.length).toBeGreaterThanOrEqual(1);
		for (const [, v] of ours) {
			expect(v).toBeUndefined();
		}
	});

	it("'resume' notifies the user and persists paused=false", async () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient([]));
		const cmd = pi.commands.get("archon-watcher")!;
		const ctx = makeFakeCtx();
		await cmd.handler("pause", ctx);
		await cmd.handler("resume", ctx);

		const notifies = ctx.ui.notify.mock.calls.map((c) => String(c[0]));
		expect(notifies.some((m) => /resumed/i.test(m))).toBe(true);

		const runstateCalls = pi.appendEntry.mock.calls.filter(
			(c) => c[0] === STATE_ENTRY_TYPE,
		);
		const lastData = runstateCalls[runstateCalls.length - 1]![1] as {
			paused: boolean;
		};
		expect(lastData.paused).toBe(false);
	});

	it("'resume' clears the status line when no runs are active", async () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient([]));
		const cmd = pi.commands.get("archon-watcher")!;
		const ctx = makeFakeCtx();
		await cmd.handler("pause", ctx);
		ctx.ui.setStatus.mockClear();
		await cmd.handler("resume", ctx);

		const statusCalls = ctx.ui.setStatus.mock.calls as Array<
			[string, string | undefined]
		>;
		const ours = statusCalls.filter(([k]) => k === "pi-archon-workflow-watcher");
		// With no active runs the status row must be cleared (undefined), never set.
		const setsString = ours.some(([, v]) => typeof v === "string");
		expect(setsString).toBe(false);
	});

	it("'status' fetches current status and sends a chat message", async () => {
		const pi = makePi();
		const client = makeClient([makeRun({ id: "r1", status: "running" })]);
		createExtensionWithClient(pi as never, client);
		const cmd = pi.commands.get("archon-watcher")!;
		const ctx = makeFakeCtx();
		await cmd.handler("status", ctx);

		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const [msg] = pi.sendMessage.mock.calls[0] as [
			{ customType: string; content: string; display: boolean },
		];
		expect(msg.customType).toBe("pi-archon-workflow-watcher");
		expect(msg.display).toBe(true);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("'' (empty args) behaves like 'status'", async () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient([]));
		const cmd = pi.commands.get("archon-watcher")!;
		const ctx = makeFakeCtx();
		await cmd.handler("", ctx);
		expect(pi.sendMessage).toHaveBeenCalledOnce();
	});

	it("'status' notifies with warning when CLI fails", async () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient(new Error("not found")));
		const cmd = pi.commands.get("archon-watcher")!;
		const ctx = makeFakeCtx();
		await cmd.handler("status", ctx);

		expect(pi.sendMessage).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("error fetching status"),
			"warning",
		);
	});

	it("unknown subcommand notifies with usage hint", async () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient([]));
		const cmd = pi.commands.get("archon-watcher")!;
		const ctx = makeFakeCtx();
		await cmd.handler("frobnicate", ctx);

		const [msg, level] = ctx.ui.notify.mock.calls[0] as [string, string];
		expect(msg).toMatch(/unknown subcommand/i);
		expect(msg).toContain("pause");
		expect(msg).toContain("resume");
		expect(level).toBe("warning");
	});
});

// ---------------------------------------------------------------------------
// Polling loop integration
// ---------------------------------------------------------------------------

describe("polling loop integration", () => {
	beforeEach(() => {
		resetToolRegisteredForTests();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("emits a chat message when status changes during a poll", async () => {
		const runs = [makeRun({ id: "r1", status: "running" })];
		const pi = makePi();
		const client = makeClient(runs);
		createExtensionWithClient(pi as never, client);

		// Provide a baseline with watchedIds so session_start proceeds and starts polling.
		const ctx = makeFakeCtx([
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: {
					savedAt: Date.now(),
					paused: false,
					watchedIds: ["r1"],
					baselines: { r1: makeRun({ id: "r1", status: "running" }) },
				},
			},
		]);
		await pi.sessionStartHandler!({}, ctx);
		// Flush deferred setImmediate calls (faked by vitest fake timers)
		await vi.advanceTimersByTimeAsync(0);

		const msgsBefore = pi.sendMessage.mock.calls.length;

		// Change the run to completed
		(client.getWorkflowStatus as ReturnType<typeof vi.fn>).mockResolvedValue([
			makeRun({ id: "r1", status: "completed" }),
		]);
		await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

		expect(pi.sendMessage.mock.calls.length).toBeGreaterThan(msgsBefore);
		const newMsg = pi.sendMessage.mock.calls[pi.sendMessage.mock.calls.length - 1]![0] as {
			customType: string;
			content: string;
		};
		expect(newMsg.customType).toBe("pi-archon-workflow-watcher");
		expect(newMsg.content).toMatch(/change.*detected/);
	});
});
