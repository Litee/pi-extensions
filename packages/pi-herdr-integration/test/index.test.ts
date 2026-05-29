import { describe, expect, it, vi } from "vitest";

import createExtension from "../src/index.js";
import { STATE_CUSTOM_TYPE } from "../src/state.js";
import type { StateCandidateEntry } from "../src/state.js";

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

function makeFakeCtx(entries: StateCandidateEntry[] = []) {
	return {
		ui: { notify: vi.fn() },
		sessionManager: { getEntries: vi.fn().mockReturnValue(entries) },
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
	it("subscribes to session_start and agent_end; does NOT register an extension /name command", () => {
		const pi = makeFakePi();
		createExtension(pi as never);

		const subscribed = pi.on.mock.calls.map((c: unknown[]) => c[0] as string);
		expect(subscribed).toContain("session_start");
		expect(subscribed).toContain("agent_end");
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

	it("renames workspace using stable workspace_id hash", async () => {
		const pi = makeFakePi({ sessionName: "my session" });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		// pane get → rename (no cmux exec)
		expect(pi.exec).toHaveBeenCalledTimes(2);
		expect(pi.exec.mock.calls[0]).toEqual(["herdr", ["pane", "get", "p_6"], { timeout: 5000 }]);
		expect(pi.exec.mock.calls[1]).toEqual(["herdr", ["workspace", "rename", WS_ID, "my session"], { timeout: 5000 }]);

		// dimmed info notification in pi TUI
		expect(ctx.ui.notify).toHaveBeenCalledWith(`herdr workspace renamed to "my session"`, "info");

		expect(pi.appendEntry).toHaveBeenCalledWith(STATE_CUSTOM_TYPE, expect.objectContaining({
			lastAppliedName: "my session",
			herdrWorkspaceId: WS_ID,
		}));
	});

	it("no-op on second call with same name", async () => {
		const pi = makeFakePi({ sessionName: "my session" });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		const callCountAfterFirst = pi.exec.mock.calls.length;

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		expect(pi.exec.mock.calls.length).toBe(callCountAfterFirst);
	});

	it("restores lastAppliedName from session entries and skips rename when name matches", async () => {
		const stateEntry: StateCandidateEntry = {
			type: "custom",
			customType: STATE_CUSTOM_TYPE,
			data: { lastAppliedName: "existing name", herdrWorkspaceId: WS_ID, appliedAt: 1000 },
		};
		const pi = makeFakePi({ sessionName: "existing name" });
		const ctx = makeFakeCtx([stateEntry]);
		createExtension(pi as never);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("renames if session name differs from persisted state", async () => {
		const stateEntry: StateCandidateEntry = {
			type: "custom",
			customType: STATE_CUSTOM_TYPE,
			data: { lastAppliedName: "old name", herdrWorkspaceId: WS_ID, appliedAt: 1000 },
		};
		const pi = makeFakePi({ sessionName: "new name" });
		const ctx = makeFakeCtx([stateEntry]);
		createExtension(pi as never);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(pi.exec).toHaveBeenCalledTimes(2);
		expect(pi.exec.mock.calls[1]?.[1]).toEqual(["workspace", "rename", WS_ID, "new name"]);
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

	it("notifies warning when rename fails, does not update lastAppliedName, retries when session_start resets lastAttemptedName", async () => {
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

	it("after pane-get failure, backoff guard prevents exec on subsequent agent_end with same name", async () => {
		const pi = makeFakePi({
			sessionName: "my session",
			execImpl: () => Promise.resolve({ code: 1, stdout: "", stderr: "herdr error" }),
		});
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		await fireAgentEnd(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		const callCountAfterFirst = pi.exec.mock.calls.length;

		// Same name — backoff guard fires, no exec calls
		await fireAgentEnd(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		expect(pi.exec.mock.calls.length).toBe(callCountAfterFirst);
	});

	it("after rename failure, backoff guard prevents exec on subsequent agent_end with same name", async () => {
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

		// Same name — backoff guard fires, no more exec calls
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

		// Different name — backoff guard doesn't fire, retry runs
		pi.getSessionName.mockReturnValue("different name");
		await fireAgentEnd(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		expect(pi.exec.mock.calls.length).toBeGreaterThan(callCountAfterFirst);
	});

	it("session_start with reason 'fork' does not restore lastAppliedName, so rename runs on forked workspace", async () => {
		const stateEntry: StateCandidateEntry = {
			type: "custom",
			customType: STATE_CUSTOM_TYPE,
			data: { lastAppliedName: "parent name", herdrWorkspaceId: WS_ID, appliedAt: 1000 },
		};
		const pi = makeFakePi({ sessionName: "parent name" });
		const ctx = makeFakeCtx([stateEntry]);
		createExtension(pi as never);

		// Fork: entries have "parent name" but lastAppliedName must NOT be restored
		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, "fork");

		expect(pi.exec).toHaveBeenCalledTimes(2);
		expect(pi.exec.mock.calls[1]?.[1]).toEqual(["workspace", "rename", WS_ID, "parent name"]);
	});

	it("session_start with reason 'startup' still restores lastAppliedName and skips rename when name matches", async () => {
		const stateEntry: StateCandidateEntry = {
			type: "custom",
			customType: STATE_CUSTOM_TYPE,
			data: { lastAppliedName: "existing name", herdrWorkspaceId: WS_ID, appliedAt: 1000 },
		};
		const pi = makeFakePi({ sessionName: "existing name" });
		const ctx = makeFakeCtx([stateEntry]);
		createExtension(pi as never);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" }, "startup");

		expect(pi.exec).not.toHaveBeenCalled();
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

	it("no-op when session name has not changed since last rename", async () => {
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
		// Feed fresh mocks for the second rename
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
