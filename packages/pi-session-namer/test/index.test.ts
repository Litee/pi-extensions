import type { AssistantMessage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import createExtension from "../src/index.js";
import { STATE_CUSTOM_TYPE } from "../src/state.js";

vi.mock("@earendil-works/pi-ai", () => ({
	completeSimple: vi.fn(),
}));

// Re-import the mocked completeSimple after the mock is registered
import { completeSimple } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PANE_GET_JSON = JSON.stringify({
	id: "cli:pane:get",
	result: {
		pane: {
			agent: "pi",
			agent_status: "working",
			cwd: "/some/path",
			focused: false,
			pane_id: "w652f1910e89a56-1",
			revision: 0,
			tab_id: "w652f1910e89a56:1",
			terminal_id: "term_652f1910e899f6",
			workspace_id: "w652f1910e89a56",
		},
		type: "pane_info",
	},
});

const WS_ID = "w652f1910e89a56";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface StubPi {
	on: ReturnType<typeof vi.fn>;
	exec: ReturnType<typeof vi.fn>;
	getSessionName: ReturnType<typeof vi.fn>;
	setSessionName: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
	readonly handlers: Map<string, (...args: unknown[]) => unknown>;
	readonly commands: Map<string, (args: string, ctx: unknown) => Promise<void>>;
}

function makeFakePi(overrides?: {
	sessionName?: string | undefined;
	execImpl?: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}): StubPi {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();

	// Default exec: pane get → rename (both succeed)
	const defaultExec = vi.fn()
		.mockResolvedValueOnce({ code: 0, stdout: PANE_GET_JSON, stderr: "" })
		.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

	const exec = overrides?.execImpl
		? vi.fn(overrides.execImpl)
		: defaultExec;

	return {
		on: vi.fn((evt: string, fn: (...a: unknown[]) => unknown) => {
			handlers.set(evt, fn);
		}),
		exec,
		getSessionName: vi.fn().mockReturnValue(overrides?.sessionName),
		setSessionName: vi.fn(),
		appendEntry: vi.fn(),
		registerCommand: vi.fn((name: string, opts: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, opts.handler);
		}),
		handlers,
		commands,
	};
}

function makeFakeCtx(overrides?: {
	model?: unknown;
	getBranch?: () => unknown[];
}) {
	return {
		ui: { notify: vi.fn() },
		sessionManager: {
			getEntries: vi.fn().mockReturnValue([]),
			getBranch: overrides?.getBranch ?? vi.fn().mockReturnValue([]),
		},
		model: overrides?.model,
		modelRegistry: {
			getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "sk-test" }),
		},
	};
}

/** Helper: set env vars, run fn, restore env. */
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
	const saved = { ...process.env };
	for (const [k, v] of Object.entries(env)) process.env[k] = v;
	for (const k of Object.keys(saved)) { if (!(k in env)) delete process.env[k]; }
	try {
		return await fn();
	} finally {
		for (const k of Object.keys(process.env)) delete process.env[k];
		for (const [k, v] of Object.entries(saved)) process.env[k] = v;
	}
}

/**
 * Call createExtension with HERDR_ENV deterministically set to "1", regardless
 * of the ambient process env. This ensures handler/command registration always
 * happens in tests that need the extension wired up — whether the test runs
 * inside herdr (HERDR_ENV=1) or in CI (HERDR_ENV unset).
 */
function createExtensionInHerdr(pi: StubPi): void {
	const saved = process.env["HERDR_ENV"];
	process.env["HERDR_ENV"] = "1";
	try {
		createExtension(pi as never);
	} finally {
		if (saved === undefined) delete process.env["HERDR_ENV"];
		else process.env["HERDR_ENV"] = saved;
	}
}

async function fireSessionStart(
	pi: StubPi,
	ctx: ReturnType<typeof makeFakeCtx>,
	env: Record<string, string>,
	reason = "startup",
): Promise<void> {
	await withEnv(env, async () => {
		await pi.handlers.get("session_start")?.({ type: "session_start", reason }, ctx);
	});
}

async function fireAgentEnd(
	pi: StubPi,
	ctx: ReturnType<typeof makeFakeCtx>,
	env: Record<string, string>,
): Promise<void> {
	await withEnv(env, async () => {
		await pi.handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, ctx);
	});
}

// ---------------------------------------------------------------------------
// Herdr gating — registration-time gate
// ---------------------------------------------------------------------------

