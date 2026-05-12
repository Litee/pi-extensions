import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createExtensionWithClient } from "../src/index.js";
import { STATE_CUSTOM_TYPE } from "../src/persistence.js";
import { CUSTOM_MESSAGE_TYPE, POLL_INTERVAL_MS, STATUS_KEY } from "../src/runtime.js";
import type { HeadObjectResult, S3Client } from "../src/s3-client.js";
import { resetToolRegisteredForTests } from "../src/toolAction.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Handlers {
	sessionStart?: (event: unknown, ctx: unknown) => Promise<void> | void;
	sessionShutdown?: (event: unknown, ctx: unknown) => Promise<void> | void;
	turnEnd?: (event: unknown, ctx: unknown) => Promise<void> | void;
}

interface CommandSpec {
	description: string;
	handler: (args: string, ctx: unknown) => Promise<void> | void;
}

function makePi(opts: { activeTools?: () => string[] } = {}): {
	pi: ExtensionAPI;
	handlers: Handlers;
	commands: Record<string, CommandSpec>;
	sendMessage: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
	registerTool: ReturnType<typeof vi.fn>;
	setActiveTools: ReturnType<typeof vi.fn>;
	registerMessageRenderer: ReturnType<typeof vi.fn>;
} {
	const handlers: Handlers = {};
	const commands: Record<string, CommandSpec> = {};
	const sendMessage = vi.fn();
	const appendEntry = vi.fn();
	const registerTool = vi.fn();
	const setActiveTools = vi.fn();
	const registerMessageRenderer = vi.fn();
	const pi = {
		on: (event: string, handler: (e: unknown, ctx: unknown) => Promise<void> | void) => {
			if (event === "session_start") handlers.sessionStart = handler;
			else if (event === "session_shutdown") handlers.sessionShutdown = handler;
			else if (event === "turn_end") handlers.turnEnd = handler;
		},
		sendMessage,
		appendEntry,
		registerTool,
		getActiveTools: opts.activeTools ?? (() => []),
		setActiveTools,
		registerMessageRenderer,
		registerCommand: (name: string, spec: CommandSpec) => {
			commands[name] = spec;
		},
		events: { on: vi.fn().mockReturnValue(() => {}), emit: vi.fn() },
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands, sendMessage, appendEntry, registerTool, setActiveTools, registerMessageRenderer };
}

function makeCtx(stateEntries: unknown[] = []) {
	return {
		hasUI: false,
		sessionManager: {
			getEntries: () => stateEntries,
		},
	};
}

function makeClient(resp: HeadObjectResult = { exists: false }): S3Client {
	return { headObject: vi.fn().mockResolvedValue(resp) };
}

