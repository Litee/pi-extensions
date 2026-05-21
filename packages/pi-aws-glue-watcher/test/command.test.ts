import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
	loadConfig: vi.fn(() => ({})),
	saveConfig: vi.fn(() => true),
	configFilePath: vi.fn(() => "/fake/agent/pi-aws-glue-watcher.json"),
}));

import { loadConfig, saveConfig } from "../src/config.js";
import type { GlueClient } from "../src/glue-client.js";
import {
	parseSubcommand,
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

function makeCtxWithUi(overrides: Partial<Record<string, unknown>> = {}): unknown {
	return {
		hasUI: true,
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			theme: { fg: vi.fn((_c: string, t: string) => t) },
			custom: vi.fn(() => undefined),
			...overrides,
		},
	};
}

describe("parseSubcommand", () => {
	it.each([
		["browse", { kind: "browse" }],
		["status", { kind: "status" }],
		["settings", { kind: "settings" }],
		["", { kind: "browse" }],
		["   ", { kind: "browse" }],
	] as const)("maps %j to %j", (input, expected) => {
		expect(parseSubcommand(input)).toEqual(expected);
	});

	it("is case-insensitive", () => {
		expect(parseSubcommand("  StAtUs  ")).toEqual({ kind: "status" });
		expect(parseSubcommand("BROWSE")).toEqual({ kind: "browse" });
	});

	it("returns unknown for unrecognised subcommands preserving the raw form", () => {
		expect(parseSubcommand("pause-now")).toEqual({ kind: "unknown", raw: "pause-now" });
	});

	it("returns unknown for the old 'jobs' subcommand name (no backwards-compat alias)", () => {
		expect(parseSubcommand("jobs")).toEqual({ kind: "unknown", raw: "jobs" });
	});

	it("returns unknown for removed 'enable' subcommand", () => {
		expect(parseSubcommand("enable")).toEqual({ kind: "unknown", raw: "enable" });
	});

	it("returns unknown for removed 'disable' subcommand", () => {
		expect(parseSubcommand("disable")).toEqual({ kind: "unknown", raw: "disable" });
	});

	it("returns browse when called with undefined (no args)", () => {
		expect(parseSubcommand(undefined)).toEqual({ kind: "browse" });
	});
});

describe("runGlueWatcherCommand", () => {
	function freshRuntime(): Runtime {
		resetToolRegisteredForTests();
		const pi = makeFakePi();
		// `pi` here is used both as the full ExtensionAPI and as the narrower
		// Runtime["pi"] subset. Casts are constrained by the Runtime type.
		return makeRuntime(pi, makeFakeClient());
	}

	it("status: reports active and the watch count", async () => {
		// Arrange
		const rt = freshRuntime();
		rt.enabled = true;
		rt.watches = {
			a: { terminal: false } as unknown as Runtime["watches"][string],
			b: { terminal: true } as unknown as Runtime["watches"][string],
		};
		const ctx = makeCtxWithUi();
		const pi = makeFakePi();

		// Act
		await runGlueWatcherCommand("status", ctx, rt, pi, rt.client);

		// Assert
		const notify = (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify;
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/active.*2 watch\(es\) \(1 active\)/),
			"info",
		);
	});

	it("status: reflects the paused flag", async () => {
		// Arrange
		const rt = freshRuntime();
		rt.enabled = true;
		rt.paused = true;
		const ctx = makeCtxWithUi();
		const pi = makeFakePi();

		// Act
		await runGlueWatcherCommand("status", ctx, rt, pi, rt.client);

		// Assert
		const notify = (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify;
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/paused/), "info");
	});

	it("unknown: warns with the raw subcommand", async () => {
		// Arrange
		const rt = freshRuntime();
		const ctx = makeCtxWithUi();
		const pi = makeFakePi();

		// Act
		await runGlueWatcherCommand("frobnicate", ctx, rt, pi, rt.client);

		// Assert
		const notify = (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify;
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/unknown subcommand 'frobnicate'/),
			"warning",
		);
	});

	it("browse: invokes ctx.ui.custom to open the watches overlay", async () => {
		// Arrange
		const rt = freshRuntime();
		const custom = vi.fn(() => undefined);
		const ctx = makeCtxWithUi({ custom });
		const pi = makeFakePi();

		// Act
		await runGlueWatcherCommand("browse", ctx, rt, pi, rt.client);

		// Assert
		expect(custom).toHaveBeenCalledTimes(1);
		const optionsArg = (custom.mock.calls as unknown as unknown[][])[0]?.[1];
		expect(optionsArg).toMatchObject({ overlay: true });
	});

	it("tolerates missing ui.notify on unknown subcommand (no-UI context)", async () => {
		// Arrange — headless ctx with no `ui` surface.
		const rt = freshRuntime();
		const headlessCtx = { hasUI: false, ui: null };
		const pi = makeFakePi();

		// Act / Assert — must not throw.
		await expect(runGlueWatcherCommand("enable", headlessCtx, rt, pi, rt.client)).resolves.not.toThrow();
		await expect(runGlueWatcherCommand("disable", headlessCtx, rt, pi, rt.client)).resolves.not.toThrow();
	});
});