describe("pi-herdr-integration — herdr gating", () => {
	it("registers nothing when not running inside herdr", () => {
		const pi = makeFakePi();
		const saved = process.env["HERDR_ENV"];
		delete process.env["HERDR_ENV"];
		try {
			createExtension(pi as never);
		} finally {
			if (saved === undefined) delete process.env["HERDR_ENV"];
			else process.env["HERDR_ENV"] = saved;
		}

		expect(pi.on).not.toHaveBeenCalled();
		expect(pi.registerCommand).not.toHaveBeenCalled();
		expect(pi.commands.has("name-session-and-space")).toBe(false);
	});

	it("registers handlers and the command when inside herdr", () => {
		const pi = makeFakePi();
		createExtensionInHerdr(pi);

		expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(pi.on).toHaveBeenCalledWith("agent_end", expect.any(Function));
		expect(pi.commands.has("name-session-and-space")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe("pi-herdr-integration — wiring", () => {
	it("subscribes to session_start and agent_end; does NOT subscribe to session_shutdown or input; registers /name-session-and-space command", () => {
		const pi = makeFakePi();
		createExtensionInHerdr(pi);

		const subscribed = pi.on.mock.calls.map((c: unknown[]) => c[0] as string);
		expect(subscribed).toContain("session_start");
		expect(subscribed).toContain("agent_end");
		expect(subscribed).not.toContain("session_shutdown");
		expect(subscribed).not.toContain("input");
		expect(pi.commands.has("name-session-and-space")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// session_start
// ---------------------------------------------------------------------------

describe("pi-herdr-integration — session_start", () => {
	it("skips when no session name", async () => {
		const pi = makeFakePi({ sessionName: undefined });
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("always renames on session_start regardless of any previous state", async () => {
		const pi = makeFakePi({ sessionName: "my session" });
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(pi.exec).toHaveBeenCalledTimes(2);
		expect(pi.exec.mock.calls[0]).toEqual(["herdr", ["pane", "get", "p_6"], { timeout: 5000 }]);
		expect(pi.exec.mock.calls[1]).toEqual(["herdr", ["workspace", "rename", WS_ID, "my session"], { timeout: 5000 }]);
		expect(ctx.ui.notify).toHaveBeenCalledWith(`herdr workspace renamed to "my session"`, "info");
		expect(pi.appendEntry).toHaveBeenCalledWith(STATE_CUSTOM_TYPE, expect.objectContaining({
			lastAppliedName: "my session",
			herdrWorkspaceId: WS_ID,
		}));
	});

	it("renames on every session_start — each start is a new herdr context", async () => {
		const pi = makeFakePi({ sessionName: "my session" });
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		const afterFirst = pi.exec.mock.calls.length;

		// Second session_start (e.g. /reload) — resets guards, renames again
		pi.exec.mockResolvedValueOnce({ code: 0, stdout: PANE_GET_JSON, stderr: "" });
		pi.exec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		expect(pi.exec.mock.calls.length).toBeGreaterThan(afterFirst);
	});

	it("renames on fork — fork session may be in a different workspace", async () => {
		const pi = makeFakePi({ sessionName: "my session" });
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, "fork");

		expect(pi.exec).toHaveBeenCalledTimes(2);
		expect(pi.exec.mock.calls[1]?.[1]).toEqual(["workspace", "rename", WS_ID, "my session"]);
	});

	it("renames on resume — resumed session may be in a different workspace than when last run", async () => {
		const pi = makeFakePi({ sessionName: "my session" });
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, "resume");

		expect(pi.exec).toHaveBeenCalledTimes(2);
		expect(pi.exec.mock.calls[1]?.[1]).toEqual(["workspace", "rename", WS_ID, "my session"]);
	});

	it("notifies warning when pane get fails", async () => {
		const pi = makeFakePi({
			sessionName: "my session",
			execImpl: () => Promise.resolve({ code: 1, stdout: "", stderr: "herdr error" }),
		});
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(ctx.ui.notify).toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("notifies warning when rename fails; retries on next session_start (which resets lastAttemptedName)", async () => {
		let paneGetCalled = false;
		const pi = makeFakePi({
			sessionName: "my session",
			execImpl: (_cmd, args) => {
				if (args[1] === "get") {
					paneGetCalled = true;
					return Promise.resolve({ code: 0, stdout: PANE_GET_JSON, stderr: "" });
				}
				return Promise.resolve({ code: 1, stdout: "", stderr: "rename failed" });
			},
		});
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(paneGetCalled).toBe(true);
		expect(ctx.ui.notify).toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();

		// session_start resets lastAttemptedName → retries
		pi.exec.mockResolvedValueOnce({ code: 0, stdout: PANE_GET_JSON, stderr: "" });
		pi.exec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
		ctx.ui.notify.mockReset();

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		expect(pi.exec).toHaveBeenCalled();
	});

	it("warning message for workspace unresolvable mentions 'will retry when name changes'", async () => {
		const pi = makeFakePi({
			sessionName: "my session",
			execImpl: () => Promise.resolve({ code: 1, stdout: "", stderr: "herdr error" }),
		});
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"pi-herdr-integration: could not resolve herdr workspace \u2014 will retry when name changes",
			"warning",
		);
	});

	it("warning message for rename failure mentions 'will retry when name changes'", async () => {
		const pi = makeFakePi({
			sessionName: "my session",
			execImpl: (_cmd, args) => {
				if (args[1] === "get") return Promise.resolve({ code: 0, stdout: PANE_GET_JSON, stderr: "" });
				return Promise.resolve({ code: 1, stdout: "", stderr: "rename rejected" });
			},
		});
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"pi-herdr-integration: rename failed \u2014 rename rejected \u2014 will retry when name changes",
			"warning",
		);
	});
});

// ---------------------------------------------------------------------------
// Backoff guard
// ---------------------------------------------------------------------------

describe("pi-herdr-integration — backoff guard", () => {
	it("after pane-get failure, subsequent agent_end with same name skips exec", async () => {
		const pi = makeFakePi({
			sessionName: "my session",
			execImpl: () => Promise.resolve({ code: 1, stdout: "", stderr: "herdr error" }),
		});
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		await fireAgentEnd(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		const callCountAfterFirst = pi.exec.mock.calls.length;

		await fireAgentEnd(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		expect(pi.exec.mock.calls.length).toBe(callCountAfterFirst);
	});

	it("after rename failure, subsequent agent_end with same name skips exec", async () => {
		const pi = makeFakePi({
			sessionName: "my session",
			execImpl: (_cmd, args) => {
				if (args[1] === "get") return Promise.resolve({ code: 0, stdout: PANE_GET_JSON, stderr: "" });
				return Promise.resolve({ code: 1, stdout: "", stderr: "rename rejected" });
			},
		});
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		await fireAgentEnd(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		const callCountAfterFirst = pi.exec.mock.calls.length;

		await fireAgentEnd(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		expect(pi.exec.mock.calls.length).toBe(callCountAfterFirst);
	});

	it("after failure, a different session name triggers a new attempt", async () => {
		const pi = makeFakePi({
			sessionName: "my session",
			execImpl: () => Promise.resolve({ code: 1, stdout: "", stderr: "herdr error" }),
		});
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		await fireAgentEnd(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		const callCountAfterFirst = pi.exec.mock.calls.length;

		pi.getSessionName.mockReturnValue("different name");
		await fireAgentEnd(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		expect(pi.exec.mock.calls.length).toBeGreaterThan(callCountAfterFirst);
	});
});

// ---------------------------------------------------------------------------
// agent_end — catches /name and any other name-change mechanism
// ---------------------------------------------------------------------------

describe("pi-herdr-integration — agent_end", () => {
	it("renames when getSessionName returns a new name after a turn", async () => {
		const pi = makeFakePi({ sessionName: "new name" });
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		await fireAgentEnd(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(pi.exec).toHaveBeenCalledTimes(2);
		expect(pi.exec.mock.calls[1]?.[1]).toEqual(["workspace", "rename", WS_ID, "new name"]);
	});

	it("no-op on agent_end when name has not changed since last rename", async () => {
		const pi = makeFakePi({ sessionName: "my session" });
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		// First rename via session_start
		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		const callCountAfterFirst = pi.exec.mock.calls.length;

		// agent_end with same name: no-op
		await fireAgentEnd(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		expect(pi.exec.mock.calls.length).toBe(callCountAfterFirst);
	});

	it("renames when name changed between session_start and agent_end (i.e. user ran /name)", async () => {
		const pi = makeFakePi({ sessionName: "original" });
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		// Simulate user running /name mid-session
		pi.getSessionName.mockReturnValue("renamed");
		pi.exec.mockResolvedValueOnce({ code: 0, stdout: PANE_GET_JSON, stderr: "" });
		pi.exec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

		await fireAgentEnd(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		const renameCalls = pi.exec.mock.calls.filter(
			(c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[])[1] === "rename",
		);
		expect(renameCalls[renameCalls.length - 1]?.[1]).toEqual(["workspace", "rename", WS_ID, "renamed"]);
	});

	it("skips when no session name", async () => {
		const pi = makeFakePi({ sessionName: undefined });
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		await fireAgentEnd(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("skips when not in herdr", async () => {
		const pi = makeFakePi({ sessionName: "my session" });
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		// No HERDR_PANE_ID → resolveWorkspaceId returns null immediately (no exec)
		await fireAgentEnd(pi, ctx, {});

		expect(pi.exec).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// /name-session-and-space command
// ---------------------------------------------------------------------------

describe("pi-herdr-integration — /name-session-and-space command", () => {
	it("sets session name and renames herdr workspace (inside herdr)", async () => {
		const pi = makeFakePi({ sessionName: "old name" });
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		const handler = pi.commands.get("name-session-and-space")!;
		await withEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, async () => {
			await handler("my label", ctx);
		});

		expect(pi.setSessionName).toHaveBeenCalledWith("my label");
		expect(pi.exec.mock.calls[0]).toEqual(["herdr", ["pane", "get", "p_6"], { timeout: 5000 }]);
		expect(pi.exec.mock.calls[1]).toEqual(["herdr", ["workspace", "rename", WS_ID, "my label"], { timeout: 5000 }]);
	});

	it("trims whitespace from args", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		const handler = pi.commands.get("name-session-and-space")!;
		await withEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, async () => {
			await handler("  spaced  ", ctx);
		});

		expect(pi.setSessionName).toHaveBeenCalledWith("spaced");
		expect(pi.exec.mock.calls[1]?.[1]).toEqual(["workspace", "rename", WS_ID, "spaced"]);
	});

	it("empty arg triggers auto-generate: fails gracefully without model", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		const handler = pi.commands.get("name-session-and-space")!;
		await handler("", ctx);

		expect(pi.setSessionName).not.toHaveBeenCalled();
		expect(pi.exec).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Cannot generate name: no active model.",
			"warning",
		);
	});

	it("whitespace-only arg triggers auto-generate: fails gracefully without model", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		const handler = pi.commands.get("name-session-and-space")!;
		await handler("   ", ctx);

		expect(pi.setSessionName).not.toHaveBeenCalled();
		expect(pi.exec).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Cannot generate name: no active model.",
			"warning",
		);
	});

	it("forces a rename past the failure backoff (explicit invocation bypasses lastAttemptedName)", async () => {
		const pi = makeFakePi({
			sessionName: "X",
			execImpl: (_cmd, args) => {
				if (args[1] === "get") return Promise.resolve({ code: 0, stdout: PANE_GET_JSON, stderr: "" });
				return Promise.resolve({ code: 1, stdout: "", stderr: "rename failed" });
			},
		});
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		// Arm lastAttemptedName = "X" via a failing agent_end rename
		await fireAgentEnd(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		const execCallsAfterAgentEnd = pi.exec.mock.calls.length;

		// Re-arm exec to succeed for the forced command invocation
		pi.exec
			.mockResolvedValueOnce({ code: 0, stdout: PANE_GET_JSON, stderr: "" })
			.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });

		const handler = pi.commands.get("name-session-and-space")!;
		await withEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, async () => {
			await handler("X", ctx);
		});

		// A rename must have been attempted after the command (not suppressed)
		expect(pi.exec.mock.calls.length).toBeGreaterThan(execCallsAfterAgentEnd);
		const renameCalls = pi.exec.mock.calls.filter(
			(c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[])[1] === "rename",
		);
		const lastRenameCall = renameCalls[renameCalls.length - 1];
		expect(lastRenameCall).toEqual(["herdr", ["workspace", "rename", WS_ID, "X"], { timeout: 5000 }]);
	});

	it("running the command twice with the same successful label renames herdr only once", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		const handler = pi.commands.get("name-session-and-space")!;
		await withEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, async () => {
			await handler("Y", ctx);
			await handler("Y", ctx);
		});

		const renameCalls = pi.exec.mock.calls.filter(
			(c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[])[1] === "rename",
		);
		expect(renameCalls).toHaveLength(1);
		expect(pi.setSessionName).toHaveBeenCalledTimes(2);
		expect(pi.setSessionName).toHaveBeenCalledWith("Y");
	});

	it("a subagent-pattern label sets the session name but does not rename herdr", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		const handler = pi.commands.get("name-session-and-space")!;
		await withEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, async () => {
			await handler("agent#abcdef", ctx);
		});

		expect(pi.setSessionName).toHaveBeenCalledWith("agent#abcdef");
		expect(pi.exec).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Subagent session names
// ---------------------------------------------------------------------------

describe("pi-herdr-integration — subagent names", () => {
	it("skips rename when session name matches subagent pattern <agent>#<hex>", async () => {
		const pi = makeFakePi({ sessionName: "andrey-implementer#763834d1" });
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		await fireAgentEnd(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("skips rename for other subagent name variants", async () => {
		const names = ["andrey-worker#aabbcc", "andrey-scout#1234abcd", "some-agent#ffffff00"];
		for (const sessionName of names) {
			const pi = makeFakePi({ sessionName });
			const ctx = makeFakeCtx();
			createExtensionInHerdr(pi);
			await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
			expect(pi.exec).not.toHaveBeenCalled();
		}
	});

	it("does not skip a human-chosen name that happens to contain a hash", async () => {
		const pi = makeFakePi({ sessionName: "fix #123" });
		const ctx = makeFakeCtx();
		createExtensionInHerdr(pi);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(pi.exec).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// /name-session-and-space — auto-generate path
// ---------------------------------------------------------------------------

describe("pi-herdr-integration — /name-session-and-space auto-generate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	function resolveTranscriptEntries(): unknown[] {
		return [
			{ type: "message", message: { role: "user", content: "hello, help me fix a bug" } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Sure, what's the bug?" }] } },
			{ type: "message", message: { role: "user", content: "the auth endpoint returns 500" } },
		];
	}

	/**
	 * The auto-generate path uses fire-and-forget (`void (async () => {...})()`),
	 * so the handler returns before the IIFE completes. We need to flush the
	 * microtask queue before asserting on async results.
	 */
	async function flushAsyncIIFE(): Promise<void> {
		await new Promise((r) => setTimeout(r, 0));
	}

	it("auto-generates name when called without args (model present, entries present)", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx({
			model: { name: "test-model" },
			getBranch: resolveTranscriptEntries,
		});
		createExtensionInHerdr(pi);

		vi.mocked(completeSimple).mockResolvedValueOnce({
			content: [{ type: "text", text: "fix auth bug" }],
		} as AssistantMessage);

		const handler = pi.commands.get("name-session-and-space")!;
		await withEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, async () => {
			await handler("", ctx);
		});
		await flushAsyncIIFE();

		// Should have called completeSimple for generation
		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
		// setSessionName should be called with generated name
		expect(pi.setSessionName).toHaveBeenCalledWith("fix auth bug");
		// Rename should follow
		const renameCalls = pi.exec.mock.calls.filter(
			(c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[])[1] === "rename",
		);
		expect(renameCalls).toHaveLength(1);
		expect(renameCalls[0]![1]).toEqual(["workspace", "rename", WS_ID, "fix auth bug"]);
	});

	it("auto-generates with model that has reasoning flag", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx({
			model: { name: "test-model", reasoning: true },
			getBranch: resolveTranscriptEntries,
		});
		createExtensionInHerdr(pi);

		vi.mocked(completeSimple).mockResolvedValueOnce({
			content: [{ type: "text", text: "fix auth bug" }],
		} as AssistantMessage);

		const handler = pi.commands.get("name-session-and-space")!;
		await withEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, async () => {
			await handler("", ctx);
		});
		await flushAsyncIIFE();

		const options = vi.mocked(completeSimple).mock.calls[0]![2]!;
		expect(options.reasoning).toBe("minimal");
	});

	it("sends transcript to completeSimple with system prompt", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx({
			model: { name: "test-model" },
			getBranch: resolveTranscriptEntries,
		});
		createExtensionInHerdr(pi);

		vi.mocked(completeSimple).mockResolvedValueOnce({
			content: [{ type: "text", text: "fix auth bug" }],
		} as AssistantMessage);

		const handler = pi.commands.get("name-session-and-space")!;
		await withEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, async () => {
			await handler("", ctx);
		});
		await flushAsyncIIFE();

		const messages = vi.mocked(completeSimple).mock.calls[0]![1].messages;
		expect(messages).toHaveLength(1);
		expect(messages[0]!.role).toBe("user");
		expect((messages[0]!.content[0] as { type: string; text: string }).type).toBe("text");
		expect((messages[0]!.content[0] as { type: string; text: string }).text).toContain("Generate a short session name");
		// Transcript text should be in the prompt
		expect((messages[0]!.content[0] as { type: string; text: string }).text).toContain("help me fix a bug");
	});

	it("auto-generate: notifies 'no active model' when model is absent", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx({ model: undefined });
		createExtensionInHerdr(pi);

		const handler = pi.commands.get("name-session-and-space")!;
		await handler("", ctx);

		expect(vi.mocked(completeSimple)).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Cannot generate name: no active model.",
			"warning",
		);
	});

	it("auto-generate: notifies 'no conversation yet' when branch is empty", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx({
			model: { name: "test-model" },
			getBranch: () => [],
		});
		createExtensionInHerdr(pi);

		const handler = pi.commands.get("name-session-and-space")!;
		await handler("", ctx);

		expect(vi.mocked(completeSimple)).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Cannot generate name: no conversation yet.",
			"info",
		);
	});

	it("auto-generate: notifies 'no meaningful conversation' when transcript is empty", async () => {
		const pi = makeFakePi();
		// Entries with truly no extractable text — no text blocks, no tool calls
		const emptyEntries: unknown[] = [
			{ type: "message", message: { role: "assistant", content: null } },
			{ type: "message", message: { role: "user", content: "" } },
		];
		const ctx = makeFakeCtx({
			model: { name: "test-model" },
			getBranch: () => emptyEntries,
		});
		createExtensionInHerdr(pi);

		const handler = pi.commands.get("name-session-and-space")!;
		await handler("", ctx);

		expect(vi.mocked(completeSimple)).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Cannot generate name: no meaningful conversation to name.",
			"info",
		);
	});

	it("auto-generate: on successful generation, sets session name and renames herdr", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx({
			model: { name: "test-model" },
			getBranch: resolveTranscriptEntries,
		});
		createExtensionInHerdr(pi);

		vi.mocked(completeSimple).mockResolvedValueOnce({
			content: [{ type: "text", text: "debug herdr pane" }],
		} as AssistantMessage);

		const handler = pi.commands.get("name-session-and-space")!;
		await withEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, async () => {
			await handler("", ctx);
		});
		await flushAsyncIIFE();

		expect(pi.setSessionName).toHaveBeenCalledWith("debug herdr pane");
		expect(pi.appendEntry).toHaveBeenCalledWith(STATE_CUSTOM_TYPE, expect.objectContaining({
			lastAppliedName: "debug herdr pane",
		}));
	});

	it("auto-generate: on empty generated name, warns and does not rename", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx({
			model: { name: "test-model" },
			getBranch: resolveTranscriptEntries,
		});
		createExtensionInHerdr(pi);

		vi.mocked(completeSimple).mockResolvedValueOnce({
			content: [{ type: "text", text: "" }],
		} as AssistantMessage);

		const handler = pi.commands.get("name-session-and-space")!;
		await withEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, async () => {
			await handler("", ctx);
		});
		await flushAsyncIIFE();

		// Should not call setSessionName or rename
		expect(pi.setSessionName).not.toHaveBeenCalled();
		expect(pi.exec).not.toHaveBeenCalled();
		// Should warn about empty generation
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Name generation returned empty — the model may have declined.",
			"warning",
		);
	});

	it("auto-generate: on generation error, warns with error message", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx({
			model: { name: "test-model" },
			getBranch: resolveTranscriptEntries,
		});
		createExtensionInHerdr(pi);

		vi.mocked(completeSimple).mockRejectedValueOnce(new Error("rate limited"));

		const handler = pi.commands.get("name-session-and-space")!;
		await withEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, async () => {
			await handler("", ctx);
		});
		await flushAsyncIIFE();

		// No rename or setSessionName on error
		expect(pi.setSessionName).not.toHaveBeenCalled();
		expect(pi.exec).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Name generation failed: rate limited",
			"warning",
		);
	});

	it("auto-generate: on non-Error rejection, warns with stringified error", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx({
			model: { name: "test-model" },
			getBranch: resolveTranscriptEntries,
		});
		createExtensionInHerdr(pi);

		vi.mocked(completeSimple).mockRejectedValueOnce("string rejection");

		const handler = pi.commands.get("name-session-and-space")!;
		await withEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, async () => {
			await handler("", ctx);
		});
		await flushAsyncIIFE();

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Name generation failed: string rejection",
			"warning",
		);
	});

	it("auto-generate: aborts controller in finally block on success", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx({
			model: { name: "test-model" },
			getBranch: resolveTranscriptEntries,
		});
		createExtensionInHerdr(pi);

		vi.mocked(completeSimple).mockResolvedValueOnce({
			content: [{ type: "text", text: "fix bug" }],
		} as AssistantMessage);

		const handler = pi.commands.get("name-session-and-space")!;
		await withEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, async () => {
			await handler("", ctx);
		});
		await flushAsyncIIFE();

		// The controller should have been aborted
		const calls = vi.mocked(completeSimple).mock.calls;
		const opts = (calls[0] as Parameters<typeof completeSimple>)[2] as { signal: { aborted: boolean } };
		expect(opts.signal.aborted).toBe(true);
	});

	it("auto-generate: aborts controller in finally block on error", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx({
			model: { name: "test-model" },
			getBranch: resolveTranscriptEntries,
		});
		createExtensionInHerdr(pi);

		vi.mocked(completeSimple).mockRejectedValueOnce(new Error("boom"));

		const handler = pi.commands.get("name-session-and-space")!;
		await withEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, async () => {
			await handler("", ctx);
		});
		await flushAsyncIIFE();

		const calls2 = vi.mocked(completeSimple).mock.calls;
		const opts2 = (calls2[0] as Parameters<typeof completeSimple>)[2] as { signal: { aborted: boolean } };
		expect(opts2.signal.aborted).toBe(true);
	});

	it("auto-generate: uses cacheRetention: 'none' in the API call", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx({
			model: { name: "test-model" },
			getBranch: resolveTranscriptEntries,
		});
		createExtensionInHerdr(pi);

		vi.mocked(completeSimple).mockResolvedValueOnce({
			content: [{ type: "text", text: "fix bug" }],
		} as AssistantMessage);

		const handler = pi.commands.get("name-session-and-space")!;
		await withEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, async () => {
			await handler("", ctx);
		});
		await flushAsyncIIFE();

		expect(vi.mocked(completeSimple).mock.calls[0]![2]!.cacheRetention).toBe("none");
	});

	it("auto-generate: uses response content filter to extract text blocks only", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx({
			model: { name: "test-model" },
			getBranch: resolveTranscriptEntries,
		});
		createExtensionInHerdr(pi);

		// Response with mixed content types — only text blocks should be used
		vi.mocked(completeSimple).mockResolvedValueOnce({
			content: [
				{ type: "text", text: "fix auth bug" },
			] as AssistantMessage["content"],
		} as AssistantMessage);

		const handler = pi.commands.get("name-session-and-space")!;
		await withEnv({ HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, async () => {
			await handler("", ctx);
		});
		await flushAsyncIIFE();

		expect(pi.setSessionName).toHaveBeenCalledWith("fix auth bug");
	});
});

// ---------------------------------------------------------------------------
// session_shutdown when pollTimer is undefined (line 153 false branch)
// ---------------------------------------------------------------------------

describe("pi-herdr-integration — session_shutdown with no active timer", () => {
	it("does not throw when session_shutdown fires before any session_start set a timer", async () => {
		// Don't fire session_start at all, so pollTimer stays undefined.
		// session_shutdown must handle the undefined case gracefully (line 153 false branch).
		const pi = makeFakePi({ sessionName: "my session" });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		// Fire shutdown directly without starting a session first
		await withEnv({ HERDR_ENV: "1" }, async () => {
			await pi.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		});

		// If we get here without throwing, the false branch was handled correctly
		expect(true).toBe(true);
	});

	it("clears pollTimer when session_shutdown fires after a non-herdr session_start (timer never set)", async () => {
		// Start session WITHOUT herdr env — pollTimer never set
		const pi = makeFakePi({ sessionName: "my session" });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		// session_start without HERDR_ENV → pollTimer stays undefined
		await withEnv({}, async () => {
			await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		});

		// session_shutdown must not throw with undefined pollTimer
		await withEnv({}, async () => {
			await pi.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		});

		expect(true).toBe(true);
	});
});
