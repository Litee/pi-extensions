import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import createExtension from "../src/index.js";
import { STATE_CUSTOM_TYPE } from "../src/state.js";

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
	readonly handlers: Map<string, (...args: unknown[]) => unknown>;
}

function makeFakePi(overrides?: {
	sessionName?: string | undefined;
	execImpl?: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}): StubPi {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();

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
		handlers,
	};
}

function makeFakeCtx() {
	return {
		ui: { notify: vi.fn() },
		sessionManager: { getEntries: vi.fn().mockReturnValue([]) },
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
// Wiring
// ---------------------------------------------------------------------------

describe("pi-herdr-integration — wiring", () => {
	it("subscribes to session_start, agent_end, and session_shutdown; does NOT register an extension /name command", () => {
		const pi = makeFakePi();
		createExtension(pi as never);

		const subscribed = pi.on.mock.calls.map((c: unknown[]) => c[0] as string);
		expect(subscribed).toContain("session_start");
		expect(subscribed).toContain("agent_end");
		expect(subscribed).toContain("session_shutdown");
		expect(subscribed).not.toContain("input");
	});
});

// ---------------------------------------------------------------------------
// session_start
// ---------------------------------------------------------------------------

describe("pi-herdr-integration — session_start", () => {
	it("skips when not in herdr (HERDR_ENV not set)", async () => {
		const pi = makeFakePi({ sessionName: "my session" });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		const saved = { ...process.env };
		delete process.env["HERDR_ENV"];
		try {
			await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		} finally {
			Object.assign(process.env, saved);
		}

		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("skips when no session name", async () => {
		const pi = makeFakePi({ sessionName: undefined });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("always renames on session_start regardless of any previous state", async () => {
		const pi = makeFakePi({ sessionName: "my session" });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

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
		createExtension(pi as never);

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
		createExtension(pi as never);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, "fork");

		expect(pi.exec).toHaveBeenCalledTimes(2);
		expect(pi.exec.mock.calls[1]?.[1]).toEqual(["workspace", "rename", WS_ID, "my session"]);
	});

	it("renames on resume — resumed session may be in a different workspace than when last run", async () => {
		const pi = makeFakePi({ sessionName: "my session" });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

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
		createExtension(pi as never);

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
		createExtension(pi as never);

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
		createExtension(pi as never);

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
		createExtension(pi as never);

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
		createExtension(pi as never);

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
		createExtension(pi as never);

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
		createExtension(pi as never);

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
		createExtension(pi as never);

		await fireAgentEnd(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(pi.exec).toHaveBeenCalledTimes(2);
		expect(pi.exec.mock.calls[1]?.[1]).toEqual(["workspace", "rename", WS_ID, "new name"]);
	});

	it("no-op on agent_end when name has not changed since last rename", async () => {
		const pi = makeFakePi({ sessionName: "my session" });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

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
		createExtension(pi as never);

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
		createExtension(pi as never);

		await fireAgentEnd(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("skips when not in herdr", async () => {
		const pi = makeFakePi({ sessionName: "my session" });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		await fireAgentEnd(pi, ctx, {});

		expect(pi.exec).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Idle poll (15-second interval)
// ---------------------------------------------------------------------------

describe("pi-herdr-integration — idle poll", () => {
	// Persist herdr env variables across the async timer callbacks that fire
	// after withEnv has already restored the original env.
	let savedEnv: Record<string, string | undefined>;
	beforeEach(() => {
		savedEnv = { HERDR_ENV: process.env["HERDR_ENV"], HERDR_PANE_ID: process.env["HERDR_PANE_ID"] };
		process.env["HERDR_ENV"] = "1";
		process.env["HERDR_PANE_ID"] = "p_6";
	});
	afterEach(() => {
		if (savedEnv["HERDR_ENV"] === undefined) delete process.env["HERDR_ENV"];
		else process.env["HERDR_ENV"] = savedEnv["HERDR_ENV"];
		if (savedEnv["HERDR_PANE_ID"] === undefined) delete process.env["HERDR_PANE_ID"];
		else process.env["HERDR_PANE_ID"] = savedEnv["HERDR_PANE_ID"];
		vi.useRealTimers();
	});

	it("idle poll renames when name changes without an agent_end", async () => {
		vi.useFakeTimers();
		const pi = makeFakePi({ sessionName: "initial" });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		// Fire session_start — initial rename consumes the first two exec mocks.
		await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		expect(pi.exec).toHaveBeenCalledTimes(2);

		// Change name without firing agent_end.
		pi.getSessionName.mockReturnValue("new name");
		// Re-arm exec for the poll-triggered rename (pane get + rename).
		pi.exec.mockResolvedValueOnce({ code: 0, stdout: PANE_GET_JSON, stderr: "" });
		pi.exec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

		// Advance 15 s — the poll callback fires and renames.
		await vi.advanceTimersByTimeAsync(15000);

		const renameCalls = pi.exec.mock.calls.filter(
			(c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[])[1] === "rename",
		);
		expect(renameCalls[renameCalls.length - 1]?.[1]).toEqual(["workspace", "rename", WS_ID, "new name"]);
	});

	it("idle poll is a no-op when name has not changed since last rename", async () => {
		vi.useFakeTimers();
		const pi = makeFakePi({ sessionName: "my session" });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		expect(vi.getTimerCount()).toBe(1);
		const execAfterStart = pi.exec.mock.calls.length; // 2 calls for the initial rename

		// Advance 45 s (3 poll ticks) with the same name — should be a no-op each time.
		await vi.advanceTimersByTimeAsync(45000);

		expect(pi.exec.mock.calls.length).toBe(execAfterStart);
	});

	it("no timer leak: only one interval is active after multiple session_start events", async () => {
		vi.useFakeTimers();
		const pi = makeFakePi({ sessionName: "name1" });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		// session_start #1
		await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

		// Exactly one interval should be armed after the first session_start.
		expect(vi.getTimerCount()).toBe(1);

		// session_start #2 (/reload) — re-arm exec for the second immediate rename.
		pi.exec.mockResolvedValueOnce({ code: 0, stdout: PANE_GET_JSON, stderr: "" });
		pi.exec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
		await pi.handlers.get("session_start")?.({ type: "session_start", reason: "reload" }, ctx);

		// Still exactly one interval — the previous one was cleared, not leaked.
		expect(vi.getTimerCount()).toBe(1);

		// Change name and re-arm for the single poll tick.
		pi.getSessionName.mockReturnValue("new name");
		pi.exec.mockResolvedValueOnce({ code: 0, stdout: PANE_GET_JSON, stderr: "" });
		pi.exec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
		const execBeforePoll = pi.exec.mock.calls.length;

		// Advance 15 s — exactly ONE interval should fire (previous was cleared).
		await vi.advanceTimersByTimeAsync(15000);

		// One rename = 2 exec calls (pane get + rename). A leaked second timer
		// would have shown up as getTimerCount() === 2 above.
		expect(pi.exec.mock.calls.length).toBe(execBeforePoll + 2);
	});

	it("idle poll is a no-op when the session has no name", async () => {
		vi.useFakeTimers();
		const pi = makeFakePi({ sessionName: undefined });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		// session_start with no name: starts the timer but performs no rename.
		await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		expect(vi.getTimerCount()).toBe(1);
		expect(pi.exec).not.toHaveBeenCalled();

		// Poll fires while the name is still absent — must short-circuit, no exec.
		await vi.advanceTimersByTimeAsync(30000);
		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("session_shutdown stops the poll timer", async () => {
		vi.useFakeTimers();
		const pi = makeFakePi({ sessionName: "initial" });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

		// Tear down the session.
		await pi.handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		expect(vi.getTimerCount()).toBe(0);

		// Change name and record exec count after shutdown.
		pi.getSessionName.mockReturnValue("after shutdown");
		const execAfterShutdown = pi.exec.mock.calls.length;

		// Advance 30 s — no timer should fire.
		await vi.advanceTimersByTimeAsync(30000);

		expect(pi.exec.mock.calls.length).toBe(execAfterShutdown);
	});

	it("does not arm the poll timer when not inside herdr", async () => {
		vi.useFakeTimers();
		// Remove herdr env for this test only (beforeEach set it).
		delete process.env["HERDR_ENV"];
		const pi = makeFakePi({ sessionName: "my session" });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

		// No timer scheduled outside herdr, and no exec attempted.
		expect(vi.getTimerCount()).toBe(0);
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
		createExtension(pi as never);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		await fireAgentEnd(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("skips rename for other subagent name variants", async () => {
		const names = ["andrey-worker#aabbcc", "andrey-scout#1234abcd", "some-agent#ffffff00"];
		for (const sessionName of names) {
			const pi = makeFakePi({ sessionName });
			const ctx = makeFakeCtx();
			createExtension(pi as never);
			await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
			expect(pi.exec).not.toHaveBeenCalled();
		}
	});

	it("does not skip a human-chosen name that happens to contain a hash", async () => {
		const pi = makeFakePi({ sessionName: "fix #123" });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(pi.exec).toHaveBeenCalledTimes(2);
	});
});
