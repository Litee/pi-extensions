import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
	loadConfig: vi.fn(() => ({})),
	saveConfig: vi.fn(() => true),
	configFilePath: vi.fn(() => "/fake/agent/pi-aws-glue-watcher.json"),
}));

// Capture WatchesView constructor args so we can invoke the callbacks
let capturedWatchesViewArgs: unknown[] | null = null;
vi.mock("../src/ui/watches-view.js", () => ({
	WatchesView: class MockWatchesView {
		constructor(...args: unknown[]) {
			capturedWatchesViewArgs = args;
		}
	},
}));

import { loadConfig, saveConfig } from "../src/config.js";
import type { GlueClient } from "../src/glue-client.js";
import {
	ITEM_BROWSE_PREFIX,
	ITEM_CLOSE,
	ITEM_DISPLAY_PREFIX,
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
		expect((select.mock.calls[1]![1] as string[])[1]).toBe(`${ITEM_DISPLAY_PREFIX} statusline`);
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
		// The function returns early without opening any menu or modifying runtime state.
		expect(rt.displayMode).toBe("widget");
	});
});

	it("Browse factory invokes inner callbacks when called with mock arguments", async () => {
		capturedWatchesViewArgs = null; // reset
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		// Add a job watch and a workflow watch to test stop callbacks
		rt.watches["job1"] = {
			watchId: "job1", type: "job", name: "my-job", runId: "jr_1",
			profile: "p", region: undefined, addedAt: Date.now(),
			lastPolledAt: undefined, baseline: undefined, terminal: false, consecutiveErrors: 0,
		};
		rt.watches["wf1"] = {
			watchId: "wf1", type: "workflow", name: "my-wf", runId: "wr_1",
			profile: "p", region: undefined, addedAt: Date.now(),
			lastPolledAt: undefined, baseline: undefined, terminal: false, consecutiveErrors: 0,
		};

		let capturedFactory: ((tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => unknown) | undefined;
		const custom = vi.fn((factory: typeof capturedFactory) => {
			capturedFactory = factory;
		});
		const select = vi.fn()
			.mockResolvedValueOnce(`${ITEM_BROWSE_PREFIX} (2)`)
			.mockResolvedValueOnce(ITEM_CLOSE);

		const ctx = {
			hasUI: true,
			ui: { hasUI: true, select, notify: vi.fn(), custom, theme: { fg: (_c: string, t: string) => t } },
			sessionManager: { getEntries: () => [] },
		};
		const pi = makeFakePi();

		const commandPromise = runGlueWatcherCommand(undefined, ctx, rt, pi, rt.client);
		await new Promise(resolve => setTimeout(resolve, 0));

		// Invoke factory to exercise the lambda callbacks
		if (capturedFactory) {
			const mockTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
			const mockTui = { terminal: { columns: 80 }, requestRender: vi.fn() };
			const done = vi.fn();
			capturedFactory(mockTui, mockTheme, {}, done);

			// If WatchesView was constructed, call its captured callbacks
			if (capturedWatchesViewArgs) {
				const args = capturedWatchesViewArgs as unknown[];
				// arg[2] = requestRender (already bound from factory)
				// arg[3] = onClose () => done(undefined)
				// arg[4] = onStop async (row) => {...}
				// arg[5] = onDelete (watchId) => {...}
				// arg[6] = getMinIntervalMs () => minIntervalMs(rt)
				// arg[7] = toggleDisplayMode () => toggleDisplayMode(rt, ctx)
				// arg[8] = getDisplayMode () => rt.displayMode
				const onStop = args[4] as (row: { watchId: string }) => Promise<void>;
				const onDelete = args[5] as (watchId: string) => void;
				const getMinIntervalMs = args[6] as () => number;
				const toggleDisplayModeFn = args[7] as () => void;
				const getDisplayMode = args[8] as () => string;

				// Call getMinIntervalMs and getDisplayMode
				getMinIntervalMs();
				getDisplayMode();
				toggleDisplayModeFn();

				// Call onStop for job (exercises job path)
				await onStop({ watchId: "job1" });
				// Call onStop for workflow (exercises workflow path)
				await onStop({ watchId: "wf1" });
				// Call onStop with missing watch (no-op path)
				await onStop({ watchId: "no-such" });
				// Call onDelete
				onDelete("job1");
			}

			done(undefined);
		}

		await commandPromise;
	});


	it("Browse warns when ctx.ui.custom is unavailable", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		const notify = vi.fn();
		const select = vi.fn()
			.mockResolvedValueOnce(`${ITEM_BROWSE_PREFIX} (0)`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const ctx = {
			hasUI: true,
			ui: { hasUI: true, select, notify, theme: { fg: (_c: string, t: string) => t } },
			sessionManager: { getEntries: () => [] },
		};
		const pi = makeFakePi();
		await runGlueWatcherCommand(undefined, ctx, rt, pi, rt.client);
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/browse requires/), "warning");
	});
