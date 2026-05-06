import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __setCmuxSpawnerForTests } from "../src/cmux.js";
import { __setCmuxReaderForTests } from "../src/cmuxReader.js";
import createExtension, {
	__setFetchNamesForTests,
	LEGACY_RENAMED_ENTRY_TYPES,
	RENAMED_ENTRY_TYPE,
	runRename,
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
		entries?: FakeEntry[];
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
	delete process.env["CMUX_SURFACE_ID"];
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
// Event wiring
// ---------------------------------------------------------------------------

describe("default export — wiring", () => {
	it("subscribes to session_start + input only (status mirroring lives in pi-cmux-notifications)", () => {
		const pi = makeFakePi();
		createExtension(pi as never);

		const subscribed = pi.on.mock.calls.map((c) => c[0]);
		expect(subscribed).toContain("session_start");
		expect(subscribed).toContain("input");
		// Status-pill wiring is the sibling extension's job — this package
		// must not subscribe to any of the pill-related events.
		for (const evt of [
			"session_shutdown",
			"agent_end",
			"tool_execution_start",
			"tool_execution_end",
			"before_agent_start",
		]) {
			expect(subscribed).not.toContain(evt);
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
		const ok = await runRename(makeFakeCtx() as never, "prompt", {
			statusKey: "pi",
			renameWorkspace: true,
			fetchNames: async () => ({ workspace: "W" }),
		});
		expect(ok).toBe(false);
		expect(spawner).not.toHaveBeenCalled();
	});

	it("returns false when fetchNames returns undefined", async () => {
		const ok = await runRename(makeFakeCtx() as never, "prompt", {
			statusKey: "pi",
			renameWorkspace: true,
			fetchNames: async () => undefined,
		});
		expect(ok).toBe(false);
		expect(spawner).not.toHaveBeenCalled();
	});

	it("dispatches rename-workspace when fetchNames succeeds", async () => {
		const ok = await runRename(makeFakeCtx() as never, "prompt", {
			statusKey: "pi",
			renameWorkspace: true,
			fetchNames: async () => ({ workspace: "Pi Extensions" }),
		});
		expect(ok).toBe(true);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs).toContainEqual([
			"workspace-action",
			"--action",
			"rename",
			"--title",
			"Pi Extensions",
		]);
		expect(argvs.some((a) => a[0] === "rename-tab")).toBe(false);
		expect(argvs.some((a) => a[0] === "log")).toBe(true);
	});

	it("is a no-op when renameWorkspace=false", async () => {
		const ok = await runRename(makeFakeCtx() as never, "prompt", {
			statusKey: "pi",
			renameWorkspace: false,
			fetchNames: async () => ({ workspace: "W" }),
		});
		expect(ok).toBe(true);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "workspace-action")).toBe(false);
		expect(argvs.some((a) => a[0] === "rename-tab")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// runRename — prefix gate
// ---------------------------------------------------------------------------

describe("runRename — prefix gate", () => {
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
		const ok = await runRename(makeFakeCtx() as never, "prompt", {
			statusKey: "pi",
			renameWorkspace: true,
			fetchNames: async () => ({ workspace: "Fresh WS" }),
		});
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
		const ok = await runRename(makeFakeCtx() as never, "prompt", {
			statusKey: "pi",
			renameWorkspace: true,
			fetchNames: async () => ({ workspace: "Fresh WS" }),
		});
		expect(ok).toBe(true);
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "workspace-action")).toBe(false);
	});

	it("fails closed when the read path throws — skips this turn, does NOT call LLM", async () => {
		const fetchSpy = vi.fn(async () => ({ workspace: "Fresh WS" }));
		__setCmuxReaderForTests(async () => {
			throw new Error("rpc failed");
		});
		const ok = await runRename(makeFakeCtx() as never, "prompt", {
			statusKey: "pi",
			renameWorkspace: true,
			fetchNames: fetchSpy,
		});
		expect(ok).toBe(false);
		expect(fetchSpy).not.toHaveBeenCalled();
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "workspace-action")).toBe(false);
	});

	it("skipPrefixGate bypasses the check (used by /cmux-rename)", async () => {
		stubWorkspaceTitle("User-Set Workspace");
		const ok = await runRename(makeFakeCtx() as never, "prompt", {
			statusKey: "pi",
			renameWorkspace: true,
			skipPrefixGate: true,
			fetchNames: async () => ({ workspace: "Fresh WS" }),
		});
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

	it("never dispatches a rename-tab call, regardless of the gate outcome", async () => {
		for (const [title, bypass] of [
			["Terminal 3", false],
			["User Set", false],
			["Terminal 3", true],
			["User Set", true],
		] as Array<[string, boolean]>) {
			stubWorkspaceTitle(title);
			spawner.mockClear();
			await runRename(makeFakeCtx() as never, "prompt", {
				statusKey: "pi",
				renameWorkspace: true,
				skipPrefixGate: bypass,
				fetchNames: async () => ({ workspace: "Fresh WS" }),
			});
			const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
			expect(argvs.some((a) => a[0] === "rename-tab")).toBe(false);
		}
	});

	it("gate runs BEFORE the LLM call when the title is user-set", async () => {
		stubWorkspaceTitle("My Project");
		const fetchSpy = vi.fn(async () => ({ workspace: "Should Not Be Seen" }));
		const rt = { namedThisSession: false };
		const ok = await runRename(makeFakeCtx() as never, "prompt", {
			statusKey: "pi",
			renameWorkspace: true,
			fetchNames: fetchSpy,
			runtime: rt,
		});
		expect(ok).toBe(true);
		expect(fetchSpy).not.toHaveBeenCalled();
		const argvs = spawner.mock.calls.map((c) => c[0] as string[]);
		expect(argvs.some((a) => a[0] === "workspace-action")).toBe(false);
		expect(rt.namedThisSession).toBe(false);
	});

	it("flag is set to true after a successful dispatch", async () => {
		stubWorkspaceTitle("Terminal 12");
		const fetchSpy = vi.fn(async () => ({ workspace: "Fresh WS" }));
		const rt = { namedThisSession: false };
		const ok = await runRename(makeFakeCtx() as never, "prompt", {
			statusKey: "pi",
			renameWorkspace: true,
			fetchNames: fetchSpy,
			runtime: rt,
		});
		expect(ok).toBe(true);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(rt.namedThisSession).toBe(true);
	});

	it("flag is reset to false when the LLM call fails", async () => {
		stubWorkspaceTitle("Terminal 12");
		const fetchSpy = vi.fn(async () => undefined);
		const rt = { namedThisSession: false };
		const ok = await runRename(makeFakeCtx() as never, "prompt", {
			statusKey: "pi",
			renameWorkspace: true,
			fetchNames: fetchSpy,
			runtime: rt,
		});
		expect(ok).toBe(false);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(rt.namedThisSession).toBe(false);
	});

	it("flag is reset to false when the gate read fails closed", async () => {
		__setCmuxReaderForTests(async () => {
			throw new Error("rpc failed");
		});
		const fetchSpy = vi.fn(async () => ({ workspace: "Fresh WS" }));
		const rt = { namedThisSession: false };
		const ok = await runRename(makeFakeCtx() as never, "prompt", {
			statusKey: "pi",
			renameWorkspace: true,
			fetchNames: fetchSpy,
			runtime: rt,
		});
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
		const notifies = ctx.ui.notify.mock.calls.map((c) => [
			String(c[0]),
			String(c[1]),
		]);
		expect(
			notifies.some(
				([m, lvl]) =>
					m !== undefined && /not running inside cmux/i.test(m) && lvl === "warning",
			),
		).toBe(true);
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

		ctx.modelRegistry.getApiKeyAndHeaders = vi.fn(async () => ({ ok: false }));
		await pi.commands.get("cmux-rename")!.handler("this arg is ignored", ctx as never);
		const notifies = ctx.ui.notify.mock.calls.map((c) => String(c[0]));
		expect(notifies.some((m) => /Renaming/i.test(m))).toBe(true);
		expect(notifies.some((m) => /Rename failed/i.test(m))).toBe(true);
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
		expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("ignores empty text", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "   " },
			ctx,
		);
		expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("ignores non-interactive sources", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await pi.handlers.get("input")!(
			{ source: "api", text: "hello" },
			ctx,
		);
		expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
	});

	it("only fires on the first eligible prompt per session", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const fetchSpy = vi.fn(async () => ({ workspace: "W" }));
		__setFetchNamesForTests(fetchSpy);
		const ctx = makeFakeCtx({ authOk: true });

		await pi.handlers.get("input")!(
			{ source: "interactive", text: "first" },
			ctx,
		);
		await new Promise<void>((r) => setImmediate(r));
		expect(fetchSpy).toHaveBeenCalledTimes(1);

		await pi.handlers.get("input")!(
			{ source: "interactive", text: "second" },
			ctx,
		);
		await new Promise<void>((r) => setImmediate(r));
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		__setFetchNamesForTests(null);
	});
});

