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
	// Install a reader stub that returns a default `Terminal 1` title so
	// tests that don't care about the prefix gate pass it by default
	// (the gate is now fail-closed under #0004 — a null read would suppress
	// the rename, not let it through). Individual tests can override by
	// calling `__setCmuxReaderForTests` themselves.
	__setCmuxReaderForTests(async (args) => {
		if (args.join(" ") === "rpc workspace.current") {
			return JSON.stringify({ workspace: { title: "Terminal 1" } });
		}
		return "";
	});
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

	it("fails closed when the read path throws — skips this turn, does NOT call LLM (#0004)", async () => {
		const fetchSpy = vi.fn(async () => ({ workspace: "Fresh WS" }));
		__setCmuxReaderForTests(async () => { throw new Error("rpc failed"); });
		const ok = await runRename(
			makeFakeCtx() as never,
			"prompt",
			{
				statusKey: "pi",
				renameWorkspace: true,
				fetchNames: fetchSpy,
			},
		);
		expect(ok).toBe(false); // no decision — next message retries
		expect(fetchSpy).not.toHaveBeenCalled();
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "workspace-action")).toBe(false);
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

	// -- issue #0004: gate runs BEFORE the LLM call, flag dance ---------------

	it("gate runs BEFORE the LLM call when the title is user-set (#0004)", async () => {
		// No LLM should ever be invoked on a workspace the user has already
		// named. Runs the gate read first; if it returns a non-`Terminal `
		// title, fetchNames must not be called.
		stubWorkspaceTitle("My Project");
		const fetchSpy = vi.fn(async () => ({ workspace: "Should Not Be Seen" }));
		const rt = { namedThisSession: false };
		const ok = await runRename(
			makeFakeCtx() as never,
			"prompt",
			{
				statusKey: "pi",
				renameWorkspace: true,
				fetchNames: fetchSpy,
				runtime: rt,
			},
		);
		expect(ok).toBe(true); // decision made (skip)
		expect(fetchSpy).not.toHaveBeenCalled();
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "workspace-action")).toBe(false);
		// Flag must stay false so a subsequent /cmux-rename (or a revert
		// of the title to `Terminal N`) can still fire.
		expect(rt.namedThisSession).toBe(false);
	});

	it("flag is set to true after a successful dispatch (#0004)", async () => {
		stubWorkspaceTitle("Terminal 12");
		const fetchSpy = vi.fn(async () => ({ workspace: "Fresh WS" }));
		const rt = { namedThisSession: false };
		const ok = await runRename(
			makeFakeCtx() as never,
			"prompt",
			{
				statusKey: "pi",
				renameWorkspace: true,
				fetchNames: fetchSpy,
				runtime: rt,
			},
		);
		expect(ok).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(rt.namedThisSession).toBe(true);
	});

	it("flag is reset to false when the LLM call fails (#0004)", async () => {
		stubWorkspaceTitle("Terminal 12");
		const fetchSpy = vi.fn(async () => undefined);
		const rt = { namedThisSession: false };
		const ok = await runRename(
			makeFakeCtx() as never,
			"prompt",
			{
				statusKey: "pi",
				renameWorkspace: true,
				fetchNames: fetchSpy,
				runtime: rt,
			},
		);
		expect(ok).toBe(false);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(rt.namedThisSession).toBe(false); // released for retry
	});

	it("flag is reset to false when the gate read fails closed (#0004)", async () => {
		__setCmuxReaderForTests(async () => { throw new Error("rpc failed"); });
		const fetchSpy = vi.fn(async () => ({ workspace: "Fresh WS" }));
		const rt = { namedThisSession: false };
		const ok = await runRename(
			makeFakeCtx() as never,
			"prompt",
			{
				statusKey: "pi",
				renameWorkspace: true,
				fetchNames: fetchSpy,
				runtime: rt,
			},
		);
		expect(ok).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(rt.namedThisSession).toBe(false);
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
		// #0004: the flag only sticks after a SUCCESSFUL fetchNames; LLM
		// failure now resets the flag so the next message retries. Stub
		// fetchNames to a canned success so the first prompt dispatches a
		// real rename and the second is a pure pill update.
		__setFetchNamesForTests(async () => ({ workspace: "W" }));
		const ctx = makeFakeCtx({ authOk: true });

		await pi.handlers.get("input")!(
			{ source: "interactive", text: "first" },
			ctx,
		);
		await new Promise<void>((r) => setImmediate(r));
		const afterFirst = spawner.mock.calls.length;
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "second" },
			ctx,
		);
		await new Promise<void>((r) => setImmediate(r));
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
		__setFetchNamesForTests(null);
	});

	it("only fires on the first eligible prompt per session", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const fetchSpy = vi.fn(async () => ({ workspace: "W" }));
		__setFetchNamesForTests(fetchSpy);
		const ctx = makeFakeCtx({ authOk: true });

		await pi.handlers.get("input")!({ source: "interactive", text: "first" }, ctx);
		await new Promise<void>((r) => setImmediate(r));
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		await pi.handlers.get("input")!({ source: "interactive", text: "second" }, ctx);
		await new Promise<void>((r) => setImmediate(r));
		// Second prompt must not fire a second fetch — the flag is still
		// true after the first successful dispatch.
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		__setFetchNamesForTests(null);
	});
});


