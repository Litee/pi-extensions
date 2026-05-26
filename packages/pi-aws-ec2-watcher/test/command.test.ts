import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
	loadConfig: vi.fn(() => ({})),
	saveConfig: vi.fn(() => true),
	configFilePath: vi.fn(() => "/fake/agent/pi-aws-ec2-watcher.json"),
}));

import { loadConfig, saveConfig } from "../src/config.js";
import {
	ITEM_BROWSE_PREFIX,
	ITEM_CLOSE,
	ITEM_DISPLAY_PREFIX,
	ITEM_PAUSED_PREFIX,
	ITEM_USER_DEFAULT_PREFIX,
	MENU_TITLE,
	runEc2WatcherCommand,
} from "../src/command.js";
import { makeRuntime, type Runtime } from "../src/runtime.js";
import type { Ec2Client } from "../src/ec2-client.js";

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

function makeFakeClient(): Ec2Client {
	return {
		describeInstance: vi.fn(() => Promise.resolve({ state: "running" as const })),
		stopInstance: vi.fn().mockResolvedValue(undefined),
		startInstance: vi.fn().mockResolvedValue(undefined),
	};
}

function freshRuntime(): Runtime {
	return makeRuntime(makeFakePi(), makeFakeClient());
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

describe("runEc2WatcherCommand — TUI menu", () => {
	it("opens the menu and lists Browse + Paused + Display + UserDefault + Close", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		const select = vi.fn().mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await runEc2WatcherCommand(undefined, makeMenuCtx(select, notify), rt);
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

	it("returns early when no UI select is available", async () => {
		const rt = freshRuntime();
		const ctx = {
			hasUI: false,
			sessionManager: { getEntries: () => [] },
		};
		// Should not throw
		await expect(runEc2WatcherCommand(undefined, ctx, rt)).resolves.toBeUndefined();
	});

	it("toggles paused on selecting Paused item", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		const select = vi.fn()
			.mockResolvedValueOnce(`${ITEM_PAUSED_PREFIX} off`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await runEc2WatcherCommand(undefined, makeMenuCtx(select, notify), rt);
		expect(rt.paused).toBe(true);
	});

	it("toggles display mode on selecting Display item", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		const select = vi.fn()
			.mockResolvedValueOnce(`${ITEM_DISPLAY_PREFIX} widget`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await runEc2WatcherCommand(undefined, makeMenuCtx(select, notify), rt);
		expect(rt.displayMode).toBe("statusline");
	});

	it("saves user default display mode when selected", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		vi.mocked(saveConfig).mockReturnValue(true);
		const rt = freshRuntime();
		const select = vi.fn()
			.mockResolvedValueOnce(`${ITEM_USER_DEFAULT_PREFIX} unset`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await runEc2WatcherCommand(undefined, makeMenuCtx(select, notify), rt);
		expect(saveConfig).toHaveBeenCalledWith({ defaultDisplayMode: "statusline" });
	});

	it("notifies error when saveConfig fails", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		vi.mocked(saveConfig).mockReturnValue(false);
		const rt = freshRuntime();
		const select = vi.fn()
			.mockResolvedValueOnce(`${ITEM_USER_DEFAULT_PREFIX} unset`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await runEc2WatcherCommand(undefined, makeMenuCtx(select, notify), rt);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/failed/i),
			"warning",
		);
	});

	it("opens browse view when Browse item is selected", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		const custom = vi.fn().mockResolvedValue(undefined);
		const select = vi.fn()
			.mockResolvedValueOnce(`${ITEM_BROWSE_PREFIX} (0)`)
			.mockResolvedValueOnce(ITEM_CLOSE);
		const notify = vi.fn();
		await runEc2WatcherCommand(undefined, makeMenuCtx(select, notify, custom), rt);
		expect(custom).toHaveBeenCalledTimes(1);
	});
});