// ---------------------------------------------------------------------------
// session_start rehydrate — persistent once-per-session flag
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
	});

	it("exports RENAMED_ENTRY_TYPE as the session-log custom-type key", () => {
		expect(RENAMED_ENTRY_TYPE).toBe("pi-cmux-update-workspace-name-state");
	});

	it("still rehydrates from the pre-split `cmux-status-renamed` marker (back-compat)", async () => {
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
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "hi" },
			ctx,
		);
		await new Promise<void>((r) => setImmediate(r));
		expect(fetchSpy).not.toHaveBeenCalled();
		__setFetchNamesForTests(null);
	});

	it("still rehydrates from the pre-split `pi-update-cmux-status-state` marker (back-compat)", async () => {
		// The previous package name wrote this customType verbatim. A
		// session log that was populated before the split (or between
		// installs during the rename) still has to short-circuit.
		expect(LEGACY_RENAMED_ENTRY_TYPES).toContain("pi-update-cmux-status-state");
		const pi = makeFakePi();
		createExtension(pi as never);
		const fetchSpy = vi.fn(async () => ({ workspace: "W" }));
		__setFetchNamesForTests(fetchSpy);
		const ctx = makeFakeCtx({
			entries: [
				{
					type: "custom",
					customType: "pi-update-cmux-status-state",
					data: { savedAt: 1 },
				},
			],
		});
		await pi.handlers.get("session_start")!({}, ctx);
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "hi" },
			ctx,
		);
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
		await pi.handlers.get("session_start")!({}, ctx);
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "hello" },
			ctx,
		);
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
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "hello" },
			ctx,
		);
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
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "hello" },
			ctx,
		);
		await new Promise<void>((r) => setImmediate(r));
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		__setFetchNamesForTests(null);
	});
});

