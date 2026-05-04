import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setCmuxSpawnerForTests } from "../src/cmux.js";
import { __setCmuxReaderForTests } from "../src/cmuxReader.js";
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
	const prevSurface = process.env["CMUX_SURFACE_ID"];
	process.env["CMUX_WORKSPACE_ID"] = "ws-test";
	process.env["CMUX_TAB_ID"] = "tab-test";
	// Tests must not inherit the real-shell CMUX_SURFACE_ID — `readTabTitle`
	// uses that env var as a fast path and would short-circuit the stubbed
	// reader if we left the host value in place.
	delete process.env["CMUX_SURFACE_ID"];
	// Install a fail-open reader stub so tests that don't care about the
	// prefix gate (all of the pre-#0003 tests) keep getting the 'rename
	// unconditionally' behaviour. Individual tests can override by calling
	// `__setCmuxReaderForTests` themselves.
	__setCmuxReaderForTests(async () => { throw new Error("reader disabled in tests"); });
	return () => {
		if (prevWs === undefined) delete process.env["CMUX_WORKSPACE_ID"];
		else process.env["CMUX_WORKSPACE_ID"] = prevWs;
		if (prevTab === undefined) delete process.env["CMUX_TAB_ID"];
		else process.env["CMUX_TAB_ID"] = prevTab;
		if (prevSurface === undefined) delete process.env["CMUX_SURFACE_ID"];
		else process.env["CMUX_SURFACE_ID"] = prevSurface;
		__setCmuxReaderForTests(null);
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
	it("subscribes to the two-state lifecycle events + ask_user_question attention wiring (#0002)", () => {
		const pi = makeFakePi();
		createExtension(pi as never);

		const subscribed = pi.on.mock.calls.map((c) => c[0]);
		// Four events drive the two-state model.
		for (const evt of [
			"session_start",
			"session_shutdown",
			"input",
			"agent_end",
		]) {
			expect(subscribed).toContain(evt);
		}
		// Two more carry the hardcoded attention signal for
		// `ask_user_question`; they no-op on any other tool name.
		expect(subscribed).toContain("tool_execution_start");
		expect(subscribed).toContain("tool_execution_end");
		// `before_agent_start` is intentionally not wired — the pill is
		// flipped to 'working' from the `input` handler instead (#0002).
		expect(subscribed).not.toContain("before_agent_start");
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
				fetchNames: async () => ({ workspace: "W" }),
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
		expect(spawner).not.toHaveBeenCalled();
	});

	it("dispatches rename-workspace when fetchNames succeeds", async () => {
		const ok = await runRename(
			makeFakeCtx() as never,
			"prompt",
			{
				statusKey: "pi",
				renameWorkspace: true,
				fetchNames: async () => ({ workspace: "Pi Extensions" }),
			},
		);
		expect(ok).toBe(true);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual([
			"workspace-action",
			"--action",
			"rename",
			"--title",
			"Pi Extensions",
		]);
		// Tab rename was removed in #0003 — no rename-tab call must ever go out.
		expect(argvs.some((a) => a[0] === "rename-tab")).toBe(false);
		expect(argvs.some((a) => a[0] === "log")).toBe(true);
	});

	it("is a no-op when renameWorkspace=false", async () => {
		// With tab rename gone, `renameWorkspace=false` means there is
		// nothing left for the extension to rename. runRename still reaches
		// a decision (log + persist-marker), so it returns true.
		const ok = await runRename(
			makeFakeCtx() as never,
			"prompt",
			{
				statusKey: "pi",
				renameWorkspace: false,
				fetchNames: async () => ({ workspace: "W" }),
			},
		);
		expect(ok).toBe(true);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "workspace-action")).toBe(false);
		expect(argvs.some((a) => a[0] === "rename-tab")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// runRename — prefix gate (#0003)
// ---------------------------------------------------------------------------

describe("runRename — prefix gate (#0003)", () => {
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
		__setCmuxReaderForTests(null);
	});

	/** Install a read-side stub that returns a preset workspace title. */
	function stubWorkspaceTitle(title: string): void {
		__setCmuxReaderForTests(async (args) => {
			if (args.join(" ") === "rpc workspace.current") {
				return JSON.stringify({ workspace: { title } });
			}
			return "";
		});
	}

	it("renames when the current workspace title starts with 'Terminal '", async () => {
		stubWorkspaceTitle("Terminal 12");
		const ok = await runRename(
			makeFakeCtx() as never,
			"prompt",
			{
				statusKey: "pi",
				renameWorkspace: true,
				fetchNames: async () => ({ workspace: "Fresh WS" }),
			},
		);
		expect(ok).toBe(true);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual([
			"workspace-action",
			"--action",
			"rename",
			"--title",
			"Fresh WS",
		]);
	});

	it("skips the rename when the workspace title looks user-set", async () => {
		stubWorkspaceTitle("My Important Workspace");
		const ok = await runRename(
			makeFakeCtx() as never,
			"prompt",
			{
				statusKey: "pi",
				renameWorkspace: true,
				fetchNames: async () => ({ workspace: "Fresh WS" }),
			},
		);
		expect(ok).toBe(true); // decision made → caller persists the once-per-session marker
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "workspace-action")).toBe(false);
	});

	it("fails open when the read path throws — renames unconditionally", async () => {
		__setCmuxReaderForTests(async () => { throw new Error("rpc failed"); });
		const ok = await runRename(
			makeFakeCtx() as never,
			"prompt",
			{
				statusKey: "pi",
				renameWorkspace: true,
				fetchNames: async () => ({ workspace: "Fresh WS" }),
			},
		);
		expect(ok).toBe(true);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual([
			"workspace-action",
			"--action",
			"rename",
			"--title",
			"Fresh WS",
		]);
	});

	it("skipPrefixGate bypasses the check (used by /cmux-rename)", async () => {
		stubWorkspaceTitle("User-Set Workspace");
		const ok = await runRename(
			makeFakeCtx() as never,
			"prompt",
			{
				statusKey: "pi",
				renameWorkspace: true,
				skipPrefixGate: true,
				fetchNames: async () => ({ workspace: "Fresh WS" }),
			},
		);
		expect(ok).toBe(true);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual([
			"workspace-action",
			"--action",
			"rename",
			"--title",
			"Fresh WS",
		]);
	});

	it("never dispatches a rename-tab call, regardless of the gate outcome (tab rename removed in #0003)", async () => {
		for (const [title, bypass] of [
			["Terminal 3", false],
			["User Set", false],
			["Terminal 3", true],
			["User Set", true],
		] as Array<[string, boolean]>) {
			stubWorkspaceTitle(title);
			spawner.mockClear();
			await runRename(
				makeFakeCtx() as never,
				"prompt",
				{
					statusKey: "pi",
					renameWorkspace: true,
					skipPrefixGate: bypass,
					fetchNames: async () => ({ workspace: "Fresh WS" }),
				},
			);
			const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
			expect(argvs.some((a) => a[0] === "rename-tab")).toBe(false);
		}
	});
});

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

	it("before_agent_start handler is NOT registered (#0002)", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		expect(pi.handlers.get("before_agent_start")).toBeUndefined();
	});

	it("tool_execution_start is a no-op for tools outside the attention list (#0002)", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("tool_execution_start")!({ toolName: "read" }, makeFakeCtx());
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		// No pill update, no progress log, no notify for `read`.
		expect(argvs.some((a) => a[0] === "set-status")).toBe(false);
		expect(argvs.some((a) => a[0] === "log")).toBe(false);
		expect(argvs.some((a) => a[0] === "notify")).toBe(false);
	});

	it("tool_execution_end is a no-op for tools outside the attention list (#0002)", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("tool_execution_end")!(
			{ toolName: "bash", isError: true },
			makeFakeCtx(),
		);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "set-status")).toBe(false);
		expect(argvs.some((a) => a[0] === "log")).toBe(false);
	});

	it("tool_execution_start on ask_user_question flips pill to 'waiting' and fires a notify (#0002)", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("tool_execution_start")!(
			{ toolName: "ask_user_question" },
			makeFakeCtx(),
		);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "waiting")).toBe(
			true,
		);
		expect(argvs.some((a) => a[0] === "notify")).toBe(true);
	});

	it("tool_execution_end on ask_user_question reverts pill to 'working' (#0002)", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		await pi.handlers.get("tool_execution_start")!(
			{ toolName: "ask_user_question" },
			makeFakeCtx(),
		);
		spawner.mockClear();
		await pi.handlers.get("tool_execution_end")!(
			{ toolName: "ask_user_question" },
			makeFakeCtx(),
		);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "working")).toBe(
			true,
		);
		expect(argvs.some((a) => a[0] === "notify")).toBe(false);
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
		// And no 'working' pill transition — slash commands are noise-free (#0002).
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "working")).toBe(
			false,
		);
	});

	it("ignores empty text", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await pi.handlers.get("input")!({ source: "interactive", text: "   " }, ctx);
		expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "working")).toBe(
			false,
		);
	});

	it("ignores non-interactive sources", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await pi.handlers.get("input")!({ source: "api", text: "hello" }, ctx);
		expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "set-status" && a[2] === "working")).toBe(
			false,
		);
	});

	it("flips the pill to 'working' on an eligible user message (#0002)", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx({ authOk: false });
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "do a thing" },
			ctx,
		);
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

	it("still flips the pill to 'working' after the once-per-session rename has fired (#0002)", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx({ authOk: false });

		await pi.handlers.get("input")!(
			{ source: "interactive", text: "first" },
			ctx,
		);
		const afterFirst = spawner.mock.calls.length;
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "second" },
			ctx,
		);
		const argvsAfterSecond = spawner.mock.calls
			.slice(afterFirst)
			.map((c) => c[0] as string[]);
		expect(argvsAfterSecond).toContainEqual([
			"set-status",
			"pi",
			"working",
			"--icon",
			"bolt",
			"--color",
			"#ff9500",
		]);
		expect(ctx.modelRegistry.getApiKeyAndHeaders.mock.calls.length).toBe(1);
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
		__setFetchNamesForTests(async () => ({ workspace: "W" }));
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
			return { workspace: "W" };
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
			return { workspace: "W" };
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
			return { workspace: "W" };
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
		__setFetchNamesForTests(async () => ({ workspace: "W" }));
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

