import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

vi.mock("../src/config.js", () => ({
	loadConfig: vi.fn(() => ({})),
	saveConfig: vi.fn(() => true),
}));
import { loadConfig, saveConfig } from "../src/config.js";

import { createExtensionWithClient } from "../src/index.js";
import { STATE_CUSTOM_TYPE } from "../src/persistence.js";
import { CUSTOM_MESSAGE_TYPE, STATUS_KEY } from "../src/runtime.js";
import type { HeadObjectResult, S3Client } from "../src/s3-client.js";
import { resetToolRegisteredForTests } from "../src/toolAction.js";
import {
		ITEM_BROWSE_PREFIX,
		ITEM_CLOSE,
		ITEM_DISPLAY_PREFIX,
		ITEM_PAUSED_PREFIX,
		ITEM_USER_DEFAULT_PREFIX,
		MENU_TITLE,
} from "../src/command.js";

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
	vi.mocked(loadConfig).mockReturnValue({});
	vi.mocked(saveConfig).mockReset();
	vi.mocked(saveConfig).mockReturnValue(true);
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
describe("status-line visibility: shown in statusline mode, cleared in widget mode", () => {
	function makePersistedState(enabled: boolean) {
		return [
			{ type: "custom", customType: STATE_CUSTOM_TYPE, data: { savedAt: 1, paused: false, watches: [], baselines: { enabled, displayMode: "statusline" } } },
		];
	}

	it("clears status line on session_start in default widget mode (no persisted state)", async () => {
		// Default displayMode is "widget" — status line is cleared, widget is shown instead.
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
		// In widget mode the status row is cleared (undefined), not pinned.
		const cleared = ours.filter((c) => c[1] === undefined);
		expect(cleared.length).toBeGreaterThan(0);
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

	it("in widget mode status is cleared regardless of s3_watcher active-tool membership", async () => {
		// displayMode defaults to "widget" — status row is cleared, not pinned.
		// rt.enabled / active-tool state does not affect this.
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
		// Widget mode → all calls clear the row (undefined value).
		const cleared = ours.filter((c) => c[1] === undefined);
		expect(cleared.length).toBeGreaterThan(0);
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
		// Widget mode (default) — status row is cleared, not pinned.
		const cleared = setStatus.mock.calls
			.filter((c) => c[0] === STATUS_KEY)
			.filter((c) => c[1] === undefined);
		expect(cleared.length).toBeGreaterThan(0);
	});

	it("turn_end: deactivating s3_watcher persists enabled=false, widget mode clears status row", async () => {
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
		// Status row stays visible (shows idle) — polling is NOT stopped on deactivate
		const ourCalls = setStatus.mock.calls.filter((c) => c[0] === STATUS_KEY);
		expect(ourCalls.length).toBeGreaterThan(0);
		for (const call of ourCalls) expect(call[1]).toBeDefined();
	});
});

describe("polling decoupled from rt.enabled (#0003)", () => {
	function makePersistedWithWatch(enabled: boolean) {
		return [
			{
				type: "custom",
				customType: STATE_CUSTOM_TYPE,
				data: {
					savedAt: 1,
					paused: false,
					baselines: { enabled },
					watches: [
						{
							watchId: "w1",
							bucket: "my-bucket",
							key: "my/key",
							profile: "default",
							target: "exists",
							timeoutAt: Date.now() + 3_600_000,
							addedAt: Date.now(),
							baseline: { exists: false }, // seeded: absent → poll will detect transition to present
							terminal: false,
							consecutiveErrors: 0,
						},
					],
				},
			},
		];
	}

	it("starts polling on session_start even when enabled=false but watches exist", async () => {
		vi.useFakeTimers();
		const client = makeClient({ exists: false });
		const { pi, handlers } = makePi({ activeTools: () => [] });
		createExtensionWithClient(pi, client);
		await handlers.sessionStart!({}, makeCtx(makePersistedWithWatch(false)));
		// Advance past one poll cycle
		await vi.advanceTimersByTimeAsync(65_000);
		expect((client.headObject as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
	});

	it("keeps polling after turn_end deactivation", async () => {
		vi.useFakeTimers();
		const client = makeClient({ exists: false });
		let active = ["s3_watcher", "read"];
		const { pi, handlers } = makePi({ activeTools: () => active });
		createExtensionWithClient(pi, client);
		await handlers.sessionStart!({}, makeCtx(makePersistedWithWatch(true)));
		// Deactivate
		active = ["read"];
		await handlers.turnEnd!({}, makeCtx());
		// Clear prior calls
		(client.headObject as ReturnType<typeof vi.fn>).mockClear();
		// Advance past a poll cycle — polling must still be running
		await vi.advanceTimersByTimeAsync(65_000);
		expect((client.headObject as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
	});

	it("change notification when disabled includes re-activation hint", async () => {
		vi.useFakeTimers();
		// Client returns exists=true on first poll (target=exists → fires)
		const client = makeClient({ exists: true });
		const { pi, handlers, sendMessage } = makePi({ activeTools: () => [] });
		createExtensionWithClient(pi, client);
		await handlers.sessionStart!({}, makeCtx(makePersistedWithWatch(false)));
		await vi.advanceTimersByTimeAsync(65_000);
		const changeCalls = sendMessage.mock.calls.filter(
			(c) => (c[0] as { customType: string }).customType === CUSTOM_MESSAGE_TYPE &&
				(c[0] as { content: string }).content.includes("detected"),
		);
		expect(changeCalls.length).toBeGreaterThan(0);
		const content = (changeCalls[0]![0] as { content: string }).content;
		expect(content).toContain("manage_tools");
		expect(content).toContain("activate");
	});

	it("change notification when enabled does NOT include re-activation hint", async () => {
		vi.useFakeTimers();
		const client = makeClient({ exists: true });
		const active = ["s3_watcher", "read"];
		const { pi, handlers, sendMessage } = makePi({ activeTools: () => active });
		createExtensionWithClient(pi, client);
		await handlers.sessionStart!({}, makeCtx(makePersistedWithWatch(true)));
		// Deactivation must NOT have happened
		expect(active).toContain("s3_watcher");
		await vi.advanceTimersByTimeAsync(65_000);
		const changeCalls = sendMessage.mock.calls.filter(
			(c) => (c[0] as { customType: string }).customType === CUSTOM_MESSAGE_TYPE &&
				(c[0] as { content: string }).content.includes("detected"),
		);
		expect(changeCalls.length).toBeGreaterThan(0);
		const content = (changeCalls[0]![0] as { content: string }).content;
		expect(content).not.toContain("manage_tools");
	});
});

describe("user config: defaultDisplayMode (#0005)", () => {
	function makeUiCtx(setStatus: ReturnType<typeof vi.fn>, entries: unknown[] = []) {
		return {
			hasUI: true,
			ui: { hasUI: true, setStatus, theme: { fg: (_c: string, t: string) => t } },
			sessionManager: { getEntries: () => entries },
		};
	}

	it("uses defaultDisplayMode='statusline' from user config when no persisted state", async () => {
		vi.mocked(loadConfig).mockReturnValue({ defaultDisplayMode: "statusline" });
		const setStatus = vi.fn();
		const { pi, handlers } = makePi({ activeTools: () => ["read"] });
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, makeUiCtx(setStatus));
		const ours = setStatus.mock.calls.filter((c) => c[0] === STATUS_KEY);
		const pinned = ours.filter((c) => typeof c[1] === "string");
		expect(pinned.length).toBeGreaterThan(0);
		expect(pinned.at(-1)![1]).toMatch(/^aws-s3: idle$/);
	});

	it("falls back to widget when user config has no defaultDisplayMode", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const setStatus = vi.fn();
		const { pi, handlers } = makePi({ activeTools: () => ["read"] });
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, makeUiCtx(setStatus));
		const ours = setStatus.mock.calls.filter((c) => c[0] === STATUS_KEY);
		// Widget mode → all calls clear the row (undefined).
		const cleared = ours.filter((c) => c[1] === undefined);
		expect(cleared.length).toBeGreaterThan(0);
		expect(ours.every((c) => c[1] === undefined)).toBe(true);
	});

	it("persisted displayMode wins over user config", async () => {
		vi.mocked(loadConfig).mockReturnValue({ defaultDisplayMode: "statusline" });
		const setStatus = vi.fn();
		const { pi, handlers } = makePi({ activeTools: () => ["read"] });
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, makeUiCtx(setStatus, [
			{
				type: "custom",
				customType: STATE_CUSTOM_TYPE,
				data: {
					savedAt: 1,
					paused: false,
					watches: [],
					baselines: { enabled: false, displayMode: "widget" },
				},
			},
		]));
		const ours = setStatus.mock.calls.filter((c) => c[0] === STATUS_KEY);
		// Persisted widget mode → status row cleared even though config asked for statusline.
		expect(ours.every((c) => c[1] === undefined)).toBe(true);
	});
});

describe("/s3-watcher TUI menu", () => {
	function makeMenuCtx(
		select: (title: string, items: string[]) => Promise<string | null>,
		notify: ReturnType<typeof vi.fn>,
	) {
		return {
			hasUI: true,
			ui: { hasUI: true, select, notify, theme: { fg: (_c: string, t: string) => t } },
			sessionManager: { getEntries: () => [] },
		};
	}

	it("opens the menu via ctx.ui.select and exits on Close", async () => {
		const { pi, handlers, commands } = makePi();
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, makeCtx());
		const select = vi.fn().mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await commands["s3-watcher"]!.handler("", makeMenuCtx(select, notify));
		expect(select).toHaveBeenCalledTimes(1);
		const [title, items] = select.mock.calls[0]! as [string, string[]];
		expect(title).toBe(MENU_TITLE);
		expect(items).toEqual([
			`${ITEM_BROWSE_PREFIX} (0)`,
			`${ITEM_PAUSED_PREFIX} off`,
			`${ITEM_DISPLAY_PREFIX} widget`,
			`${ITEM_USER_DEFAULT_PREFIX} unset`,
			ITEM_CLOSE,
		]);
	});

	it("ignores any args — menu always opens", async () => {
		const { pi, handlers, commands } = makePi();
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, makeCtx());
		const select = vi.fn().mockResolvedValueOnce(ITEM_CLOSE);
		await commands["s3-watcher"]!.handler("status", makeMenuCtx(select, vi.fn()));
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("Paused switch toggles rt.paused and re-renders", async () => {
		const { pi, handlers, commands } = makePi();
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, makeCtx());
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_PAUSED_PREFIX} off`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await commands["s3-watcher"]!.handler("", makeMenuCtx(select, notify));
		expect(select).toHaveBeenCalledTimes(2);
		expect((select.mock.calls[1]![1] as string[])[1]).toBe(`${ITEM_PAUSED_PREFIX} on`);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/s3-watcher: paused/),
			"info",
		);
	});

	it("Display mode switch toggles session display mode", async () => {
		const { pi, handlers, commands } = makePi();
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, makeCtx());
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_DISPLAY_PREFIX} widget`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await commands["s3-watcher"]!.handler("", makeMenuCtx(select, notify));
		expect((select.mock.calls[1]![1] as string[])[2]).toBe(
			`${ITEM_DISPLAY_PREFIX} statusline`,
		);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/session display → statusline/),
			"info",
		);
	});

	it("User default switch persists via saveConfig (unset to statusline)", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		vi.mocked(saveConfig).mockReturnValue(true);
		const { pi, handlers, commands } = makePi();
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, makeCtx());
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_USER_DEFAULT_PREFIX} unset`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await commands["s3-watcher"]!.handler("", makeMenuCtx(select, notify));
		expect(saveConfig).toHaveBeenCalledWith({ defaultDisplayMode: "statusline" });
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/user default → statusline/),
			"info",
		);
	});

	it("User default switch flips persisted statusline back to widget", async () => {
		vi.mocked(loadConfig).mockReturnValue({ defaultDisplayMode: "statusline" });
		vi.mocked(saveConfig).mockReturnValue(true);
		const { pi, handlers, commands } = makePi();
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, makeCtx());
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_USER_DEFAULT_PREFIX} statusline`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		await commands["s3-watcher"]!.handler("", makeMenuCtx(select, vi.fn()));
		expect(saveConfig).toHaveBeenCalledWith({ defaultDisplayMode: "widget" });
	});

	it("warns via notify when saveConfig fails", async () => {
		vi.mocked(saveConfig).mockReturnValue(false);
		const { pi, handlers, commands } = makePi();
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, makeCtx());
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_USER_DEFAULT_PREFIX} unset`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await commands["s3-watcher"]!.handler("", makeMenuCtx(select, notify));
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/failed to write user config/),
			"warning",
		);
	});

	it("warns and exits when ctx.ui.select is unavailable (no interactive UI)", async () => {
		const { pi, handlers, commands } = makePi();
		createExtensionWithClient(pi, makeClient());
		await handlers.sessionStart!({}, makeCtx());
		const notify = vi.fn();
		await commands["s3-watcher"]!.handler("", {
			hasUI: true,
			ui: { hasUI: true, notify },
		});
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/requires an interactive UI/),
			"warning",
		);
		expect(saveConfig).not.toHaveBeenCalled();
	});
});
