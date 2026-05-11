import { describe, expect, it, vi } from "vitest";

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
		["enable", { kind: "enable" }],
		["disable", { kind: "disable" }],
		["jobs", { kind: "jobs" }],
		["status", { kind: "status" }],
		["", { kind: "jobs" }],
		["   ", { kind: "jobs" }],
	] as const)("maps %j to %j", (input, expected) => {
		expect(parseSubcommand(input)).toEqual(expected);
	});

	it("is case-insensitive", () => {
		expect(parseSubcommand("ENABLE")).toEqual({ kind: "enable" });
		expect(parseSubcommand("  StAtUs  ")).toEqual({ kind: "status" });
	});

	it("returns unknown for unrecognised subcommands preserving the raw form", () => {
		expect(parseSubcommand("pause-now")).toEqual({ kind: "unknown", raw: "pause-now" });
	});

	it("returns jobs when called with undefined (no args)", () => {
		expect(parseSubcommand(undefined)).toEqual({ kind: "jobs" });
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

	it("enable: flips rt.enabled and notifies", async () => {
		// Arrange
		const rt = freshRuntime();
		const ctx = makeCtxWithUi();
		const pi = makeFakePi();

		// Act
		await runGlueWatcherCommand("enable", ctx, rt, pi, rt.client);

		// Assert
		expect(rt.enabled).toBe(true);
		const notify = (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify;
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/enabled/), "info");
	});

	it("enable: is idempotent when already enabled", async () => {
		// Arrange
		const rt = freshRuntime();
		rt.enabled = true;
		const ctx = makeCtxWithUi();
		const pi = makeFakePi();

		// Act
		await runGlueWatcherCommand("enable", ctx, rt, pi, rt.client);

		// Assert
		const notify = (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify;
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/already enabled/), "info");
		expect(rt.enabled).toBe(true);
	});

	it("disable: flips rt.enabled to false when enabled", async () => {
		// Arrange
		const rt = freshRuntime();
		rt.enabled = true;
		const ctx = makeCtxWithUi();
		const pi = makeFakePi();

		// Act
		await runGlueWatcherCommand("disable", ctx, rt, pi, rt.client);

		// Assert
		expect(rt.enabled).toBe(false);
		const notify = (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify;
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/disabled/), "info");
	});

	it("disable: is idempotent when already disabled", async () => {
		// Arrange
		const rt = freshRuntime();
		rt.enabled = false;
		const ctx = makeCtxWithUi();
		const pi = makeFakePi();

		// Act
		await runGlueWatcherCommand("disable", ctx, rt, pi, rt.client);

		// Assert
		const notify = (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify;
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/already disabled/), "info");
	});

	it("status: reports enabled/active and the watch count", async () => {
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
			expect.stringMatching(/enabled, active.*2 watch\(es\) \(1 active\)/),
			"info",
		);
	});

	it("status: reflects the paused flag when enabled", async () => {
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
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/enabled, paused/), "info");
	});

	it("status: reports 'disabled' when rt.enabled is false", async () => {
		// Arrange
		const rt = freshRuntime();
		rt.enabled = false;
		const ctx = makeCtxWithUi();
		const pi = makeFakePi();

		// Act
		await runGlueWatcherCommand("status", ctx, rt, pi, rt.client);

		// Assert
		const notify = (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify;
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/^glue-watcher: disabled \|/), "info");
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

	it("jobs: invokes ctx.ui.custom to open the watches overlay", async () => {
		// Arrange
		const rt = freshRuntime();
		const custom = vi.fn(() => undefined);
		const ctx = makeCtxWithUi({ custom });
		const pi = makeFakePi();

		// Act
		await runGlueWatcherCommand("jobs", ctx, rt, pi, rt.client);

		// Assert
		expect(custom).toHaveBeenCalledTimes(1);
		const optionsArg = (custom.mock.calls as unknown as unknown[][])[0]?.[1];
		expect(optionsArg).toMatchObject({ overlay: true });
	});

	it("tolerates missing ui.notify on disable/enable (no-UI context)", async () => {
		// Arrange — headless ctx with no `ui` surface.
		const rt = freshRuntime();
		const headlessCtx = { hasUI: false, ui: null };
		const pi = makeFakePi();

		// Act / Assert — must not throw.
		await expect(runGlueWatcherCommand("enable", headlessCtx, rt, pi, rt.client)).resolves.not.toThrow();
		expect(rt.enabled).toBe(true);
		await expect(runGlueWatcherCommand("disable", headlessCtx, rt, pi, rt.client)).resolves.not.toThrow();
		expect(rt.enabled).toBe(false);
	});
});
