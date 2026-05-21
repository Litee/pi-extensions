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
		["browse", { kind: "browse" }],
		["status", { kind: "status" }],
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