beforeEach(() => {
	resetToolRegisteredForTests();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createExtensionWithClient — session lifecycle", () => {
	it("registers the tool and message renderer from session_start; removes auto-added tool when enabled=false", async () => {
		const { pi, handlers, registerTool, setActiveTools, registerMessageRenderer } = makePi({
			// pi auto-added s3_watcher on startup
			activeTools: () => ["s3_watcher", "read"],
		});
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, makeCtx());
		expect(registerTool).toHaveBeenCalledOnce();
		// Must strip auto-added s3_watcher since enabled defaults to false
		expect(setActiveTools).toHaveBeenCalledWith(["read"]);
		expect(registerMessageRenderer).toHaveBeenCalledWith(
			CUSTOM_MESSAGE_TYPE,
			expect.any(Function),
		);
	});

	it("does NOT remove tool from active when enabled=true is persisted", async () => {
		const { pi, handlers, setActiveTools } = makePi({
			activeTools: () => ["s3_watcher", "read"],
		});
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, makeCtx([
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: { savedAt: 1, paused: false, watches: [], baselines: { enabled: true } } },
		]));
		expect(setActiveTools).not.toHaveBeenCalled();
	});

	it("registers the /s3-watcher command", () => {
		const { pi, commands } = makePi();
		createExtensionWithClient(pi, makeClient());
		expect(commands["s3-watcher"]).toBeDefined();
		expect(commands["s3-watcher"]!.description).toMatch(/S3 object watcher/);
	});

	it("rehydrates persisted watches and re-seeds missing baselines", async () => {
		const { pi, handlers } = makePi();
		const persisted = {
			savedAt: 1,
			paused: false,
			baselines: { enabled: true },
			watches: [{
				watchId: "w1",
				bucket: "b",
				key: "k",
				profile: "p",
				target: "exists",
				addedAt: 0,
				terminal: false,
				consecutiveErrors: 0,
			}],
		};
		const client = makeClient({ exists: true, etag: '"x"', contentLength: 3 });
		createExtensionWithClient(pi, client);
		await handlers.sessionStart!({}, makeCtx([
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: persisted },
		]));
		expect(client.headObject).toHaveBeenCalledWith("b", "k", "p", undefined);
	});

	it("emits a deferred startup chat message when watches are present", async () => {
		vi.useFakeTimers();
		const { pi, handlers, sendMessage } = makePi();
		const persisted = {
			savedAt: 1,
			paused: false,
			baselines: { enabled: true },
			watches: [{
				watchId: "w1",
				bucket: "b",
				key: "k",
				profile: "p",
				target: "exists",
				addedAt: 0,
				baseline: { exists: false },
				terminal: false,
				consecutiveErrors: 0,
			}],
		};
		createExtensionWithClient(pi, makeClient({ exists: false }));
		await handlers.sessionStart!({}, makeCtx([
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: persisted },
		]));
		// setImmediate — flush microtasks + the immediate queue without re-running the poll loop.
		await vi.advanceTimersByTimeAsync(0);
		expect(sendMessage).toHaveBeenCalledOnce();
		const [msg, opts] = sendMessage.mock.calls[0]! as [
			{ customType: string; content: string },
			{ triggerTurn: boolean },
		];
		expect(msg.customType).toBe(CUSTOM_MESSAGE_TYPE);
		expect(msg.content).toMatch(/watching 1 object/);
		expect(opts.triggerTurn).toBe(false);
	});

	it("does not send a startup message when there are no persisted watches", async () => {
		const { pi, handlers, sendMessage } = makePi();
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, makeCtx());
		// setImmediate shouldn't schedule anything — verify synchronously.
		await new Promise((r) => setImmediate(r));
		expect(sendMessage).not.toHaveBeenCalled();
	});
});

describe("/s3-watcher command", () => {
	it("status notifies the summary line", async () => {
		const { pi, handlers, commands } = makePi();
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, makeCtx());
		const notify = vi.fn();
		await commands["s3-watcher"]!.handler("status", {
			hasUI: true,
			ui: { notify, hasUI: true },
		});
		expect(notify).toHaveBeenCalledOnce();
		const msg = notify.mock.calls[0]![0] as string;
		expect(msg).toMatch(/s3-watcher: active/);
		expect(msg).toMatch(new RegExp(`poll: ${Math.round(POLL_INTERVAL_MS / 1000)}s`));
	});

	it("pause / resume toggles state and notifies", async () => {
		const { pi, handlers, commands } = makePi();
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, makeCtx());
		const notify = vi.fn();
		const ctx = { hasUI: true, ui: { notify, hasUI: true } };
		await commands["s3-watcher"]!.handler("pause", ctx);
		expect(notify).toHaveBeenCalledWith("s3-watcher: paused.", "info");
		await commands["s3-watcher"]!.handler("resume", ctx);
		expect(notify).toHaveBeenCalledWith("s3-watcher: resumed.", "info");
	});

	it("warns on unknown subcommand", async () => {
		const { pi, handlers, commands } = makePi();
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, makeCtx());
		const notify = vi.fn();
		await commands["s3-watcher"]!.handler("blarf", {
			hasUI: true,
			ui: { notify, hasUI: true },
		});
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/unknown subcommand 'blarf'/),
			"warning",
		);
	});
});

