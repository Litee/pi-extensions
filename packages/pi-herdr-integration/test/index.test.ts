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
	appendEntry: ReturnType<typeof vi.fn>;
	setSessionName: ReturnType<typeof vi.fn>;
	readonly handlers: Map<string, (...args: unknown[]) => unknown>;
}

function makeFakePi(overrides?: {
	sessionName?: string | undefined;
	execImpl?: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
}): StubPi {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();

	// Default exec: first call returns pane get, second call (rename) returns success
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
		appendEntry: vi.fn(),
		setSessionName: vi.fn(),
		handlers,
	};
}

function makeFakeCtx(entries: StateCandidateEntry[] = []) {
	return {
		ui: {
			notify: vi.fn(),
		},
		sessionManager: {
			getEntries: vi.fn().mockReturnValue(entries),
		},
	};
}

/** Fire the session_start handler with given env overrides. */
async function fireSessionStart(
	pi: StubPi,
	ctx: ReturnType<typeof makeFakeCtx>,
	env?: Record<string, string>,
): Promise<void> {
	const savedEnv = { ...process.env };
	if (env) {
		for (const [k, v] of Object.entries(env)) {
			process.env[k] = v;
		}
		for (const k of Object.keys(savedEnv)) {
			if (!(k in env)) delete process.env[k];
		}
	}
	try {
		await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
	} finally {
		for (const k of Object.keys(process.env)) {
			delete process.env[k];
		}
		for (const [k, v] of Object.entries(savedEnv)) {
			process.env[k] = v;
		}
	}
}

/** Fire the input handler. */
async function fireInput(
	pi: StubPi,
	ctx: ReturnType<typeof makeFakeCtx>,
	text: string,
	env?: Record<string, string>,
): Promise<void> {
	const savedEnv = { ...process.env };
	if (env) {
		for (const [k, v] of Object.entries(env)) {
			process.env[k] = v;
		}
		for (const k of Object.keys(savedEnv)) {
			if (!(k in env)) delete process.env[k];
		}
	}
	try {
		const result = pi.handlers.get("input")?.({ type: "input", text, source: "interactive" }, ctx);
		if (result instanceof Promise) await result;
	} finally {
		for (const k of Object.keys(process.env)) {
			delete process.env[k];
		}
		for (const [k, v] of Object.entries(savedEnv)) {
			process.env[k] = v;
		}
	}
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe("pi-herdr-integration — wiring", () => {
	it("subscribes to session_start and input, not agent_end", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const subscribed = pi.on.mock.calls.map((c: unknown[]) => c[0] as string);
		expect(subscribed).toContain("session_start");
		expect(subscribed).toContain("input");
		expect(subscribed).not.toContain("agent_end");
	});
});

// ---------------------------------------------------------------------------
// session_start
// ---------------------------------------------------------------------------

describe("pi-herdr-integration — session_start", () => {
	it("skip when not in herdr (HERDR_ENV not set)", async () => {
		const pi = makeFakePi({ sessionName: "my session" });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		const savedEnv = { ...process.env };
		delete process.env["HERDR_ENV"];
		try {
			await pi.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		} finally {
			Object.assign(process.env, savedEnv);
		}

		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("skip when no session name (getSessionName returns undefined)", async () => {
		const pi = makeFakePi({ sessionName: undefined });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("renames workspace on session_start using stable workspace_id hash", async () => {
		const pi = makeFakePi({ sessionName: "my session" });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		// First exec: pane get with HERDR_PANE_ID; second exec: workspace rename with hash ID
		expect(pi.exec).toHaveBeenCalledTimes(2);
		expect(pi.exec.mock.calls[0]).toEqual(["herdr", ["pane", "get", "p_6"], undefined]);
		expect(pi.exec.mock.calls[1]).toEqual(["herdr", ["workspace", "rename", WS_ID, "my session"], undefined]);

		// appendEntry called with correct state (herdrWorkspaceId is the hash)
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

	it("notifies warning when pane get fails (workspace lookup)", async () => {
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

	it("notifies warning when rename fails, does not update lastAppliedName, retries on next event", async () => {
		let paneGetCalled = false;
		const pi = makeFakePi({
			sessionName: "my session",
			execImpl: (_cmd, args) => {
				if (args[1] === "get") {
					paneGetCalled = true;
					return Promise.resolve({ code: 0, stdout: PANE_GET_JSON, stderr: "" });
				}
				// rename fails
				return Promise.resolve({ code: 1, stdout: "", stderr: "rename failed" });
			},
		});
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(paneGetCalled).toBe(true);
		expect(ctx.ui.notify).toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();

		// lastAppliedName was NOT updated, so next event retries
		pi.exec.mockResolvedValueOnce({ code: 0, stdout: PANE_GET_JSON, stderr: "" });
		pi.exec.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
		ctx.ui.notify.mockReset();

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		expect(pi.exec).toHaveBeenCalled();
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

		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("skips rename for other subagent name variants", async () => {
		const names = [
			"andrey-worker#aabbcc",
			"andrey-scout#1234abcd",
			"some-agent#ffffff00",
		];
		for (const sessionName of names) {
			const pi = makeFakePi({ sessionName });
			const ctx = makeFakeCtx();
			createExtension(pi as never);
			await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
			expect(pi.exec).not.toHaveBeenCalled();
		}
	});

	it("does not skip a human-chosen name that happens to contain a hash", async () => {
		// e.g. "fix #123" — has # but not the agent#hexid pattern
		const pi = makeFakePi({ sessionName: "fix #123" });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(pi.exec).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------

describe("pi-herdr-integration — input", () => {
	it("/name <X> triggers rename using the matched name (not getSessionName)", async () => {
		// getSessionName returns something different to prove it's NOT used
		const pi = makeFakePi({ sessionName: "different session name" });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		await fireInput(pi, ctx, "/name my workspace", { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(pi.exec).toHaveBeenCalledTimes(2);
		expect(pi.exec.mock.calls[0]?.[1]).toEqual(["pane", "get", "p_6"]);
		expect(pi.exec.mock.calls[1]?.[1]).toEqual(["workspace", "rename", WS_ID, "my workspace"]);
		expect(pi.appendEntry).toHaveBeenCalledWith(STATE_CUSTOM_TYPE, expect.objectContaining({
			lastAppliedName: "my workspace",
			herdrWorkspaceId: WS_ID,
		}));
	});

	it("/name without argument is no-op", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		await fireInput(pi, ctx, "/name", { HERDR_ENV: "1" });

		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("non-name command is ignored", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		await fireInput(pi, ctx, "/goal do something", { HERDR_ENV: "1" });

		expect(pi.exec).not.toHaveBeenCalled();
	});

	it("same name as lastApplied is no-op", async () => {
		const pi = makeFakePi({ sessionName: "foo" });
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		await fireSessionStart(pi, ctx, { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		const callsAfterFirst = pi.exec.mock.calls.length;

		await fireInput(pi, ctx, "/name foo", { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });
		expect(pi.exec.mock.calls.length).toBe(callsAfterFirst);
	});

	it("/name with leading/trailing spaces is handled correctly", async () => {
		const pi = makeFakePi();
		const ctx = makeFakeCtx();
		createExtension(pi as never);

		await fireInput(pi, ctx, "  /name  trimmed name  ", { HERDR_ENV: "1", HERDR_PANE_ID: "p_6" });

		expect(pi.exec).toHaveBeenCalledTimes(2);
		expect(pi.exec.mock.calls[1]?.[1]).toEqual(["workspace", "rename", WS_ID, "trimmed name"]);
	});
});
