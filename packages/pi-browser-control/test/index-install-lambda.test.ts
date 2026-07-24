/**
 * Tests for the `options.manifestPath !== undefined ? { overrideManifestPath } : {}`
 * spread branch inside index.ts's installManifest command lambda.
 *
 * The lambda only reaches installManifest when the launcher installed
 * successfully; installManifest otherwise writes to the REAL macOS NM location
 * when manifestPath is omitted. We mock both installers so no real filesystem
 * writes happen while still exercising the `: {}` default branch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const installManifestMock = vi.fn();
const installLauncherMock = vi.fn();

vi.mock("../src/manifest-installer.js", () => ({
	installManifest: (...args: unknown[]) => installManifestMock(...args) as void,
}));
vi.mock("../src/launcher-installer.js", () => ({
	installLauncher: (...args: unknown[]) => installLauncherMock(...args) as void,
}));

import createExtension, { type SocketClientLike } from "../src/index.js";

function makeStub(): SocketClientLike {
	return {
		listTabs: vi.fn().mockResolvedValue({ tabs: [] }),
		exportTabs: vi.fn().mockResolvedValue({ tabs: [] }),
		getTabContent: vi.fn().mockResolvedValue({
			tabId: 1,
			fullText: "x",
			totalLength: 1,
			isTruncated: false,
			links: [],
		}),
		closeTab: vi.fn().mockResolvedValue({}),
		status: vi.fn().mockResolvedValue({
			daemon: { pid: 1, uptimeSec: 1, version: "0.1" },
			addon: { connected: true, lastSeenSec: 0 },
		}),
		ping: vi.fn().mockResolvedValue({}),
	};
}

function makeFakePi() {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<
		string,
		{ description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
	>();
	const registerTool = vi.fn((t: ToolDefinition) => tools.set(t.name, t));
	const registerCommand = vi.fn(
		(name: string, def: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
			commands.set(name, def);
		},
	);
	return { api: { registerTool, registerCommand } as unknown as ExtensionAPI, commands };
}

describe("/browser-control installManifest lambda — manifestPath default branch", () => {
	beforeEach(() => {
		installManifestMock.mockReset();
		installLauncherMock.mockReset();
	});

	it("passes no overrideManifestPath when options.manifestPath is undefined", async () => {
		installLauncherMock.mockReturnValue({ ok: true });
		installManifestMock.mockReturnValue({ ok: true, path: "/tmp/pi-bc-nm.json" });

		const pi = makeFakePi();
		// No manifestPath option → exercises the `: {}` branch of the spread.
		createExtension(pi.api, { socketClient: makeStub() });

		const cmd = pi.commands.get("browser-control");
		const selectResponses = ["Install Firefox native-messaging manifest", "Close"];
		let idx = 0;
		const ctx = {
			ui: {
				select: vi.fn(() => Promise.resolve(selectResponses[idx++])),
				notify: vi.fn(),
			},
		};
		await cmd?.handler("", ctx as never);

		expect(installLauncherMock).toHaveBeenCalled();
		expect(installManifestMock).toHaveBeenCalledTimes(1);
		const callArg = installManifestMock.mock.calls[0]![0] as Record<string, unknown>;
		expect(callArg["overrideManifestPath"]).toBeUndefined();
	});

	it("passes overrideManifestPath when options.manifestPath is set", async () => {
		installLauncherMock.mockReturnValue({ ok: true });
		installManifestMock.mockReturnValue({ ok: true, path: "/tmp/pi-bc-nm.json" });

		const pi = makeFakePi();
		createExtension(pi.api, {
			socketClient: makeStub(),
			manifestPath: "/tmp/pi-bc-override.json",
		});

		const cmd = pi.commands.get("browser-control");
		const selectResponses = ["Install Firefox native-messaging manifest", "Close"];
		let idx = 0;
		const ctx = {
			ui: {
				select: vi.fn(() => Promise.resolve(selectResponses[idx++])),
				notify: vi.fn(),
			},
		};
		await cmd?.handler("", ctx as never);

		expect(installManifestMock).toHaveBeenCalledTimes(1);
		const callArg = installManifestMock.mock.calls[0]![0] as Record<string, unknown>;
		expect(callArg["overrideManifestPath"]).toBe("/tmp/pi-bc-override.json");
	});
});
