import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setCmuxSpawnerForTests } from "../src/cmux.js";
import createExtension, {
	__setFetchNamesForTests,
	RENAMED_ENTRY_TYPE,
	runRename,
	shortCwd,
} from "../src/index.js";

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

interface FakeEntry {
	type?: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string; content?: unknown };
}

function makeFakeCtx(
	opts: {
		hasModel?: boolean;
		authOk?: boolean;
		/** Items returned from `sessionManager.getEntries()` (custom entries). */
		entries?: FakeEntry[];
		/** Items returned from `sessionManager.getBranch()` (chat messages). */
		branch?: FakeEntry[];
	} = {},
): {
	model: unknown;
	modelRegistry: { getApiKeyAndHeaders: ReturnType<typeof vi.fn> };
	ui: { notify: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> };
	sessionManager: {
		getEntries: ReturnType<typeof vi.fn>;
		getBranch: ReturnType<typeof vi.fn>;
	};
} {
	const authOk = opts.authOk ?? true;
	const entries = opts.entries ?? [];
	const branch = opts.branch ?? [];
	return {
		model: opts.hasModel === false ? undefined : { id: "fake" },
		modelRegistry: {
			getApiKeyAndHeaders: vi.fn(async () =>
				authOk ? { ok: true, apiKey: "k", headers: {} } : { ok: false },
			),
		},
		ui: { notify: vi.fn(), setStatus: vi.fn() },
		sessionManager: {
			getEntries: vi.fn(() => entries),
			getBranch: vi.fn(() => branch),
		},
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

	it("warns when invoked with no args and no user messages in the session", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await pi.commands.get("cmux-rename")!.handler("", ctx as never);
		const notifies = ctx.ui.notify.mock.calls.map((c) => String(c[0]));
		expect(notifies.some((m) => /No user prompts/i.test(m))).toBe(true);
	});

	it("dispatches a rename using the current session branch, ignoring args", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx({
			branch: [
				{ type: "message", message: { role: "user", content: "what I want" } },
			],
		});
		await pi.handlers.get("session_start")!({}, ctx);

		// Force the model call to fail so we see both "Renaming…" (attempt) and
		// "Rename failed" (error) notifies — proving the handler proceeded past
		// the no-prompt guard using the session branch rather than the args.
		ctx.modelRegistry.getApiKeyAndHeaders = vi.fn(async () => ({ ok: false }));
		await pi.commands.get("cmux-rename")!.handler("this arg is ignored", ctx as never);
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

// ---------------------------------------------------------------------------
// session_start rehydrate — persistent once-per-session flag (issue #0001)
// ---------------------------------------------------------------------------

describe("session_start rehydrate (persistent once-per-session)", () => {
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
		__setFetchNamesForTests(null);
	});

	it("exports RENAMED_ENTRY_TYPE as the session-log custom-type key", () => {
		expect(RENAMED_ENTRY_TYPE).toBe("cmux-status-renamed");
	});

	it("skips auto-rename on input when a prior RENAMED entry is in the session log", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx({
			authOk: false,
			entries: [
				{
					type: "custom",
					customType: RENAMED_ENTRY_TYPE,
					data: { savedAt: 1, firstPrompt: "old prompt" },
				},
			],
		});
		await pi.handlers.get("session_start")!({}, ctx);
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "new prompt after reload" },
			ctx,
		);
		// No auto-rename attempt on the post-reload prompt.
		expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("restores the once-flag so /cmux-rename still works post-reload via session branch", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx({
			authOk: false,
			entries: [
				{
					type: "custom",
					customType: RENAMED_ENTRY_TYPE,
					data: { savedAt: 1 },
				},
			],
			branch: [
				{
					type: "message",
					message: { role: "user", content: "fix this bug" },
				},
			],
		});
		await pi.handlers.get("session_start")!({}, ctx);
		await pi.commands.get("cmux-rename")!.handler("", ctx as never);
		const notifies = ctx.ui.notify.mock.calls.map((c) => String(c[0]));
		// "No user prompts" warning must NOT appear — branch has a user message.
		expect(notifies.every((m) => !/No user prompts/i.test(m))).toBe(true);
		// The "Renaming" notice SHOULD appear — handler progressed past the guard.
		expect(notifies.some((m) => /Renaming/i.test(m))).toBe(true);
	});

	it("defaults to unnamed when the session log has no RENAMED entry", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx({ authOk: false, entries: [] });
		await pi.handlers.get("session_start")!({}, ctx);
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "hello" },
			ctx,
		);
		expect(ctx.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalled();
	});

	it("ignores malformed or foreign entries when rehydrating", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx({
			authOk: false,
			entries: [
				{ type: "custom", customType: RENAMED_ENTRY_TYPE, data: null },
				{
					type: "custom",
					customType: "some-other-type",
					data: { savedAt: 1 },
				},
				{
					type: "custom",
					customType: RENAMED_ENTRY_TYPE,
					data: { savedAt: "not-a-number" },
				},
			],
		});
		await pi.handlers.get("session_start")!({}, ctx);
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "fresh" },
			ctx,
		);
		// Should have tried to auto-rename — no valid rehydrate suppressed it.
		expect(ctx.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalled();
	});

	it("picks up the RENAMED flag when a valid marker exists (among invalid ones)", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx({
			authOk: false,
			entries: [
				{ type: "custom", customType: RENAMED_ENTRY_TYPE, data: null },
				{ type: "custom", customType: RENAMED_ENTRY_TYPE, data: { savedAt: 2 } },
			],
		});
		await pi.handlers.get("session_start")!({}, ctx);
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "fresh" },
			ctx,
		);
		// Valid marker found — auto-rename must be suppressed.
		expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("suppresses auto-rename when a newer valid RENAMED entry exists alongside older ones", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx({
			authOk: false,
			entries: [
				{
					type: "custom",
					customType: RENAMED_ENTRY_TYPE,
					data: { savedAt: 1 },
				},
				{
					type: "custom",
					customType: RENAMED_ENTRY_TYPE,
					data: { savedAt: 2 },
				},
			],
		});
		await pi.handlers.get("session_start")!({}, ctx);
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "fresh" },
			ctx,
		);
		expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// pi.appendEntry on successful rename (issue #0001)