// ---------------------------------------------------------------------------
// session_start rehydrate — persistent once-per-session flag (issue #0001, #0004)
// ---------------------------------------------------------------------------

describe("session_start rehydrate (persistent once-per-session)", () => {
	let restore: () => void;
	let spawner: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		restore = enterCmux();
		spawner = vi.fn(async () => {});
		__setCmuxSpawnerForTests(spawner as unknown as (args: string[]) => Promise<void>);
	});
	afterEach(() => {
		restore();
		__setCmuxSpawnerForTests(null);
	});

	it("exports RENAMED_ENTRY_TYPE as the session-log custom-type key", () => {
		expect(RENAMED_ENTRY_TYPE).toBe("pi-update-cmux-status-state");
	});

	it("still rehydrates from the pre-#0004 `cmux-status-renamed` marker (back-compat)", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const fetchSpy = vi.fn(async () => ({ workspace: "W" }));
		__setFetchNamesForTests(fetchSpy);
		const ctx = makeFakeCtx({
			entries: [
				{ type: "custom", customType: "cmux-status-renamed", data: { savedAt: 1 } },
			],
		});
		await pi.handlers.get("session_start")!({}, ctx);
		await pi.handlers.get("input")!({ source: "interactive", text: "hi" }, ctx);
		await new Promise<void>((r) => setImmediate(r));
		expect(fetchSpy).not.toHaveBeenCalled();
		__setFetchNamesForTests(null);
	});

	it("skips auto-rename on a subsequent input when a marker exists in the session log", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const fetchSpy = vi.fn(async () => ({ workspace: "W" }));
		__setFetchNamesForTests(fetchSpy);
		const ctx = makeFakeCtx({
			entries: [
				{ type: "custom", customType: RENAMED_ENTRY_TYPE, data: { savedAt: 1 } },
			],
		});
		// Fire session_start so the rehydrate block runs against the
		// seeded session log entries.
		await pi.handlers.get("session_start")!({}, ctx);
		await pi.handlers.get("input")!({ source: "interactive", text: "hello" }, ctx);
		await new Promise<void>((r) => setImmediate(r));
		expect(fetchSpy).not.toHaveBeenCalled();
		__setFetchNamesForTests(null);
	});

	it("still auto-renames when the session log has no marker", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const fetchSpy = vi.fn(async () => ({ workspace: "W" }));
		__setFetchNamesForTests(fetchSpy);
		const ctx = makeFakeCtx({ entries: [] });
		await pi.handlers.get("session_start")!({}, ctx);
		await pi.handlers.get("input")!({ source: "interactive", text: "hello" }, ctx);
		await new Promise<void>((r) => setImmediate(r));
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		__setFetchNamesForTests(null);
	});

	it("treats a thrown sessionManager.getEntries() as 'no marker'", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const fetchSpy = vi.fn(async () => ({ workspace: "W" }));
		__setFetchNamesForTests(fetchSpy);
		const ctx = makeFakeCtx();
		ctx.sessionManager.getEntries = vi.fn(() => {
			throw new Error("sessionManager broken");
		}) as unknown as typeof ctx.sessionManager.getEntries;
		await pi.handlers.get("session_start")!({}, ctx);
		await pi.handlers.get("input")!({ source: "interactive", text: "hello" }, ctx);
		await new Promise<void>((r) => setImmediate(r));
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		__setFetchNamesForTests(null);
	});
});

