import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createExtensionWithClient } from "../src/index.js";
import { STATE_CUSTOM_TYPE } from "../src/persistence.js";
import { CUSTOM_MESSAGE_TYPE, POLL_INTERVAL_MS } from "../src/runtime.js";
import type { HeadObjectResult, S3Client } from "../src/s3-client.js";
import { resetToolRegisteredForTests } from "../src/toolAction.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Handlers {
	sessionStart?: (event: unknown, ctx: unknown) => Promise<void> | void;
	sessionShutdown?: (event: unknown, ctx: unknown) => Promise<void> | void;
}

interface CommandSpec {
	description: string;
	handler: (args: string, ctx: unknown) => Promise<void> | void;
}

function makePi(): {
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
			else if (event === "session_shutdown") {
				handlers.sessionShutdown = handler;
			}
		},
		sendMessage,
		appendEntry,
		registerTool,
		getActiveTools: () => [],
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
	it("registers the tool and message renderer from session_start (auto-enabled)", async () => {
		const { pi, handlers, registerTool, setActiveTools, registerMessageRenderer } = makePi();
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, makeCtx());
		expect(registerTool).toHaveBeenCalledOnce();
		expect(setActiveTools).toHaveBeenCalledOnce();
		expect(registerMessageRenderer).toHaveBeenCalledWith(
			CUSTOM_MESSAGE_TYPE,
			expect.any(Function),
		);
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
