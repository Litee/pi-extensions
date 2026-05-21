import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
	loadConfig: vi.fn(() => ({})),
	saveConfig: vi.fn(() => true),
	configFilePath: vi.fn(() => "/fake/agent/pi-aws-s3-watcher.json"),
}));

import { loadConfig, saveConfig } from "../src/config.js";
import {
	ITEM_BROWSE_PREFIX,
	ITEM_CLOSE,
	ITEM_DISPLAY_PREFIX,
	ITEM_PAUSED_PREFIX,
	ITEM_USER_DEFAULT_PREFIX,
	MENU_TITLE,
	runS3WatcherCommand,
} from "../src/command.js";
import { makeRuntime, type Runtime } from "../src/runtime.js";
import type { S3Client } from "../src/s3-client.js";

function makeFakePi() {
	return {
		registerTool: vi.fn(),
		getActiveTools: vi.fn(() => [] as string[]),
		setActiveTools: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		events: { emit: vi.fn(), on: vi.fn() },
	} as unknown as Runtime["pi"];
}

function makeFakeClient(): S3Client {
	return {
		headObject: vi.fn(() => Promise.resolve({ exists: false })),
	};
}

function freshRuntime(): Runtime {
	const pi = makeFakePi();
	return makeRuntime(pi, makeFakeClient());
}

function makeMenuCtx(
	select: (title: string, items: string[]) => Promise<string | null>,
	notify: ReturnType<typeof vi.fn>,
	custom?: ReturnType<typeof vi.fn>,
) {
	return {
		hasUI: true,
		ui: {
			hasUI: true,
			select,
			notify,
			...(custom ? { custom } : {}),
			theme: { fg: (_c: string, t: string) => t },
		},
		sessionManager: { getEntries: () => [] },
	};
}

describe("runS3WatcherCommand — TUI menu", () => {
	it("opens the menu and lists Browse + Paused + Display + UserDefault + Close", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		const select = vi.fn().mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await runS3WatcherCommand(undefined, makeMenuCtx(select, notify), rt);
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

	it("shows the watch count next to Browse", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		rt.watches = {
			a: {
				watchId: "a",
				bucket: "b",
				key: "k",
				profile: "p",
				region: undefined,
				target: "exists",
				timeoutAt: undefined,
				addedAt: 1,
				lastPolledAt: undefined,
				baseline: undefined,
				terminal: false,
				consecutiveErrors: 0,
			},
		};
		const select = vi.fn().mockResolvedValueOnce(ITEM_CLOSE);
		await runS3WatcherCommand(undefined, makeMenuCtx(select, vi.fn()), rt);
		const items = select.mock.calls[0]![1] as string[];
		expect(items[0]).toBe(`${ITEM_BROWSE_PREFIX} (1)`);
	});

	it("ignores any args — menu always opens", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		const select = vi.fn().mockResolvedValueOnce(ITEM_CLOSE);
		await runS3WatcherCommand("status", makeMenuCtx(select, vi.fn()), rt);
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("exits on null choice (Esc cancels the menu)", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		const select = vi.fn().mockResolvedValueOnce(null);
		await runS3WatcherCommand(undefined, makeMenuCtx(select, vi.fn()), rt);
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("Paused switch toggles rt.paused and re-renders", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		expect(rt.paused).toBe(false);
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_PAUSED_PREFIX} off`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await runS3WatcherCommand(undefined, makeMenuCtx(select, notify), rt);
		expect(rt.paused).toBe(true);
		expect((select.mock.calls[1]![1] as string[])[1]).toBe(`${ITEM_PAUSED_PREFIX} on`);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/s3-watcher: paused/),
			"info",
		);
	});

	it("Display mode switch toggles session display mode", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		rt.displayMode = "widget";
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_DISPLAY_PREFIX} widget`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await runS3WatcherCommand(undefined, makeMenuCtx(select, notify), rt);
		expect(rt.displayMode).toBe("statusline");
		expect((select.mock.calls[1]![1] as string[])[2]).toBe(`${ITEM_DISPLAY_PREFIX} statusline`);
	});

	it("User default switch persists via saveConfig (unset → statusline)", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		vi.mocked(saveConfig).mockReturnValue(true);
		const rt = freshRuntime();
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_USER_DEFAULT_PREFIX} unset`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		await runS3WatcherCommand(undefined, makeMenuCtx(select, vi.fn()), rt);
		expect(saveConfig).toHaveBeenCalledWith({ defaultDisplayMode: "statusline" });
	});

	it("warns and exits when ctx.ui.select is unavailable", async () => {
		const rt = freshRuntime();
		const notify = vi.fn();
		await runS3WatcherCommand(
			undefined,
			{ hasUI: true, ui: { hasUI: true, notify } },
			rt,
		);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/requires an interactive UI/),
			"warning",
		);
	});

	it("Browse opens the watches overlay via ctx.ui.custom", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		const custom = vi.fn(() => undefined);
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_BROWSE_PREFIX} (0)`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		await runS3WatcherCommand(undefined, makeMenuCtx(select, vi.fn(), custom), rt);
		expect(custom).toHaveBeenCalledTimes(1);
		const optionsArg = (custom.mock.calls as unknown as unknown[][])[0]?.[1];
		expect(optionsArg).toMatchObject({ overlay: true });
	});

	it("Browse warns when ctx.ui.custom is unavailable", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_BROWSE_PREFIX} (0)`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		// no custom in ctx
		await runS3WatcherCommand(undefined, makeMenuCtx(select, notify), rt);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/browse requires an interactive UI/),
			"warning",
		);
	});

	it("tolerates a headless ctx without throwing", async () => {
		const rt = freshRuntime();
		await expect(
			runS3WatcherCommand(undefined, { hasUI: false, ui: null }, rt),
		).resolves.not.toThrow();
	});
});