describe("status-line visibility depends on rt.enabled (not getActiveTools)", () => {
	function makePersistedState(enabled: boolean) {
		return [
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: { savedAt: 1, paused: false, watches: [], baselines: { enabled } } },
		];
	}

	it("hides the status row on session_start when enabled=false (no persisted state)", async () => {
		const setStatus = vi.fn();
		const { pi, handlers } = makePi({ activeTools: () => ["read", "bash"] });
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, {
			hasUI: true,
			ui: { hasUI: true, setStatus, theme: { fg: (_c: string, t: string) => t } },
			sessionManager: { getEntries: () => [] },
		});
		const ours = setStatus.mock.calls.filter((c) => c[0] === STATUS_KEY);
		expect(ours.length).toBeGreaterThan(0);
		for (const call of ours) expect(call[1]).toBeUndefined();
	});

	it("pins the status row on session_start when enabled=true is persisted", async () => {
		const setStatus = vi.fn();
		const { pi, handlers } = makePi({ activeTools: () => ["s3_watcher", "read"] });
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, {
			hasUI: true,
			ui: { hasUI: true, setStatus, theme: { fg: (_c: string, t: string) => t } },
			sessionManager: { getEntries: () => makePersistedState(true) },
		});
		const ours = setStatus.mock.calls.filter((c) => c[0] === STATUS_KEY);
		const pinned = ours.filter((c) => typeof c[1] === "string");
		expect(pinned.length).toBeGreaterThan(0);
		expect(pinned.at(-1)![1]).toMatch(/^aws-s3: idle$/);
	});

	it("hides the row even if s3_watcher is in getActiveTools() but enabled=false", async () => {
		// This is the regression test for the re-opened #0002:
		// pi auto-activates the tool on session_start; without rt.enabled gating,
		// the row would pin even though the user never activated the feature.
		const setStatus = vi.fn();
		const { pi, handlers } = makePi({ activeTools: () => ["s3_watcher", "read", "bash"] });
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, {
			hasUI: true,
			ui: { hasUI: true, setStatus, theme: { fg: (_c: string, t: string) => t } },
			sessionManager: { getEntries: () => [] }, // no persisted enabled=true
		});
		const ours = setStatus.mock.calls.filter((c) => c[0] === STATUS_KEY);
		expect(ours.length).toBeGreaterThan(0);
		for (const call of ours) expect(call[1]).toBeUndefined();
	});

	it("turn_end: activating s3_watcher persists enabled=true and pins the row", async () => {
		const setStatus = vi.fn();
		const appendEntry = vi.fn();
		let active: string[] = ["read"];
		const { pi, handlers } = makePi({ activeTools: () => active });
		(pi as unknown as { appendEntry: typeof appendEntry }).appendEntry = appendEntry;
		createExtensionWithClient(pi, makeClient());
		const ctx = {
			hasUI: true,
			ui: { hasUI: true, setStatus, theme: { fg: (_c: string, t: string) => t } },
			sessionManager: { getEntries: () => [] },
		};
		await handlers.sessionStart!({}, ctx);
		expect(handlers.turnEnd).toBeDefined();
		active = ["read", "s3_watcher"];
		setStatus.mockClear();
		await handlers.turnEnd!({}, ctx);
		// enabled=true must have been persisted
		const stateCalls = appendEntry.mock.calls.filter((c) => c[0] === STATE_CUSTOM_TYPE);
		expect(stateCalls.length).toBeGreaterThan(0);
		const lastData = stateCalls.at(-1)![1] as { baselines?: { enabled?: boolean } };
		expect(lastData.baselines?.enabled).toBe(true);
		// Status row must be pinned
		const pinned = setStatus.mock.calls
			.filter((c) => c[0] === STATUS_KEY)
			.filter((c) => typeof c[1] === "string");
		expect(pinned.length).toBeGreaterThan(0);
	});

	it("turn_end: deactivating s3_watcher persists enabled=false and clears the row", async () => {
		const setStatus = vi.fn();
		const appendEntry = vi.fn();
		let active: string[] = ["s3_watcher", "read"];
		const { pi, handlers } = makePi({ activeTools: () => active });
		(pi as unknown as { appendEntry: typeof appendEntry }).appendEntry = appendEntry;
		createExtensionWithClient(pi, makeClient());
		const ctx = {
			hasUI: true,
			ui: { hasUI: true, setStatus, theme: { fg: (_c: string, t: string) => t } },
			sessionManager: { getEntries: () => makePersistedState(true) },
		};
		await handlers.sessionStart!({}, ctx);
		active = ["read"];
		setStatus.mockClear();
		appendEntry.mockClear();
		await handlers.turnEnd!({}, ctx);
		// enabled=false must have been persisted
		const stateCalls = appendEntry.mock.calls.filter((c) => c[0] === STATE_CUSTOM_TYPE);
		expect(stateCalls.length).toBeGreaterThan(0);
		const lastData = stateCalls.at(-1)![1] as { baselines?: { enabled?: boolean } };
		expect(lastData.baselines?.enabled).toBe(false);
		// Status row must be cleared
		const ours = setStatus.mock.calls.filter((c) => c[0] === STATUS_KEY);
		expect(ours.length).toBeGreaterThan(0);
		for (const call of ours) expect(call[1]).toBeUndefined();
	});
});
