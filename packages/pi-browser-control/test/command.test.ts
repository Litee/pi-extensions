/**
 * Tests for src/command.ts (new architecture).
 *
 * Menu: Status / Test connection / Install Firefox native-messaging manifest / Close
 * Plus extraItems injection.
 */

import { describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
	runBrowserControlCommand,
	type BrowserControlCommandDeps,
} from "../src/command.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(selectResponses: Array<string | undefined>) {
	let selectIdx = 0;
	const notifications: Array<{ message: string; type?: string }> = [];
	const selectMock = vi.fn(() =>
		Promise.resolve(selectResponses[selectIdx++]),
	);
	const notifyMock = vi.fn((message: string, type?: string) => {
		notifications.push(type !== undefined ? { message, type } : { message });
	});
	const ctx = {
		ui: { select: selectMock, notify: notifyMock },
	} as unknown as ExtensionCommandContext;
	return { ctx, notifications, selectMock, notifyMock };
}

function makeDeps(overrides?: Partial<BrowserControlCommandDeps>): BrowserControlCommandDeps {
	return {
		getStatus: vi.fn().mockResolvedValue({
			daemon: { pid: 1234, uptimeSec: 10, version: "0.1.0" },
			addon: { connected: true, lastSeenSec: 1 },
		}),
		testConnection: vi.fn().mockResolvedValue({ ok: true, message: "Connected. 3 tab(s)." }),
		installManifest: vi.fn().mockResolvedValue({ ok: true, path: "/fake/nm.json" }),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Close / cancel
// ---------------------------------------------------------------------------

describe("runBrowserControlCommand — close", () => {
	it("exits immediately on Close", async () => {
		const { ctx, selectMock } = makeCtx(["Close"]);
		await runBrowserControlCommand(ctx, makeDeps());
		expect(selectMock).toHaveBeenCalledTimes(1);
	});

	it("exits on undefined (cancel)", async () => {
		const { ctx, selectMock } = makeCtx([undefined]);
		await runBrowserControlCommand(ctx, makeDeps());
		expect(selectMock).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

describe("runBrowserControlCommand — Status", () => {
	it("notifies with daemon + addon info on success", async () => {
		const { ctx, notifications } = makeCtx(["Status", "Close"]);
		await runBrowserControlCommand(ctx, makeDeps());
		expect(notifications[0]?.type).toBe("info");
		// Second notify has the status details
		expect(notifications[1]?.type).toBe("info");
		expect(notifications[1]?.message).toMatch(/1234|daemon|pid/i);
	});

	it("notifies DAEMON_NOT_RUNNING when getStatus throws with code", async () => {
		const err = Object.assign(new Error("not running"), { code: "DAEMON_NOT_RUNNING" });
		const { ctx, notifications } = makeCtx(["Status", "Close"]);
		await runBrowserControlCommand(ctx, makeDeps({ getStatus: vi.fn().mockRejectedValue(err) }));
		const errorNotify = notifications.find((n) => n.type === "error");
		expect(errorNotify).toBeDefined();
		expect(errorNotify?.message).toMatch(/daemon|not running/i);
	});

	it("notifies error for unexpected getStatus failure", async () => {
		const { ctx, notifications } = makeCtx(["Status", "Close"]);
		await runBrowserControlCommand(ctx, makeDeps({
			getStatus: vi.fn().mockRejectedValue(new Error("unexpected")),
		}));
		const errorNotify = notifications.find((n) => n.type === "error");
		expect(errorNotify).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Test connection
// ---------------------------------------------------------------------------

describe("runBrowserControlCommand — Test connection", () => {
	it("notifies 'Testing connection…' then success", async () => {
		const { ctx, notifications } = makeCtx(["Test connection", "Close"]);
		await runBrowserControlCommand(ctx, makeDeps());
		expect(notifications[0]).toEqual({ message: "Testing connection…", type: "info" });
		expect(notifications[1]?.type).toBe("info");
		expect(notifications[1]?.message).toMatch(/Connected/i);
	});

	it("notifies error on failure", async () => {
		const { ctx, notifications } = makeCtx(["Test connection", "Close"]);
		await runBrowserControlCommand(ctx, makeDeps({
			testConnection: vi.fn().mockResolvedValue({ ok: false, message: "Not running." }),
		}));
		expect(notifications[0]).toEqual({ message: "Testing connection…", type: "info" });
		expect(notifications[1]?.type).toBe("error");
		expect(notifications[1]?.message).toMatch(/Not running/);
	});
});

// ---------------------------------------------------------------------------
// Install Firefox native-messaging manifest
// ---------------------------------------------------------------------------

describe("runBrowserControlCommand — Install manifest", () => {
	it("notifies success with path on ok:true", async () => {
		const { ctx, notifications } = makeCtx(["Install Firefox native-messaging manifest", "Close"]);
		await runBrowserControlCommand(ctx, makeDeps());
		const successNotify = notifications.find((n) => n.type === "info" && n.message.includes("/fake/nm.json"));
		expect(successNotify).toBeDefined();
	});

	it("notifies error on ok:false", async () => {
		const { ctx, notifications } = makeCtx(["Install Firefox native-messaging manifest", "Close"]);
		await runBrowserControlCommand(ctx, makeDeps({
			installManifest: vi.fn().mockResolvedValue({ ok: false, error: "Permission denied" }),
		}));
		const errorNotify = notifications.find((n) => n.type === "error");
		expect(errorNotify).toBeDefined();
		expect(errorNotify?.message).toMatch(/Permission denied/);
	});
});

// ---------------------------------------------------------------------------
// Build & install XPI
// ---------------------------------------------------------------------------

describe("runBrowserControlCommand — Build & install XPI", () => {
	const ITEM_BUILD = "Build & install XPI (permanent add-on)";

	it("shows Build item in menu when buildAddon is provided", async () => {
		const { ctx, selectMock } = makeCtx(["Close"]);
		await runBrowserControlCommand(ctx, makeDeps({ buildAddon: vi.fn() }));
		const options = (selectMock.mock.calls as unknown as Array<[string, string[]]>)[0]?.[1] ?? [];
		expect(options).toContain(ITEM_BUILD);
	});

	it("does NOT show Build item when buildAddon is not provided", async () => {
		const { ctx, selectMock } = makeCtx(["Close"]);
		await runBrowserControlCommand(ctx, makeDeps());
		const options = (selectMock.mock.calls as unknown as Array<[string, string[]]>)[0]?.[1] ?? [];
		expect(options).not.toContain(ITEM_BUILD);
	});

	it("notifies success with XPI path on ok:true", async () => {
		const xpiPath = "/fake/web-ext-artifacts/pi_browser_control-0.1.0.xpi";
		const { ctx, notifications } = makeCtx([ITEM_BUILD, "Close"]);
		await runBrowserControlCommand(
			ctx,
			makeDeps({ buildAddon: vi.fn().mockResolvedValue({ ok: true, xpiPath }) }),
		);
		const successNotify = notifications.find(
			(n) => n.type === "info" && n.message.includes("XPI built"),
		);
		expect(successNotify).toBeDefined();
		expect(successNotify?.message).toContain(xpiPath);
		expect(successNotify?.message).toContain("about:config");
		expect(successNotify?.message).toContain("xpinstall.signatures.required");
	});

	it("notifies error on ok:false", async () => {
		const { ctx, notifications } = makeCtx([ITEM_BUILD, "Close"]);
		await runBrowserControlCommand(
			ctx,
			makeDeps({
				buildAddon: vi.fn().mockResolvedValue({ ok: false, error: "web-ext not found" }),
			}),
		);
		const errorNotify = notifications.find((n) => n.type === "error");
		expect(errorNotify).toBeDefined();
		expect(errorNotify?.message).toMatch(/Build failed.*web-ext not found/);
	});

	it("notifies 'Building XPI…' before calling buildAddon", async () => {
		const xpiPath = "/fake/out.xpi";
		const { ctx, notifications } = makeCtx([ITEM_BUILD, "Close"]);
		await runBrowserControlCommand(
			ctx,
			makeDeps({ buildAddon: vi.fn().mockResolvedValue({ ok: true, xpiPath }) }),
		);
		expect(notifications[0]).toEqual({ message: "Building XPI with web-ext\u2026", type: "info" });
	});
});

// ---------------------------------------------------------------------------
// extraItems
// ---------------------------------------------------------------------------

describe("runBrowserControlCommand — extraItems", () => {
	it("shows extra items in the menu and calls their handler", async () => {
		const handlerMock = vi.fn().mockResolvedValue(undefined);
		const { ctx, selectMock } = makeCtx(["Custom action", "Close"]);
		await runBrowserControlCommand(ctx, makeDeps({
			extraItems: [{ label: "Custom action", handler: handlerMock }],
		}));
		// The select menu should have included "Custom action"
		const options = (selectMock.mock.calls as unknown as Array<[string, string[]]>)[0]?.[1] ?? [];
		expect(options).toContain("Custom action");
		expect(handlerMock).toHaveBeenCalledTimes(1);
	});

	it("supports multiple extra items", async () => {
		const h1 = vi.fn().mockResolvedValue(undefined);
		const h2 = vi.fn().mockResolvedValue(undefined);
		const { ctx, selectMock } = makeCtx(["Action 1", "Action 2", "Close"]);
		await runBrowserControlCommand(ctx, makeDeps({
			extraItems: [
				{ label: "Action 1", handler: h1 },
				{ label: "Action 2", handler: h2 },
			],
		}));
		const firstCallOptions = (selectMock.mock.calls as unknown as Array<[string, string[]]>)[0]?.[1] ?? [];
		expect(firstCallOptions).toContain("Action 1");
		expect(firstCallOptions).toContain("Action 2");
		expect(h1).toHaveBeenCalledTimes(1);
		expect(h2).toHaveBeenCalledTimes(1);
	});

	it("defaults to no extra items (empty array)", async () => {
		const { ctx, selectMock } = makeCtx(["Close"]);
		// No extraItems in deps
		await runBrowserControlCommand(ctx, makeDeps());
		const options = (selectMock.mock.calls as unknown as Array<[string, string[]]>)[0]?.[1] ?? [];
		expect(options).toContain("Close");
		expect(options).not.toContain(undefined);
	});
});

// ---------------------------------------------------------------------------
// Menu loops back correctly
// ---------------------------------------------------------------------------

describe("runBrowserControlCommand — loops", () => {
	it("loops back to menu after an action", async () => {
		const { ctx, selectMock } = makeCtx(["Test connection", "Close"]);
		await runBrowserControlCommand(ctx, makeDeps());
		expect(selectMock).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// Branch coverage gaps
// ---------------------------------------------------------------------------

describe("runBrowserControlCommand — branch gaps", () => {
	it("status: shows 'disconnected' when addon.connected is false", async () => {
		const { ctx, notifications } = makeCtx(["Status", "Close"]);
		await runBrowserControlCommand(ctx, makeDeps({
			getStatus: vi.fn().mockResolvedValue({
				daemon: { pid: 1, uptimeSec: 0, version: "0.1.0" },
				addon: { connected: false, lastSeenSec: null },
			}),
		}));
		const statusMsg = notifications.find((n) => n.type === "info" && n.message.includes("Add-on"));
		expect(statusMsg?.message).toMatch(/disconnected/i);
	});

	it("status: uses String(err) fallback when error has no .message", async () => {
		const errObj = { code: "UNKNOWN" }; // plain object, not an Error instance
		const { ctx, notifications } = makeCtx(["Status", "Close"]);
		await runBrowserControlCommand(ctx, makeDeps({
			getStatus: vi.fn().mockRejectedValue(errObj),
		}));
		const errorNotify = notifications.find((n) => n.type === "error");
		expect(errorNotify).toBeDefined();
		expect(errorNotify?.message).toMatch(/Status error/i);
	});

	it("extra items: if-item is false when unknown label is chosen", async () => {
		const { ctx } = makeCtx(["UnknownLabel", "Close"]);
		// No extraItems provided; "UnknownLabel" falls through to else branch where find returns undefined
		await expect(
			runBrowserControlCommand(ctx, makeDeps()),
		).resolves.toBeUndefined();
	});
});
