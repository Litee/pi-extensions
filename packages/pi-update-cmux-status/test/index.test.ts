import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setCmuxSpawnerForTests } from "../src/cmux.js";
import createExtension, { runRename, shortCwd } from "../src/index.js";

// ---------------------------------------------------------------------------
// Test doubles — minimal ExtensionAPI / ExtensionContext
// ---------------------------------------------------------------------------

interface StubPi {
	on: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
	sendMessage: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
	readonly handlers: Map<string, (...args: unknown[]) => unknown>;
	readonly commands: Map<
		string,
		{
			description: string;
			handler: (args: string, ctx: unknown) => unknown | Promise<unknown>;
		}
	>;
}

function makeFakePi(): StubPi {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const commands = new Map<
		string,
		{
			description: string;
			handler: (args: string, ctx: unknown) => unknown | Promise<unknown>;
		}
	>();
	const on = vi.fn((evt: string, fn: (...a: unknown[]) => unknown) => {
		handlers.set(evt, fn);
	});
	const registerCommand = vi.fn(
		(
			name: string,
			def: {
				description: string;
				handler: (args: string, ctx: unknown) => unknown | Promise<unknown>;
			},
		) => {
			commands.set(name, def);
		},
	);
	return {
		on,
		registerCommand,
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		handlers,
		commands,
	};
}

function makeFakeCtx(opts: { hasModel?: boolean; authOk?: boolean } = {}): {
	model: unknown;
	modelRegistry: { getApiKeyAndHeaders: ReturnType<typeof vi.fn> };
	ui: { notify: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> };
} {
	const authOk = opts.authOk ?? true;
	return {
		model: opts.hasModel === false ? undefined : { id: "fake" },
		modelRegistry: {
			getApiKeyAndHeaders: vi.fn(async () =>
				authOk ? { ok: true, apiKey: "k", headers: {} } : { ok: false },
			),
		},
		ui: { notify: vi.fn(), setStatus: vi.fn() },
	};
}

// ---------------------------------------------------------------------------
// Helpers to toggle cmuxAvailable() from tests
// ---------------------------------------------------------------------------

function enterCmux(): () => void {
	const prevWs = process.env["CMUX_WORKSPACE_ID"];
	const prevTab = process.env["CMUX_TAB_ID"];
	process.env["CMUX_WORKSPACE_ID"] = "ws-test";
	process.env["CMUX_TAB_ID"] = "tab-test";
	return () => {
		if (prevWs === undefined) delete process.env["CMUX_WORKSPACE_ID"];
		else process.env["CMUX_WORKSPACE_ID"] = prevWs;
		if (prevTab === undefined) delete process.env["CMUX_TAB_ID"];
		else process.env["CMUX_TAB_ID"] = prevTab;
	};
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("shortCwd", () => {
	it("returns the trailing path component", () => {
		expect(shortCwd("/path/to/pi-extensions")).toBe(
			"pi-extensions",
		);
	});

	it("handles trailing slashes", () => {
		expect(shortCwd("/foo/bar/")).toBe("bar");
	});

	it("falls back to 'pi' for empty input", () => {
		expect(shortCwd("")).toBe("pi");
		expect(shortCwd("/")).toBe("pi");
	});
});

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

describe("default export — wiring", () => {
	it("subscribes to every lifecycle event the source .ts uses", () => {
		const pi = makeFakePi();
		createExtension(pi as never);

		const subscribed = pi.on.mock.calls.map((c) => c[0]);
		for (const evt of [
			"session_start",
			"session_shutdown",
			"input",
			"before_agent_start",
			"agent_end",
			"tool_execution_start",
			"tool_execution_end",
		]) {
			expect(subscribed).toContain(evt);
		}
	});

	it("registers the /cmux-rename command", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		expect(pi.commands.get("cmux-rename")).toBeDefined();
		expect(pi.commands.get("cmux-rename")?.description).toMatch(/name/i);
	});
});

// ---------------------------------------------------------------------------
// runRename — LLM-driven dispatch (names fetched via injected stub)
// ---------------------------------------------------------------------------