// ---------------------------------------------------------------------------

describe("pi.appendEntry on rename", () => {
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
		__setFetchNamesForTests(null);
	});

	it("auto-rename path persists the RENAMED marker on success", async () => {
		__setFetchNamesForTests(async () => ({ tab: "T", workspace: "W" }));
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await pi.handlers.get("session_start")!({}, ctx);
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "first prompt" },
			ctx,
		);
		// `input` handler is fire-and-forget; runRename is awaited inside, so
		// a microtask flush is enough.
		await new Promise((r) => setImmediate(r));
		expect(pi.appendEntry).toHaveBeenCalledWith(
			RENAMED_ENTRY_TYPE,
			expect.objectContaining({ savedAt: expect.any(Number) }),
		);
		// Payload is marker-only — no firstPrompt field.
		const [, payload] = pi.appendEntry.mock.calls[0]!;
		expect((payload as { firstPrompt?: unknown }).firstPrompt).toBeUndefined();
	});

	it("auto-rename failure path does NOT persist the RENAMED entry", async () => {
		__setFetchNamesForTests(async () => undefined);
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await pi.handlers.get("session_start")!({}, ctx);
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "first prompt" },
			ctx,
		);
		await new Promise((r) => setImmediate(r));
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("/cmux-rename success path persists the RENAMED marker (uses session branch)", async () => {
		__setFetchNamesForTests(async (_ctx, prompt) => {
			// Capture what was actually passed so we can assert the branch
			// content is used, not any stored first-prompt.
			capturedPrompt = prompt;
			return { tab: "T", workspace: "W" };
		});
		let capturedPrompt = "";
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx({
			branch: [
				{
					type: "message",
					message: { role: "user", content: "the current thing" },
				},
			],
		});
		await pi.handlers.get("session_start")!({}, ctx);
		await pi.commands.get("cmux-rename")!.handler("", ctx as never);
		expect(capturedPrompt).toContain("the current thing");
		expect(pi.appendEntry).toHaveBeenCalledWith(
			RENAMED_ENTRY_TYPE,
			expect.objectContaining({ savedAt: expect.any(Number) }),
		);
	});

	it("/cmux-rename uses the *current* session branch, not the auto-rename first prompt", async () => {
		let capturedPrompt = "";
		__setFetchNamesForTests(async (_ctx, prompt) => {
			capturedPrompt = prompt;
			return { tab: "T", workspace: "W" };
		});
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx({
			branch: [
				{
					type: "message",
					message: { role: "user", content: "initial auto-named topic" },
				},
				{
					type: "message",
					message: { role: "assistant", content: "..." },
				},
				{
					type: "message",
					message: {
						role: "user",
						content: "now the session is about this other thing",
					},
				},
			],
		});
		await pi.handlers.get("session_start")!({}, ctx);
		await pi.commands.get("cmux-rename")!.handler("", ctx as never);
		expect(capturedPrompt).toContain("initial auto-named topic");
		expect(capturedPrompt).toContain("now the session is about this other thing");
	});

	it("/cmux-rename ignores trailing text arguments", async () => {
		let capturedPrompt = "";
		__setFetchNamesForTests(async (_ctx, prompt) => {
			capturedPrompt = prompt;
			return { tab: "T", workspace: "W" };
		});
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx({
			branch: [
				{
					type: "message",
					message: { role: "user", content: "branch prompt" },
				},
			],
		});
		await pi.handlers.get("session_start")!({}, ctx);
		await pi.commands.get("cmux-rename")!.handler(
			"should be ignored",
			ctx as never,
		);
		expect(capturedPrompt).toBe("branch prompt");
		expect(capturedPrompt).not.toContain("should be ignored");
	});

	it("/cmux-rename warns and does not call appendEntry when no user prompts exist", async () => {
		__setFetchNamesForTests(async () => ({ tab: "T", workspace: "W" }));
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx({ branch: [] });
		await pi.handlers.get("session_start")!({}, ctx);
		await pi.commands.get("cmux-rename")!.handler("", ctx as never);
		expect(pi.appendEntry).not.toHaveBeenCalled();
		const notifies = ctx.ui.notify.mock.calls.map((c) => String(c[0]));
		expect(notifies.some((m) => /No user prompts/i.test(m))).toBe(true);
	});

	it("/cmux-rename failure path does NOT persist the RENAMED marker", async () => {
		__setFetchNamesForTests(async () => undefined);
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx({
			branch: [
				{
					type: "message",
					message: { role: "user", content: "something to rename from" },
				},
			],
		});
		await pi.handlers.get("session_start")!({}, ctx);
		pi.appendEntry.mockClear();
		await pi.commands.get("cmux-rename")!.handler("", ctx as never);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});
});