// ---------------------------------------------------------------------------
// pi.appendEntry on rename — persists on any gate decision
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
	});

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
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "hi" },
			ctx,
		);
		await new Promise<void>((r) => setImmediate(r));
		expect(pi.appendEntry).toHaveBeenCalledWith(
			RENAMED_ENTRY_TYPE,
			expect.objectContaining({ savedAt: expect.any(Number) }),
		);
		// Write-side must ONLY use the new key, never any legacy type.
		const types = pi.appendEntry.mock.calls.map((c) => c[0]);
		for (const legacy of LEGACY_RENAMED_ENTRY_TYPES) {
			expect(types).not.toContain(legacy);
		}
		__setFetchNamesForTests(null);
	});

	it("writes the marker after the gate decides the title is user-set", async () => {
		stubWorkspaceTitle("My Workspace");
		const fetchSpy = vi.fn(async () => ({ workspace: "X" }));
		__setFetchNamesForTests(fetchSpy);
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "hi" },
			ctx,
		);
		await new Promise<void>((r) => setImmediate(r));
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(pi.appendEntry).toHaveBeenCalledWith(
			RENAMED_ENTRY_TYPE,
			expect.objectContaining({ savedAt: expect.any(Number) }),
		);
		__setFetchNamesForTests(null);
	});

	it("does NOT write the marker when the gate read fails closed", async () => {
		__setCmuxReaderForTests(async () => {
			throw new Error("rpc failed");
		});
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "hi" },
			ctx,
		);
		await new Promise<void>((r) => setImmediate(r));
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does NOT write the marker when the LLM call fails", async () => {
		stubWorkspaceTitle("Terminal 12");
		__setFetchNamesForTests(async () => undefined);
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx();
		await pi.handlers.get("input")!(
			{ source: "interactive", text: "hi" },
			ctx,
		);
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