// ---------------------------------------------------------------------------
// pi.appendEntry on rename — persists on any gate decision (#0001, #0004)
// ---------------------------------------------------------------------------

describe("pi.appendEntry on rename", () => {
	let restore: () => void;
	let spawner: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		restore = enterCmux();
		spawner = vi.fn(async () => {});
		__setCmuxSpawnerForTests(spawner as unknown as (args: string[]) => Promise<void>);
	});
	afterEach(() => {
		restore();
		__setCmuxSpawnerForTests(null);
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

	it("writes the marker after a successful rename dispatch", async () => {
		stubWorkspaceTitle("Terminal 12");
		__setFetchNamesForTests(async () => ({ workspace: "Fresh WS" }));
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await pi.handlers.get("input")!({ source: "interactive", text: "hi" }, ctx);
		await new Promise<void>((r) => setImmediate(r));
		expect(pi.appendEntry).toHaveBeenCalledWith(
			RENAMED_ENTRY_TYPE,
			expect.objectContaining({ savedAt: expect.any(Number) }),
		);
		// Extra guardrail: the write-side must ONLY use the new key, never
		// the legacy `cmux-status-renamed` — back-compat is read-only.
		const types = pi.appendEntry.mock.calls.map((c) => c[0]);
		expect(types).not.toContain("cmux-status-renamed");
		__setFetchNamesForTests(null);
	});

	it("writes the marker after the gate decides the title is user-set (#0004)", async () => {
		stubWorkspaceTitle("My Workspace");
		const fetchSpy = vi.fn(async () => ({ workspace: "X" }));
		__setFetchNamesForTests(fetchSpy);
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await pi.handlers.get("input")!({ source: "interactive", text: "hi" }, ctx);
		await new Promise<void>((r) => setImmediate(r));
		// LLM not called \u2014 gate skipped before LLM.
		expect(fetchSpy).not.toHaveBeenCalled();
		// But the marker IS persisted \u2014 /reload should skip the gate too.
		expect(pi.appendEntry).toHaveBeenCalledWith(
			RENAMED_ENTRY_TYPE,
			expect.objectContaining({ savedAt: expect.any(Number) }),
		);
		__setFetchNamesForTests(null);
	});

	it("does NOT write the marker when the gate read fails closed (#0004)", async () => {
		__setCmuxReaderForTests(async () => { throw new Error("rpc failed"); });
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await pi.handlers.get("input")!({ source: "interactive", text: "hi" }, ctx);
		await new Promise<void>((r) => setImmediate(r));
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does NOT write the marker when the LLM call fails", async () => {
		stubWorkspaceTitle("Terminal 12");
		__setFetchNamesForTests(async () => undefined);
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await pi.handlers.get("input")!({ source: "interactive", text: "hi" }, ctx);
		await new Promise<void>((r) => setImmediate(r));
		expect(pi.appendEntry).not.toHaveBeenCalled();
		__setFetchNamesForTests(null);
	});

	it("writes the marker after /cmux-rename succeeds", async () => {
		stubWorkspaceTitle("User Named");
		__setFetchNamesForTests(async () => ({ workspace: "Fresh WS" }));
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx({
			branch: [
				{ type: "message", message: { role: "user", content: "do the thing" } },
			],
		});
		await pi.commands.get("cmux-rename")!.handler("", ctx as never);
		expect(pi.appendEntry).toHaveBeenCalledWith(
			RENAMED_ENTRY_TYPE,
			expect.objectContaining({ savedAt: expect.any(Number) }),
		);
		__setFetchNamesForTests(null);
	});

	it("does NOT write the marker when /cmux-rename fails (LLM error)", async () => {
		stubWorkspaceTitle("User Named");
		__setFetchNamesForTests(async () => undefined);
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx({
			branch: [
				{ type: "message", message: { role: "user", content: "do the thing" } },
			],
		});
		await pi.commands.get("cmux-rename")!.handler("", ctx as never);
		expect(pi.appendEntry).not.toHaveBeenCalled();
		__setFetchNamesForTests(null);
	});
});
