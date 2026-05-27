/**
 * Tests for command.ts — runFsWatcherCommand TUI menu.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
	loadConfig: vi.fn(() => ({})),
	saveConfig: vi.fn(() => true),
	configFilePath: vi.fn(() => "/fake/agent/pi-file-system-watcher.json"),
}));

import { loadConfig, saveConfig } from "../src/config.js";
import {
	ITEM_BROWSE_PREFIX,
	ITEM_CLOSE,
	ITEM_DISPLAY_PREFIX,
	ITEM_PAUSED_PREFIX,
	ITEM_USER_DEFAULT_PREFIX,
	MENU_TITLE,
	runFsWatcherCommand,
} from "../src/command.js";
import { makeRuntime, type Runtime } from "../src/runtime.js";
import type { FsWatch } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePi() {
	return {
		registerTool: vi.fn(),
		getActiveTools: vi.fn(() => [] as string[]),
		setActiveTools: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		events: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
	} as unknown as Runtime["pi"];
}

function freshRuntime(): Runtime {
	const pi = makePi();
	const rt = makeRuntime(pi, vi.fn().mockResolvedValue({ exists: false }));
	rt.now = () => 1_000;
	return rt;
}

function makeCtx(
	select: (title: string, items: string[]) => Promise<string | null>,
	notify: ReturnType<typeof vi.fn>,
) {
	return {
		hasUI: true,
		ui: {
			hasUI: true,
			select,
			notify,
			theme: { fg: (_c: string, t: string) => t },
		},
	};
}

function makeWatch(overrides: Partial<FsWatch> = {}): FsWatch {
	return {
		watchId: "w1",
		path: "/tmp/test.txt",
		target: "exists",
		mode: "poll",
		timeoutAt: undefined,
		addedAt: 0,
		lastPolledAt: undefined,
		baseline: undefined,
		terminal: false,
		consecutiveErrors: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// No UI / headless paths
// ---------------------------------------------------------------------------

describe("runFsWatcherCommand — no UI", () => {
	it("warns and exits when ctx.ui.select is unavailable", async () => {
		const rt = freshRuntime();
		const notify = vi.fn();
		await runFsWatcherCommand(
			undefined,
			{ hasUI: true, ui: { hasUI: true, notify } },
			rt,
		);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/requires an interactive UI/),
			"warning",
		);
	});

	it("tolerates a fully headless ctx without throwing", async () => {
		const rt = freshRuntime();
		await expect(
			runFsWatcherCommand(undefined, { hasUI: false, ui: null }, rt),
		).resolves.not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// Menu structure
// ---------------------------------------------------------------------------

describe("runFsWatcherCommand — menu items", () => {
	it("opens menu with correct items when no watches", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		const select = vi.fn().mockResolvedValueOnce(ITEM_CLOSE);
		await runFsWatcherCommand(undefined, makeCtx(select, vi.fn()), rt);
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

	it("shows watch count next to Browse", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		rt.watches = { w1: makeWatch({ watchId: "w1" }) };
		const select = vi.fn().mockResolvedValueOnce(ITEM_CLOSE);
		await runFsWatcherCommand(undefined, makeCtx(select, vi.fn()), rt);
		const items = select.mock.calls[0]![1] as string[];
		expect(items[0]).toBe(`${ITEM_BROWSE_PREFIX} (1)`);
	});

	it("exits on null choice (Esc)", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		const select = vi.fn().mockResolvedValueOnce(null);
		await runFsWatcherCommand(undefined, makeCtx(select, vi.fn()), rt);
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("reflects persisted user default display mode in label", async () => {
		vi.mocked(loadConfig).mockReturnValue({ defaultDisplayMode: "statusline" });
		const rt = freshRuntime();
		const select = vi.fn().mockResolvedValueOnce(ITEM_CLOSE);
		await runFsWatcherCommand(undefined, makeCtx(select, vi.fn()), rt);
		const items = select.mock.calls[0]![1] as string[];
		expect(items[3]).toBe(`${ITEM_USER_DEFAULT_PREFIX} statusline`);
	});
});

// ---------------------------------------------------------------------------
// Browse watches
// ---------------------------------------------------------------------------

describe("runFsWatcherCommand — Browse", () => {
	it("notifies 'no watches configured' when watch list is empty", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_BROWSE_PREFIX} (0)`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await runFsWatcherCommand(undefined, makeCtx(select, notify), rt);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/no watches configured/),
			"info",
		);
	});

	it("notifies watch list with paths when watches exist", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		rt.watches = { w1: makeWatch({ path: "/tmp/watched.txt", baseline: { exists: false } }) };
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_BROWSE_PREFIX} (1)`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await runFsWatcherCommand(undefined, makeCtx(select, notify), rt);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/\/tmp\/watched\.txt/),
			"info",
		);
	});

	it("shows state=present when baseline.exists is true", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		rt.watches = {
			w1: makeWatch({ baseline: { exists: true, mtimeNs: 1000n, size: 10 } }),
		};
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_BROWSE_PREFIX} (1)`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await runFsWatcherCommand(undefined, makeCtx(select, notify), rt);
		expect(notify.mock.calls[0]![0]).toMatch(/state=present/);
	});

	it("shows state=absent when baseline.exists is false", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		rt.watches = { w1: makeWatch({ baseline: { exists: false } }) };
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_BROWSE_PREFIX} (1)`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await runFsWatcherCommand(undefined, makeCtx(select, notify), rt);
		expect(notify.mock.calls[0]![0]).toMatch(/state=absent/);
	});

	it("shows state=? when baseline is undefined", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		rt.watches = { w1: makeWatch({ baseline: undefined }) };
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_BROWSE_PREFIX} (1)`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await runFsWatcherCommand(undefined, makeCtx(select, notify), rt);
		expect(notify.mock.calls[0]![0]).toMatch(/state=\?/);
	});

	it("appends [done] marker for terminal watches", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		rt.watches = {
			w1: makeWatch({ terminal: true, baseline: { exists: true, mtimeNs: 1000n, size: 0 } }),
		};
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_BROWSE_PREFIX} (1)`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await runFsWatcherCommand(undefined, makeCtx(select, notify), rt);
		expect(notify.mock.calls[0]![0]).toMatch(/\[done\]/);
	});
});

// ---------------------------------------------------------------------------
// Pause / Resume toggle
// ---------------------------------------------------------------------------

describe("runFsWatcherCommand — Pause/Resume toggle", () => {
	it("pauses (off→on): sets rt.paused=true, re-renders label, notifies", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		expect(rt.paused).toBe(false);
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_PAUSED_PREFIX} off`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await runFsWatcherCommand(undefined, makeCtx(select, notify), rt);
		expect(rt.paused).toBe(true);
		const secondItems = select.mock.calls[1]![1] as string[];
		expect(secondItems[1]).toBe(`${ITEM_PAUSED_PREFIX} on`);
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/paused/), "info");
	});

	it("resumes (on→off): does not start polling when no active watches", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		rt.paused = true;
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_PAUSED_PREFIX} on`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await runFsWatcherCommand(undefined, makeCtx(select, notify), rt);
		expect(rt.paused).toBe(false);
		expect(rt.scheduler.isRunning).toBe(false);
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/resumed/), "info");
	});

	it("resumes and starts polling when active watches exist", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		rt.paused = true;
		rt.watches = { w1: makeWatch({ terminal: false }) };
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_PAUSED_PREFIX} on`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		await runFsWatcherCommand(undefined, makeCtx(select, vi.fn()), rt);
		expect(rt.paused).toBe(false);
		expect(rt.scheduler.isRunning).toBe(true);
		rt.scheduler.stop();
	});

	it("resumes but skips startPolling when scheduler is already running", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		rt.paused = true;
		rt.watches = { w1: makeWatch({ terminal: false }) };
		rt.scheduler.start(() => Promise.resolve()); // already running
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_PAUSED_PREFIX} on`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		await runFsWatcherCommand(undefined, makeCtx(select, vi.fn()), rt);
		expect(rt.paused).toBe(false);
		expect(rt.scheduler.isRunning).toBe(true);
		rt.scheduler.stop();
	});
});

// ---------------------------------------------------------------------------
// Display mode toggle
// ---------------------------------------------------------------------------

describe("runFsWatcherCommand — Display mode toggle", () => {
	it("toggles widget → statusline", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		rt.displayMode = "widget";
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_DISPLAY_PREFIX} widget`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await runFsWatcherCommand(undefined, makeCtx(select, notify), rt);
		expect(rt.displayMode).toBe("statusline");
		const secondItems = select.mock.calls[1]![1] as string[];
		expect(secondItems[2]).toBe(`${ITEM_DISPLAY_PREFIX} statusline`);
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/statusline/), "info");
	});

	it("toggles statusline → widget", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		rt.displayMode = "statusline";
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_DISPLAY_PREFIX} statusline`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		await runFsWatcherCommand(undefined, makeCtx(select, vi.fn()), rt);
		expect(rt.displayMode).toBe("widget");
	});
});

// ---------------------------------------------------------------------------
// User default display mode
// ---------------------------------------------------------------------------

describe("runFsWatcherCommand — User default display mode", () => {
	it("cycles unset → statusline (widget is the default for unset)", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		vi.mocked(saveConfig).mockReturnValue(true);
		const rt = freshRuntime();
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_USER_DEFAULT_PREFIX} unset`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await runFsWatcherCommand(undefined, makeCtx(select, notify), rt);
		expect(saveConfig).toHaveBeenCalledWith({ defaultDisplayMode: "statusline" });
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/user default.*statusline/i),
			"info",
		);
	});

	it("cycles widget → statusline", async () => {
		vi.mocked(loadConfig).mockReturnValue({ defaultDisplayMode: "widget" });
		vi.mocked(saveConfig).mockReturnValue(true);
		const rt = freshRuntime();
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_USER_DEFAULT_PREFIX} widget`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		await runFsWatcherCommand(undefined, makeCtx(select, vi.fn()), rt);
		expect(saveConfig).toHaveBeenCalledWith({ defaultDisplayMode: "statusline" });
	});

	it("cycles statusline → widget", async () => {
		vi.mocked(loadConfig).mockReturnValue({ defaultDisplayMode: "statusline" });
		vi.mocked(saveConfig).mockReturnValue(true);
		const rt = freshRuntime();
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_USER_DEFAULT_PREFIX} statusline`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		await runFsWatcherCommand(undefined, makeCtx(select, vi.fn()), rt);
		expect(saveConfig).toHaveBeenCalledWith({ defaultDisplayMode: "widget" });
	});

	it("warns when saveConfig fails", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		vi.mocked(saveConfig).mockReturnValue(false);
		const rt = freshRuntime();
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_USER_DEFAULT_PREFIX} unset`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await runFsWatcherCommand(undefined, makeCtx(select, notify), rt);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/failed to write/),
			"warning",
		);
	});
});
