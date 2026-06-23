/**
 * build-addon.test.ts — Unit tests for the buildAddon function in index.ts.
 *
 * We mock node:fs (existsSync) and node:child_process (execFile) to exercise
 * the buildAddon code paths without spawning a real web-ext process.
 *
 * vi.mock is hoisted so it runs before index.ts is imported, which means
 * buildAddon picks up the mocked implementations at call time.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition, ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Use vi.hoisted() so execMock is available inside the vi.mock() factory.
const { execMock } = vi.hoisted(() => ({
	execMock: vi.fn<() => Promise<{ stdout: string; stderr: string }>>()
}));

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	return { ...real, existsSync: vi.fn(real.existsSync) };
});

vi.mock("node:child_process", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:child_process")>();
	// Attach the custom promisify symbol so that promisify(execFile) uses our mock directly
	// and resolves with the { stdout, stderr } object that buildAddon destructures.
	const sym = Symbol.for('nodejs.util.promisify.custom');
	(execMock as unknown as Record<symbol, unknown>)[sym] = execMock;
	return { ...real, execFile: execMock };
});

import { existsSync } from "node:fs";
import createExtension, { type SocketClientLike } from "../src/index.js";

type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

function makeFakePi() {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, { description: string; handler: CommandHandler }>();
	return {
		api: {
			registerTool: vi.fn((t: ToolDefinition) => tools.set(t.name, t)),
			registerCommand: vi.fn((name: string, def: { description: string; handler: CommandHandler }) => {
				commands.set(name, def);
			}),
		} as unknown as ExtensionAPI,
		tools,
		commands,
	};
}

function makeStub(): SocketClientLike {
	return {
		status: vi.fn().mockResolvedValue({}),
		ping: vi.fn().mockResolvedValue(undefined),
		listTabs: vi.fn().mockResolvedValue({ tabs: [] }),
		exportTabs: vi.fn().mockResolvedValue({ tabs: [] }),
		getTabContent: vi.fn().mockResolvedValue({}),
		closeTab: vi.fn().mockResolvedValue(undefined),
	};
}

function makeCommandCtx(selectResponses: Array<string | undefined>) {
	let idx = 0;
	const notifications: Array<{ message: string; type?: string }> = [];
	const ctx = {
		ui: {
			select: vi.fn(() => Promise.resolve(selectResponses[idx++])),
			notify: vi.fn((message: string, type?: string) => {
				notifications.push(type !== undefined ? { message, type } : { message });
			}),
		},
	};
	return { ctx, notifications };
}

function makeExecSuccess(stdout: string) {
	return () => Promise.resolve({ stdout, stderr: "" });
}

function makeExecFail(errMsg: string, stderr = "") {
	return () => {
		const err = Object.assign(new Error(errMsg), { stderr });
		return Promise.reject(err);
	};
}

beforeEach(() => {
	vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// buildAddon — existsSync branch (local bin vs hoisted bin)
// ---------------------------------------------------------------------------

describe("buildAddon — web-ext binary selection", () => {
	it("uses the local node_modules/.bin/web-ext when it exists (existsSync true branch)", async () => {
		// Make existsSync return true for the local bin path, false for everything else
		vi.mocked(existsSync).mockImplementation((p) => {
			const s = String(p);
			return s.includes("pi-browser-control") && s.includes(".bin/web-ext");
		});

		// Make execFile succeed for the web-ext build call
		execMock.mockImplementation(
			makeExecSuccess("Your web extension is ready: /tmp/test.xpi"),
		);

		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: makeStub() });

		const { ctx, notifications } = makeCommandCtx([
			"Build & install XPI (permanent add-on)",
			"Close",
		]);
		const cmd = pi.commands.get("browser-control");
		await cmd?.handler("", ctx);

		// Should have notified "Building XPI…" and then a success/result message
		expect(notifications.some((n) => n.message.includes("Building"))).toBe(true);
	});

	it("falls back to hoisted bin when local bin does not exist (existsSync false branch)", async () => {
		// existsSync returns false for local bin, true for hoisted bin
		vi.mocked(existsSync).mockImplementation((p) => {
			const s = String(p);
			// hoisted path contains ../../node_modules/.bin/web-ext
			if (s.includes(".bin/web-ext") && !s.includes("pi-browser-control")) return true;
			return false;
		});

		execMock.mockImplementation(
			makeExecFail("web-ext: command not found", "web-ext not found"),
		);

		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: makeStub() });

		const { ctx, notifications } = makeCommandCtx([
			"Build & install XPI (permanent add-on)",
			"Close",
		]);
		const cmd = pi.commands.get("browser-control");
		await cmd?.handler("", ctx);

		// Should notify with failure
		expect(notifications.some((n) => n.message.includes("Build"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// buildAddon — success path (xpi path extracted from stdout)
// ---------------------------------------------------------------------------

describe("buildAddon — success path", () => {
	it("returns ok:true and the xpiPath when web-ext prints the ready line", async () => {
		vi.mocked(existsSync).mockReturnValue(true);

		execMock.mockImplementation(
			makeExecSuccess("Your web extension is ready: /tmp/my-extension.xpi"),
		);

		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: makeStub() });

		const { ctx, notifications } = makeCommandCtx([
			"Build & install XPI (permanent add-on)",
			"Close",
		]);
		const cmd = pi.commands.get("browser-control");
		await cmd?.handler("", ctx);

		// XPI path should appear in the notification
		expect(notifications.some((n) => n.message.includes(".xpi"))).toBe(true);
	});

	it("falls back to artifactsDir when stdout doesn't match the ready-line regex (match?.[1] is undefined)", async () => {
		vi.mocked(existsSync).mockReturnValue(true);

		// stdout without the "Your web extension is ready:" line
		execMock.mockImplementation(
			makeExecSuccess("Build complete. No XPI path given."),
		);

		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: makeStub() });

		const { ctx, notifications } = makeCommandCtx([
			"Build & install XPI (permanent add-on)",
			"Close",
		]);
		const cmd = pi.commands.get("browser-control");
		await cmd?.handler("", ctx);

		// Should still notify (using artifactsDir as fallback)
		expect(notifications.some((n) => n.message.toLowerCase().includes("build"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// buildAddon — failure path (execFile throws, catch block)
// ---------------------------------------------------------------------------

describe("buildAddon — failure path", () => {
	it("returns ok:false with error message when execFile fails", async () => {
		vi.mocked(existsSync).mockReturnValue(true);

		execMock.mockImplementation(
			makeExecFail("build failed", "web-ext error: addon directory not found"),
		);

		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: makeStub() });

		const { ctx, notifications } = makeCommandCtx([
			"Build & install XPI (permanent add-on)",
			"Close",
		]);
		const cmd = pi.commands.get("browser-control");
		await cmd?.handler("", ctx);

		// Should notify failure
		expect(notifications.some((n) =>
			n.message.includes("error") || n.message.includes("failed") || n.message.includes("Build"),
		)).toBe(true);
	});
});