describe("runGlueWatcherCommand — settings TUI", () => {
	function freshRuntime(): Runtime {
		resetToolRegisteredForTests();
		const pi = makeFakePi();
		return makeRuntime(pi, makeFakeClient());
	}

	function makeSettingsCtx(
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

	it("opens an interactive menu via ctx.ui.select and exits on 'Back'", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		const select = vi.fn().mockResolvedValueOnce("Back");
		const notify = vi.fn();
		const pi = makeFakePi();
		await runGlueWatcherCommand(
			"settings",
			makeSettingsCtx(select, notify),
			rt,
			pi,
			rt.client,
		);
		expect(select).toHaveBeenCalledTimes(1);
		const [title, items] = select.mock.calls[0]! as [string, string[]];
		expect(title).toBe("glue-watcher settings");
		expect(items).toEqual([
			"Session display mode: widget",
			"User default display mode: (unset — falls back to widget)",
			"Back",
		]);
	});

	it("toggles session display mode and re-renders the menu", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		const rt = freshRuntime();
		rt.displayMode = "widget";
		const select = vi
			.fn()
			.mockResolvedValueOnce("Session display mode: widget")
			.mockResolvedValueOnce("Back");
		const notify = vi.fn();
		const pi = makeFakePi();
		await runGlueWatcherCommand(
			"settings",
			makeSettingsCtx(select, notify),
			rt,
			pi,
			rt.client,
		);
		expect(select).toHaveBeenCalledTimes(2);
		expect((select.mock.calls[1]![1] as string[])[0]).toBe(
			"Session display mode: statusline",
		);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/session display → statusline/),
			"info",
		);
	});

	it("persists user default to ~/.pi/agent/pi-aws-glue-watcher.json via saveConfig", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		vi.mocked(saveConfig).mockReturnValue(true);
		const rt = freshRuntime();
		const select = vi
			.fn()
			.mockResolvedValueOnce(
				"User default display mode: (unset — falls back to widget)",
			)
			.mockResolvedValueOnce("Back");
		const notify = vi.fn();
		const pi = makeFakePi();
		await runGlueWatcherCommand(
			"settings",
			makeSettingsCtx(select, notify),
			rt,
			pi,
			rt.client,
		);
		expect(saveConfig).toHaveBeenCalledWith({ defaultDisplayMode: "statusline" });
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/user default → statusline/),
			"info",
		);
	});

	it("toggles user default away from a persisted statusline back to widget", async () => {
		vi.mocked(loadConfig).mockReturnValue({ defaultDisplayMode: "statusline" });
		vi.mocked(saveConfig).mockReturnValue(true);
		const rt = freshRuntime();
		const select = vi
			.fn()
			.mockResolvedValueOnce("User default display mode: statusline")
			.mockResolvedValueOnce("Back");
		const pi = makeFakePi();
		await runGlueWatcherCommand(
			"settings",
			makeSettingsCtx(select, vi.fn()),
			rt,
			pi,
			rt.client,
		);
		expect(saveConfig).toHaveBeenCalledWith({ defaultDisplayMode: "widget" });
	});

	it("warns via notify when saveConfig fails (IO error)", async () => {
		vi.mocked(loadConfig).mockReturnValue({});
		vi.mocked(saveConfig).mockReturnValue(false);
		const rt = freshRuntime();
		const select = vi
			.fn()
			.mockResolvedValueOnce(
				"User default display mode: (unset — falls back to widget)",
			)
			.mockResolvedValueOnce("Back");
		const notify = vi.fn();
		const pi = makeFakePi();
		await runGlueWatcherCommand(
			"settings",
			makeSettingsCtx(select, notify),
			rt,
			pi,
			rt.client,
		);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/failed to write user config/),
			"warning",
		);
	});

	it("warns and exits when ctx.ui.select is unavailable (no interactive UI)", async () => {
		vi.mocked(saveConfig).mockClear();
		const rt = freshRuntime();
		const notify = vi.fn();
		const pi = makeFakePi();
		await runGlueWatcherCommand(
			"settings",
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
});
