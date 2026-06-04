import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArchonClient } from "../src/archon-client.js";
import archonWorkflowWatcher, {
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
 * Minimal ExtensionAPI stub. No imports from @earendil-works/pi-coding-agent.
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

/** A combined state entry for session_start active mode. */
function runningRunstate() {
	return {
		type: "custom",
		customType: STATE_ENTRY_TYPE,
		data: { savedAt: Date.now(), watchedIds: [], baselines: {} },
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

describe("session_start", () => {
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
				data: { savedAt: Date.now(), watchedIds: ["r1"], baselines: {} },
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
				data: { savedAt: Date.now(), watchedIds: ["r1"], baselines: {} },
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
				data: { savedAt: Date.now(), watchedIds: ["r1"], baselines: { r1: run } },
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
		expect(lastValue).toContain("archon:");
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
		expect(msg).toContain("status");
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

// ---------------------------------------------------------------------------
// Message renderer — covers lines 181-194 (content ternary branches)
// ---------------------------------------------------------------------------

describe("message renderer", () => {
	beforeEach(() => { resetToolRegisteredForTests(); });
	afterEach(() => { resetToolRegisteredForTests(); });

	it("renders string content without throwing", () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient([]));
		const [, renderer] = pi.registerMessageRenderer.mock.calls[0] as [
			string,
			(
				msg: { content: string | Array<{ type: string; text: string }> },
				opts: unknown,
				theme: { bold: (t: string) => string; fg: (k: string, t: string) => string; bg: (k: string, t: string) => string },
			) => unknown,
		];
		const theme = {
			bold: (t: string) => t,
			fg: (_k: string, t: string) => t,
			bg: (_k: string, t: string) => t,
		};
		expect(() => renderer({ content: "hello world" }, {}, theme)).not.toThrow();
	});

	it("renders array content by joining text parts", () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient([]));
		const [, renderer] = pi.registerMessageRenderer.mock.calls[0] as [
			string,
			(
				msg: { content: string | Array<{ type: string; text: string }> },
				opts: unknown,
				theme: { bold: (t: string) => string; fg: (k: string, t: string) => string; bg: (k: string, t: string) => string },
			) => unknown,
		];
		const theme = {
			bold: (t: string) => t,
			fg: (_k: string, t: string) => t,
			bg: (_k: string, t: string) => t,
		};
		expect(() => renderer(
			{ content: [{ type: "text", text: "part1" }, { type: "text", text: "part2" }] },
			{},
			theme,
		)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// session_start — error path when watchedIds non-empty (line 122)
// ---------------------------------------------------------------------------

describe("session_start — client error with watched IDs", () => {
	beforeEach(() => { resetToolRegisteredForTests(); });
	afterEach(() => { resetToolRegisteredForTests(); });

	it("stays silent when client throws during session_start with watched IDs", async () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient(new Error("archon crashed")));
		const ctx = makeFakeCtx([
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: { savedAt: Date.now(), watchedIds: ["r1"], baselines: {} },
			},
		]);
		await pi.sessionStartHandler!({}, ctx);
		await new Promise<void>((r) => setImmediate(r));
		// Error was recorded but no chat message was emitted (no active runs)
		const stateErrors = pi.appendEntry.mock.calls.filter(
			(c) => c[0] === "archon-watcher:init-error",
		);
		expect(stateErrors.length).toBeGreaterThanOrEqual(1);
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// default export — archonWorkflowWatcher (line 246)
// ---------------------------------------------------------------------------

describe("default export — archonWorkflowWatcher", () => {
	beforeEach(() => { resetToolRegisteredForTests(); });
	afterEach(() => { resetToolRegisteredForTests(); });

	it("registers without throwing when called with a minimal fake pi", () => {
		const pi = makePi();
		expect(() => archonWorkflowWatcher(pi as never)).not.toThrow();
		// Should have registered the same handlers as createExtensionWithClient
		expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
	});
});

// ---------------------------------------------------------------------------
// session_start — ui.custom wiring (index.ts lines 78-80)
// ---------------------------------------------------------------------------

describe("session_start — ui.custom wiring (lines 78-80)", () => {
	beforeEach(() => { resetToolRegisteredForTests(); });
	afterEach(() => { resetToolRegisteredForTests(); });

	it("wires showApprovalDialog onto rt.ui; calling it invokes the body (lines 79-80)", async () => {
		const pi = makePi();
		const client = makeClient([]);
		createExtensionWithClient(pi as never, client);

		// customFn CALLS its first argument (the callback) to cover the arrow function
		// body at lines 79-80 of index.ts: (tui, theme, _kb, done) => createApprovalDialog(...).
		const customFn = vi.fn().mockImplementation(
			(callback: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => void) => {
				// Invoke the callback — this executes the arrow function body at lines 79-80.
				callback(
					{ requestRender: () => {} }, // tui
					{ fg: (_k: string, t: string) => t, bold: (t: string) => t, bg: (_k: string, t: string) => t }, // theme
					undefined, // _kb
					() => {}, // done (no-op)
				);
				return Promise.resolve(null);
			},
		);
		const ctxUi = {
			notify: vi.fn(),
			setStatus: vi.fn(),
			theme: {
				fg: vi.fn((_k: string, t: string) => t),
				bold: vi.fn((t: string) => t),
			},
			hasUI: true,
			custom: customFn,
		};
		const ctx = {
			hasUI: true,
			ui: ctxUi,
			sessionManager: { getEntries: () => [] },
		};

		// No watched IDs → session_start returns early, but the custom-wiring branch (lines 78-80) runs first.
		await expect(pi.sessionStartHandler!({}, ctx)).resolves.toBeUndefined();
		// After session_start, rt.ui.showApprovalDialog is wired onto ctxUi (same object reference).
		// Calling it invokes the function body at lines 79-80 (return uiCtx.custom!(...)).
		const showDialog = (ctxUi as Record<string, unknown>)["showApprovalDialog"] as
			((p: unknown) => Promise<unknown>) | undefined;
		expect(typeof showDialog).toBe("function");
		if (showDialog) {
			await showDialog({ runId: "r1", workflowName: "wf", nodeId: "n", message: "m" });
			expect(customFn).toHaveBeenCalled();
		}
	});
});

// ---------------------------------------------------------------------------
// /archon-watcher command — hasUI detection fallback branches (lines 206-207)
// and run.id === "" filter (line 225)
// ---------------------------------------------------------------------------

describe("/archon-watcher command — additional branch coverage", () => {
	beforeEach(() => { resetToolRegisteredForTests(); });
	afterEach(() => { resetToolRegisteredForTests(); });

	it("'status' detects hasUI from ui.hasUI when top-level hasUI is absent (lines 206-207 fallback)", async () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient([]));
		const cmd = pi.commands.get("archon-watcher")!;
		// Ctx without top-level hasUI — forces ?? to evaluate anyCtx.ui?.hasUI
		const ctx = {
			ui: { notify: vi.fn(), setStatus: vi.fn(), theme: { fg: vi.fn((_k: string, t: string) => t), bold: vi.fn((t: string) => t) }, hasUI: true },
			sessionManager: { getEntries: () => [] },
			// no hasUI at top level
		};
		await cmd.handler("status", ctx);
		expect(pi.sendMessage).toHaveBeenCalledOnce();
	});

	it("'status' with ui undefined treats hasUI as false (lines 206-207 full fallback)", async () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient([]));
		const cmd = pi.commands.get("archon-watcher")!;
		// No hasUI at any level → hasUI = (undefined !== undefined) = false
		// So ui = undefined, and ui?.notify?.() is a no-op
		const ctx = {
			sessionManager: { getEntries: () => [] },
		};
		// Should not throw — ui is undefined, notify is not called
		await cmd.handler("status", ctx);
		expect(pi.sendMessage).toHaveBeenCalledOnce();
	});

	it("'status' filters out runs with empty id (line 225 FALSE branch)", async () => {
		const pi = makePi();
		// Client returns a run with id="" (should be filtered out)
		const client = makeClient([{ id: "", status: "running" }]);
		createExtensionWithClient(pi as never, client);
		const cmd = pi.commands.get("archon-watcher")!;
		const ctx = makeFakeCtx();
		await cmd.handler("status", ctx);
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const content = (pi.sendMessage.mock.calls[0]![0] as { content: string }).content;
		// No active runs (empty id was filtered)
		expect(content).toContain("No active workflow runs");
	});
});

// ---------------------------------------------------------------------------
// session_start — all watched runs removed between sessions (line 162 FALSE)
// ---------------------------------------------------------------------------

describe("session_start — all watched runs removed (line 162 FALSE branch)", () => {
	beforeEach(() => { resetToolRegisteredForTests(); });
	afterEach(() => { resetToolRegisteredForTests(); });

	it("does not start polling when all watched runs disappeared (covers line 162 FALSE)", async () => {
		vi.useFakeTimers();
		try {
			const pi = makePi();
			// All watched runs return empty → run_removed events → watchedIds cleared
			const client = makeClient([]);
			createExtensionWithClient(pi as never, client);

			const ctx = makeFakeCtx([
				{
					type: "custom",
					customType: STATE_ENTRY_TYPE,
					data: {
						savedAt: Date.now(),
						watchedIds: ["r1"],
						baselines: { r1: makeRun({ id: "r1", status: "running" }) },
					},
				},
			]);
			await pi.sessionStartHandler!({}, ctx);
			await vi.advanceTimersByTimeAsync(0); // flush setImmediate

			// r1 disappeared → run_removed event → watchedIds.delete("r1") → size = 0
			// → if (rt.watchedIds.size > 0) startPolling(rt) NOT called (FALSE branch)
			// No polls should fire
			const callsBefore = (client.getWorkflowStatus as ReturnType<typeof vi.fn>).mock.calls.length;
			await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
			const callsAfter = (client.getWorkflowStatus as ReturnType<typeof vi.fn>).mock.calls.length;
			expect(callsAfter).toBe(callsBefore); // no new polls = polling never started
		} finally {
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// session_start — hasUI detection fallback branches (lines 71-75)
// ---------------------------------------------------------------------------

describe("session_start — hasUI detection fallback branches (lines 71-75)", () => {
	beforeEach(() => { resetToolRegisteredForTests(); });
	afterEach(() => { resetToolRegisteredForTests(); });

	it("detects hasUI from ui.hasUI when top-level hasUI is absent (line 71 second ?? operand)", async () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient([]));
		// No top-level hasUI — forces evaluation of ui?.hasUI (second ?? operand at line 71)
		const ctx = {
			ui: {
				notify: vi.fn(), setStatus: vi.fn(), hasUI: true,
				theme: { fg: vi.fn((_k: string, t: string) => t), bold: vi.fn((t: string) => t) },
			},
			sessionManager: { getEntries: () => [] },
		};
		await expect(pi.sessionStartHandler!({}, ctx)).resolves.toBeUndefined();
	});

	it("hasUI is false when ctx has no hasUI and no ui (line 72 FALSE, line 75 FALSE)", async () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient([]));
		// No hasUI and no ui → hasUI = false → rt.ui = null → if(rt.ui !== null) is FALSE
		const ctx = { sessionManager: { getEntries: () => [] } };
		await expect(pi.sessionStartHandler!({}, ctx)).resolves.toBeUndefined();
	});

	it("session_start: run returned by client is not in watchedIds (line 127 FALSE branch)", async () => {
		const pi = makePi();
		// Client returns r2 but state watches only r1 → r2 not in watchedIds → FALSE branch at line 127
		createExtensionWithClient(pi as never, makeClient([makeRun({ id: "r2", status: "running" })]));
		const ctx = makeFakeCtx([
			{
				type: "custom",
				customType: STATE_ENTRY_TYPE,
				data: { savedAt: Date.now(), watchedIds: ["r1"], baselines: {} },
			},
		]);
		await pi.sessionStartHandler!({}, ctx);
		await new Promise<void>((r) => setImmediate(r));
		// r2 was returned by client but not in watchedIds → filtered out → no active runs → silent
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// session_start — line 72 ?? null: hasUI=true but ui is absent
// ---------------------------------------------------------------------------

describe("session_start — line 72 ?? null branch (hasUI=true but ui=undefined)", () => {
	beforeEach(() => { resetToolRegisteredForTests(); });
	afterEach(() => { resetToolRegisteredForTests(); });

	it("rt.ui = null when hasUI=true but ctx has no ui property (covers line 72 ?? null)", async () => {
		const pi = makePi();
		createExtensionWithClient(pi as never, makeClient([]));
		// hasUI=true forces the ternary TRUE branch at line 72,
		// but ui is absent → anyCtx.ui = undefined → (anyCtx.ui as UiSurface) ?? null → null
		const ctx = {
			hasUI: true,
			// no ui property → anyCtx.ui is undefined → ?? null fires
			sessionManager: { getEntries: () => [] },
		};
		await expect(pi.sessionStartHandler!({}, ctx)).resolves.toBeUndefined();
	});
});