describe("runRename", () => {
	let spawner: ReturnType<typeof vi.fn>;
	let restore: () => void;

	beforeEach(() => {
		restore = enterCmux();
		spawner = vi.fn(async () => {});
		__setCmuxSpawnerForTests(
			spawner as unknown as (args: string[]) => Promise<void>,
		);
	});
	afterEach(() => {
		restore();
		__setCmuxSpawnerForTests(null);
	});

	it("does nothing when not in cmux", async () => {
		restore();
		restore = () => {};
		delete process.env["CMUX_WORKSPACE_ID"];
		const ok = await runRename(
			makeFakeCtx() as never,
			"prompt",
			{
				statusKey: "pi",
				renameWorkspace: true,
				fetchNames: async () => ({ tab: "T", workspace: "W" }),
			},
		);
		expect(ok).toBe(false);
		expect(spawner).not.toHaveBeenCalled();
	});

	it("returns false when fetchNames returns undefined", async () => {
		const ok = await runRename(
			makeFakeCtx() as never,
			"prompt",
			{
				statusKey: "pi",
				renameWorkspace: true,
				fetchNames: async () => undefined,
			},
		);
		expect(ok).toBe(false);
		// Only the fetch, not any cmux call.
		expect(spawner).not.toHaveBeenCalled();
	});

	it("dispatches rename-tab and rename-workspace when fetchNames succeeds", async () => {
		const ok = await runRename(
			makeFakeCtx() as never,
			"prompt",
			{
				statusKey: "pi",
				renameWorkspace: true,
				fetchNames: async () => ({ tab: "Add CMux Status", workspace: "Pi Extensions" }),
			},
		);
		expect(ok).toBe(true);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual([
			"rename-tab",
			"--",
			"Add CMux Status",
		]);
		expect(argvs).toContainEqual([
			"workspace-action",
			"--action",
			"rename",
			"--title",
			"Pi Extensions",
		]);
		// A log line also goes through.
		expect(argvs.some((a) => a[0] === "log")).toBe(true);
	});

	it("skips the workspace rename when renameWorkspace=false", async () => {
		const ok = await runRename(
			makeFakeCtx() as never,
			"prompt",
			{
				statusKey: "pi",
				renameWorkspace: false,
				fetchNames: async () => ({ tab: "T", workspace: "W" }),
			},
		);
		expect(ok).toBe(true);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual(["rename-tab", "--", "T"]);
		expect(argvs.some((a) => a[0] === "workspace-action")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// /cmux-rename command
// ---------------------------------------------------------------------------

describe("/cmux-rename command", () => {
	let restore: () => void;
	let spawner: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		restore = enterCmux();
		spawner = vi.fn(async () => {});
		__setCmuxSpawnerForTests(
			spawner as unknown as (args: string[]) => Promise<void>,
		);
	});
	afterEach(() => {
		restore();
		__setCmuxSpawnerForTests(null);
	});

	it("warns when not running inside cmux", async () => {
		restore();
		restore = () => {};
		delete process.env["CMUX_WORKSPACE_ID"];

		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await pi.commands.get("cmux-rename")!.handler("some text", ctx as never);
		const notifies = ctx.ui.notify.mock.calls.map((c) => [String(c[0]), String(c[1])]);
		expect(notifies.some(([m, lvl]) => m !== undefined && /not running inside cmux/i.test(m) && lvl === "warning")).toBe(true);
	});

	it("warns when invoked with no args and no first-prompt captured", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await pi.commands.get("cmux-rename")!.handler("", ctx as never);
		const notifies = ctx.ui.notify.mock.calls.map((c) => String(c[0]));
		expect(notifies.some((m) => /No prompt yet/i.test(m))).toBe(true);
	});

	it("dispatches a rename when args provide the prompt", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();

		// Swap out runRename's names source by replacing completeSimple indirectly:
		// the command path calls generateNames → completeSimple, which we can't
		// easily stub here without module-level mocks. Instead we verify that
		// a failed model call surfaces the "Rename failed" notify.
		ctx.modelRegistry.getApiKeyAndHeaders = vi.fn(async () => ({ ok: false }));
		await pi.commands.get("cmux-rename")!.handler("a new prompt", ctx as never);
		const notifies = ctx.ui.notify.mock.calls.map((c) => String(c[0]));
		expect(notifies.some((m) => /Renaming/i.test(m))).toBe(true);
		expect(notifies.some((m) => /Rename failed/i.test(m))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// session_start → idle pill, session_shutdown → clear
// ---------------------------------------------------------------------------

describe("session lifecycle side-effects", () => {
	let restore: () => void;
	let spawner: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		restore = enterCmux();
		spawner = vi.fn(async () => {});
		__setCmuxSpawnerForTests(
			spawner as unknown as (args: string[]) => Promise<void>,
		);
	});
	afterEach(() => {
		restore();
		__setCmuxSpawnerForTests(null);
	});

	it("session_start emits set-status idle + a session-started log line", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("session_start")!({}, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "idle")).toBe(true);
		expect(argvs.some((a) => a[0] === "log" && a.some((s) => s.includes("pi session started")))).toBe(true);
	});

	it("before_agent_start flips the pill to 'working'", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("before_agent_start")!({}, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual([
			"set-status",
			"pi",
			"working",
			"--icon",
			"bolt",
			"--color",
			"#ff9500",
		]);
	});

	it("tool_execution_start uses the tool name as the pill value", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("tool_execution_start")!({ toolName: "read" }, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "read")).toBe(true);
		expect(argvs.some((a) => a[0] === "log" && a.some((s) => s.includes("Running read")))).toBe(true);
	});

	it("tool_execution_end failure path logs at error level", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("tool_execution_end")!(
			{ toolName: "bash", isError: true },
			makeFakeCtx(),
		);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		const logCall = argvs.find((a) => a[0] === "log");
		expect(logCall).toBeDefined();
		expect(logCall!).toContain("error");
		expect(logCall!.some((s) => /bash failed/.test(s))).toBe(true);
	});

	it("tool_execution_end treats nested result.isError as a failure", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("tool_execution_end")!(
			{ toolName: "bash", result: { isError: true } },
			makeFakeCtx(),
		);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		const logCall = argvs.find((a) => a[0] === "log");
		expect(logCall).toBeDefined();
		expect(logCall!).toContain("error");
	});

	it("tool_execution_end success path logs at success level", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("tool_execution_end")!({ toolName: "read" }, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		const logCall = argvs.find((a) => a[0] === "log");
		expect(logCall).toBeDefined();
		expect(logCall!).toContain("success");
		expect(logCall!.some((s) => /read done/.test(s))).toBe(true);
	});

	it("agent_end clears progress, sets idle, and sends a notify", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("agent_end")!({}, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual(["clear-progress"]);
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "idle")).toBe(true);
		expect(argvs.some((a) => a[0] === "notify")).toBe(true);
	});

	it("session_shutdown clears progress and the status pill", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("session_shutdown")!({}, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual(["clear-progress"]);
		expect(argvs).toContainEqual(["set-status", "pi", ""]);
	});
});

