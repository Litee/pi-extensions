import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
	loadConfig: vi.fn(() => ({})),
	saveConfig: vi.fn(() => true),
	configFilePath: vi.fn(() => "/fake/agent/pi-aws-glue-watcher.json"),
}));

import { loadConfig, saveConfig } from "../src/config.js";
import type { GlueClient } from "../src/glue-client.js";
import {
	ITEM_BROWSE_PREFIX,
	ITEM_CLOSE,
	ITEM_DISPLAY_PREFIX,
	ITEM_PAUSED_PREFIX,
	ITEM_USER_DEFAULT_PREFIX,
	MENU_TITLE,
	runGlueWatcherCommand,
} from "../src/command.js";
import { makeRuntime, type Runtime } from "../src/runtime.js";
import { resetToolRegisteredForTests } from "../src/toolAction.js";

function makeFakePi() {
	return {
		registerTool: vi.fn(),
		getActiveTools: vi.fn(() => [] as string[]),
		setActiveTools: vi.fn(),
		appendEntry: vi.fn(),
		sendMessage: vi.fn(),
		events: { emit: vi.fn(), on: vi.fn() },
	} as unknown as Parameters<typeof runGlueWatcherCommand>[3];
}

function makeFakeClient(): GlueClient {
	return {
		getJobRun: vi.fn(() => ({}) as never),
		getWorkflowRun: vi.fn(() => ({}) as never),
		stopJobRun: vi.fn(() => {}),
		stopWorkflowRun: vi.fn(() => {}),
	} as unknown as GlueClient;
}

function freshRuntime(): Runtime {
	resetToolRegisteredForTests();
	const pi = makeFakePi();
	return makeRuntime(pi, makeFakeClient());
}

function makeMenuCtx(
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
		sessionManager: { getEntries: () => [] },
	};
}

describe("runGlueWatcherCommand — TUI menu", () => {
	it("opens the menu via ctx.ui.select and exits on Close", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		const select = vi.fn().mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		const pi = makeFakePi();
		await runGlueWatcherCommand(undefined, makeMenuCtx(select, notify), rt, pi, rt.client);
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
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		const select = vi.fn().mockResolvedValueOnce(ITEM_CLOSE);
		const pi = makeFakePi();
		await runGlueWatcherCommand("status", makeMenuCtx(select, vi.fn()), rt, pi, rt.client);
		expect(select).toHaveBeenCalledTimes(1);
	});

	it("exits on null choice (Esc cancels the menu)", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		const select = vi.fn().mockResolvedValueOnce(null);
		const pi = makeFakePi();
		await runGlueWatcherCommand(undefined, makeMenuCtx(select, vi.fn()), rt, pi, rt.client);
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
		const pi = makeFakePi();
		await runGlueWatcherCommand(undefined, makeMenuCtx(select, notify), rt, pi, rt.client);
		expect(select).toHaveBeenCalledTimes(2);
		expect(rt.paused).toBe(true);
		expect((select.mock.calls[1]![1] as string[])[1]).toBe(`${ITEM_PAUSED_PREFIX} on`);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/glue-watcher: paused/),
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
		const pi = makeFakePi();
		await runGlueWatcherCommand(undefined, makeMenuCtx(select, notify), rt, pi, rt.client);
		expect(rt.displayMode).toBe("statusline");
		expect((select.mock.calls[1]![1] as string[])[2]).toBe(`${ITEM_DISPLAY_PREFIX} statusline`);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/session display → statusline/),
			"info",
		);
	});

	it("User default switch persists via saveConfig (unset to statusline)", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		vi.mocked(saveConfig).mockReturnValue(true);
		const rt = freshRuntime();
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_USER_DEFAULT_PREFIX} unset`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		const pi = makeFakePi();
		await runGlueWatcherCommand(undefined, makeMenuCtx(select, notify), rt, pi, rt.client);
		expect(saveConfig).toHaveBeenCalledWith({ defaultDisplayMode: "statusline" });
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/user default → statusline/),
			"info",
		);
	});

	it("User default switch flips persisted statusline back to widget", async () => {
		vi.mocked(loadConfig).mockReturnValue({ defaultDisplayMode: "statusline" });
		vi.mocked(saveConfig).mockReturnValue(true);
		const rt = freshRuntime();
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_USER_DEFAULT_PREFIX} statusline`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const pi = makeFakePi();
		await runGlueWatcherCommand(undefined, makeMenuCtx(select, vi.fn()), rt, pi, rt.client);
		expect(saveConfig).toHaveBeenCalledWith({ defaultDisplayMode: "widget" });
	});

	it("warns via notify when saveConfig fails", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		vi.mocked(saveConfig).mockReturnValue(false);
		const rt = freshRuntime();
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_USER_DEFAULT_PREFIX} unset`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		const pi = makeFakePi();
		await runGlueWatcherCommand(undefined, makeMenuCtx(select, notify), rt, pi, rt.client);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/failed to write user config/),
			"warning",
		);
	});

	it("warns and exits when ctx.ui.select is unavailable", async () => {
		vi.mocked(saveConfig).mockClear();
		const rt = freshRuntime();
		const notify = vi.fn();
		const pi = makeFakePi();
		await runGlueWatcherCommand(
			undefined,
			{ hasUI: true, ui: { hasUI: true, notify } },
			rt,
			pi,
			rt.client,
		);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/requires an interactive UI/),
			"warning",
		);
		expect(saveConfig).not.toHaveBeenCalled();
	});

	it("Browse opens the watches overlay via ctx.ui.custom", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		const custom = vi.fn(() => undefined);
		const select = vi
			.fn()
			.mockResolvedValueOnce(`${ITEM_BROWSE_PREFIX} (0)`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const ctx = {
			hasUI: true,
			ui: {
				hasUI: true,
				select,
				notify: vi.fn(),
				custom,
				theme: { fg: (_c: string, t: string) => t },
			},
			sessionManager: { getEntries: () => [] },
		};
		const pi = makeFakePi();
		await runGlueWatcherCommand(undefined, ctx, rt, pi, rt.client);
		expect(custom).toHaveBeenCalledTimes(1);
		const optionsArg = (custom.mock.calls as unknown as unknown[][])[0]?.[1];
		expect(optionsArg).toMatchObject({ overlay: true });
	});

	it("tolerates a headless ctx without throwing", async () => {
		const rt = freshRuntime();
		const headlessCtx = { hasUI: false, ui: null };
		const pi = makeFakePi();
		await expect(
			runGlueWatcherCommand(undefined, headlessCtx, rt, pi, rt.client),
		).resolves.not.toThrow();
	});
});