// ---------------------------------------------------------------------------
// input handler gating
// ---------------------------------------------------------------------------

describe("input handler", () => {
	let restore: () => void;
	let spawner: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		restore = enterCmux();
		spawner = vi.fn(async () => {});
		__setCmuxSpawnerForTests(
			spawner as unknown as (args: string[]) => Promise<void>,
		);
	});
	afterEach(() => {
		restore();
		__setCmuxSpawnerForTests(null);
	});

	it("ignores slash commands", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "/help" },
			ctx,
		);
		// No model call is made, so no auth lookup.
		expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("ignores empty text", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await pi.handlers.get("input")!({ source: "interactive", text: "   " }, ctx);
		expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("ignores non-interactive sources", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await pi.handlers.get("input")!({ source: "api", text: "hello" }, ctx);
		expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("only fires on the first eligible prompt per session", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx({ authOk: false });

		await pi.handlers.get("input")!({ source: "interactive", text: "first" }, ctx);
		const firstCalls = ctx.modelRegistry.getApiKeyAndHeaders.mock.calls.length;
		expect(firstCalls).toBeGreaterThan(0);

		await pi.handlers.get("input")!({ source: "interactive", text: "second" }, ctx);
		// No additional auth lookups — the second prompt is ignored.
		expect(ctx.modelRegistry.getApiKeyAndHeaders.mock.calls.length).toBe(
			firstCalls,
		);
	});
});
