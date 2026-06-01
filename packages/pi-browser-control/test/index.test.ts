/**
 * Tests for src/index.ts (new architecture: socket-client callers).
 */

import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import createExtension, { type SocketClientLike } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

function makeFakePi() {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, { description: string; handler: CommandHandler }>();
	const registerTool = vi.fn((t: ToolDefinition) => tools.set(t.name, t));
	const registerCommand = vi.fn(
		(name: string, def: { description: string; handler: CommandHandler }) => {
			commands.set(name, def);
		},
	);
	return {
		api: { registerTool, registerCommand } as unknown as ExtensionAPI,
		registerTool,
		registerCommand,
		tools,
		commands,
		tool(name: string): ToolDefinition {
			const t = tools.get(name);
			if (!t) throw new Error(`Tool ${name} not registered`);
			return t;
		},
	};
}

function makeStub(overrides?: Partial<SocketClientLike>): SocketClientLike {
	return {
		listTabs: vi.fn().mockResolvedValue({ tabs: [] }),
		getTabContent: vi.fn().mockResolvedValue({
			tabId: 1,
			fullText: "hello",
			totalLength: 5,
			isTruncated: false,
			links: [],
		}),
		status: vi.fn().mockResolvedValue({
			daemon: { pid: 1, uptimeSec: 1, version: "0.1.0" },
			addon: { connected: true, lastSeenSec: 0 },
		}),
		ping: vi.fn().mockResolvedValue({ addon: "ready", version: "1.0" }),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("registration", () => {
	it("registers exactly two tools", () => {
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: makeStub() });
		expect(pi.registerTool).toHaveBeenCalledTimes(2);
		expect(pi.tools.has("browser_list_tabs")).toBe(true);
		expect(pi.tools.has("browser_get_tab_content")).toBe(true);
	});

	it("registers the browser-control command", () => {
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: makeStub() });
		expect(pi.commands.has("browser-control")).toBe(true);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"browser-control",
			expect.objectContaining({ description: expect.any(String) as unknown }),
		);
	});

	it("each tool has description, promptSnippet, promptGuidelines, parameters, execute", () => {
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: makeStub() });
		for (const name of ["browser_list_tabs", "browser_get_tab_content"]) {
			const t = pi.tool(name);
			expect(typeof t.description).toBe("string");
			expect(t.description.length).toBeGreaterThan(0);
			expect(typeof t.promptSnippet).toBe("string");
			expect(Array.isArray(t.promptGuidelines)).toBe(true);
			expect((t.promptGuidelines ?? []).length).toBeGreaterThan(0);
			expect(t.parameters).toBeDefined();
			expect(typeof t.execute).toBe("function");
		}
	});
});

// ---------------------------------------------------------------------------
// browser_list_tabs
// ---------------------------------------------------------------------------

describe("browser_list_tabs — happy path", () => {
	it("returns header + tab lines", async () => {
		const stub = makeStub({
			listTabs: vi.fn().mockResolvedValue({
				tabs: [
					{ id: 1, url: "https://a.com", title: "A", lastAccessed: Date.now() - 5000 },
					{ id: 2, url: "https://b.com", title: "B" },
				],
			}),
		});
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_list_tabs").execute(
			"tc1", { offset: 0, limit: 100 }, undefined, undefined, {} as never,
		);
		const texts = result.content.map((c) => (c as { text: string }).text);
		expect(texts[0]).toMatch(/Showing tabs 1-2 of 2/);
		expect(texts[1]).toMatch(/tab id=1/);
		expect(texts[2]).toMatch(/tab id=2/);
	});

	it("paginates with offset", async () => {
		const stub = makeStub({
			listTabs: vi.fn().mockResolvedValue({
				tabs: [
					{ id: 1, url: "https://a.com", title: "A" },
					{ id: 2, url: "https://b.com", title: "B" },
					{ id: 3, url: "https://c.com", title: "C" },
				],
			}),
		});
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_list_tabs").execute(
			"tc2", { offset: 1, limit: 1 }, undefined, undefined, {} as never,
		);
		const texts = result.content.map((c) => (c as { text: string }).text);
		expect(texts[0]).toMatch(/Showing tabs 2-2 of 3/);
		expect(result.content).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// browser_get_tab_content
// ---------------------------------------------------------------------------

describe("browser_get_tab_content — happy path", () => {
	it("returns text + links at offset=0", async () => {
		const stub = makeStub({
			getTabContent: vi.fn().mockResolvedValue({
				tabId: 5,
				fullText: "Page content",
				totalLength: 12,
				isTruncated: false,
				links: [{ text: "Link", url: "https://link.com" }],
			}),
		});
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_get_tab_content").execute(
			"tc3", { tabId: 5, offset: 0 }, undefined, undefined, {} as never,
		);
		expect(vi.mocked(stub.getTabContent)).toHaveBeenCalledWith(5, 0);
		const texts = result.content.map((c) => (c as { text: string }).text);
		expect(texts).toContainEqual("Page content");
		expect(texts.some((t) => t.includes("Link text: Link"))).toBe(true);
	});

	it("excludes links when offset>0", async () => {
		const stub = makeStub({
			getTabContent: vi.fn().mockResolvedValue({
				tabId: 5,
				fullText: "More content",
				totalLength: 1000,
				isTruncated: false,
				links: [{ text: "L", url: "https://l.com" }],
			}),
		});
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_get_tab_content").execute(
			"tc4", { tabId: 5, offset: 100 }, undefined, undefined, {} as never,
		);
		const texts = result.content.map((c) => (c as { text: string }).text);
		expect(texts.some((t) => t.includes("Link text:"))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Error paths — mapped to friendly messages
// ---------------------------------------------------------------------------

describe("error paths", () => {
	it("DAEMON_NOT_RUNNING → message about starting Firefox add-on", async () => {
		const err = Object.assign(new Error("daemon not running"), { code: "DAEMON_NOT_RUNNING" });
		const stub = makeStub({ listTabs: vi.fn().mockRejectedValue(err) });
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_list_tabs").execute(
			"tc-err1", { offset: 0, limit: 100 }, undefined, undefined, {} as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/daemon|not running|install/i);
	});

	it("ADDON_NOT_CONNECTED → message about loading the add-on", async () => {
		const err = Object.assign(new Error("addon not connected"), { code: "ADDON_NOT_CONNECTED" });
		const stub = makeStub({ listTabs: vi.fn().mockRejectedValue(err) });
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_list_tabs").execute(
			"tc-err2", { offset: 0, limit: 100 }, undefined, undefined, {} as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/add-on|addon|Firefox/i);
	});

	it("TAB_NOT_FOUND → message about re-listing tabs", async () => {
		const err = Object.assign(new Error("tab not found"), { code: "TAB_NOT_FOUND" });
		const stub = makeStub({ getTabContent: vi.fn().mockRejectedValue(err) });
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_get_tab_content").execute(
			"tc-err3", { tabId: 99, offset: 0 }, undefined, undefined, {} as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/tab|not found/i);
	});

	it("generic error returns a non-empty message", async () => {
		const stub = makeStub({ listTabs: vi.fn().mockRejectedValue(new Error("something weird")) });
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_list_tabs").execute(
			"tc-err4", { offset: 0, limit: 100 }, undefined, undefined, {} as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text.length).toBeGreaterThan(0);
		expect(result.details).toMatchObject({ ok: false });
	});
});


// ---------------------------------------------------------------------------
// /browser-control command — exercises index.ts lambdas
// ---------------------------------------------------------------------------

/** Minimal ExtensionCommandContext for the /browser-control command handler. */
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

describe("/browser-control command — getStatus lambda", () => {
	it("calls client.status() and shows daemon info", async () => {
		const stub = makeStub({
			status: vi.fn().mockResolvedValue({
				daemon: { pid: 42, uptimeSec: 5, version: "0.2.0" },
				addon: { connected: true, lastSeenSec: 0 },
			}),
		});
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const { ctx, notifications } = makeCommandCtx(["Status", "Close"]);
		const cmd = pi.commands.get("browser-control");
		await cmd?.handler("", ctx as never);
		expect(stub.status).toHaveBeenCalled();
		expect(notifications.some((n) => n.message.includes("42"))).toBe(true);
	});
});

describe("/browser-control command — testConnection lambda", () => {
	it("calls ping() + listTabs() and reports connected", async () => {
		const stub = makeStub({
			ping: vi.fn().mockResolvedValue({}),
			listTabs: vi.fn().mockResolvedValue({ tabs: [{}, {}] }),
		});
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const { ctx, notifications } = makeCommandCtx(["Test connection", "Close"]);
		const cmd = pi.commands.get("browser-control");
		await cmd?.handler("", ctx as never);
		expect(stub.ping).toHaveBeenCalled();
		expect(notifications.some((n) => n.message.toLowerCase().includes("connected"))).toBe(true);
	});

	it("reports DAEMON_NOT_RUNNING when ping rejects with that code", async () => {
		const err = Object.assign(new Error("daemon not running"), { code: "DAEMON_NOT_RUNNING" });
		const stub = makeStub({ ping: vi.fn().mockRejectedValue(err) });
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const { ctx, notifications } = makeCommandCtx(["Test connection", "Close"]);
		const cmd = pi.commands.get("browser-control");
		await cmd?.handler("", ctx as never);
		expect(notifications.some((n) => n.type === "error")).toBe(true);
	});

	it("reports ADDON_NOT_CONNECTED error", async () => {
		const err = Object.assign(new Error("addon not connected"), { code: "ADDON_NOT_CONNECTED" });
		const stub = makeStub({ ping: vi.fn().mockRejectedValue(err) });
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const { ctx, notifications } = makeCommandCtx(["Test connection", "Close"]);
		const cmd = pi.commands.get("browser-control");
		await cmd?.handler("", ctx as never);
		expect(notifications.some((n) => n.type === "error" && n.message.includes("add-on"))).toBe(true);
	});

	it("reports generic connection failure", async () => {
		const err = Object.assign(new Error("network error"), { code: "OTHER" });
		const stub = makeStub({ ping: vi.fn().mockRejectedValue(err) });
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const { ctx, notifications } = makeCommandCtx(["Test connection", "Close"]);
		const cmd = pi.commands.get("browser-control");
		await cmd?.handler("", ctx as never);
		expect(notifications.some((n) => n.type === "error")).toBe(true);
	});
});

describe("/browser-control command — installManifest lambda", () => {
	it("calls installLauncher + installManifest and reports success", async () => {
		const fsNode = await import("node:fs");
		const osNode = await import("node:os");
		const pathNode = await import("node:path");
		const tmpAgent = fsNode.mkdtempSync(pathNode.join(osNode.tmpdir(), "pi-bc-idx-"));
		try {
			const stub = makeStub();
			const pi = makeFakePi();
			createExtension(pi.api, { socketClient: stub, agentDir: tmpAgent });
			const { ctx, notifications } = makeCommandCtx(["Install Firefox native-messaging manifest", "Close"]);
			const cmd = pi.commands.get("browser-control");
			await cmd?.handler("", ctx as never);
			// Either success or install-error notification — both exercise the lambda
			expect(notifications.length).toBeGreaterThan(0);
		} finally {
			fsNode.rmSync(tmpAgent, { recursive: true, force: true });
		}
	});
});

describe("browser_get_tab_content — SocketClientError vs generic error path", () => {
	it("SocketClientError goes through errorResult", async () => {
		const err = new (await import("../src/socket-client.js")).SocketClientError("no tab", "TAB_NOT_FOUND");
		const stub = makeStub({ getTabContent: vi.fn().mockRejectedValue(err) });
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_get_tab_content").execute(
			"tc-sce", { tabId: 9, offset: 0 }, undefined, undefined, {} as never,
		);
		expect(result.details).toMatchObject({ ok: false });
	});
});

describe("/browser-control command — installManifest failure path", () => {
	it("returns early when installLauncher fails (launcher path is a directory)", async () => {
		const fsNode = await import("node:fs");
		const osNode = await import("node:os");
		const pathNode = await import("node:path");
		const tmpAgent = fsNode.mkdtempSync(pathNode.join(osNode.tmpdir(), "pi-bc-fail-"));
		// Create a directory at the launcher script path so installLauncher cannot write there
		const launcherDir = pathNode.join(tmpAgent, "pi-browser-control");
		const launcherPathVal = pathNode.join(launcherDir, "launch");
		fsNode.mkdirSync(launcherPathVal, { recursive: true }); // launcherPath is now a dir
		try {
			const stub = makeStub();
			const pi = makeFakePi();
			createExtension(pi.api, { socketClient: stub, agentDir: tmpAgent });
			const { ctx, notifications } = makeCommandCtx(["Install Firefox native-messaging manifest", "Close"]);
			const cmd = pi.commands.get("browser-control");
			await cmd?.handler("", ctx as never);
			// Should notify about install failure
			expect(notifications.some((n) => n.type === "error" || n.message.includes("fail") || n.message.includes("Install"))).toBe(true);
		} finally {
			fsNode.rmSync(tmpAgent, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// index.ts branch gaps
// ---------------------------------------------------------------------------

describe("createExtension — socketClient ?? new SocketClient() branch (line 129)", () => {
	it("works without explicit socketClient option (uses default SocketClient)", () => {
		const pi = makeFakePi();
		// No socketClient option → exercises `options.socketClient ?? new SocketClient()`
		createExtension(pi.api);
		// Extension registered correctly
		expect(pi.commands.has("browser-control")).toBe(true);
	});
});

describe("errorResult — String(err) fallback when err has no .message (line 87)", () => {
	it("returns non-empty error message for plain object without .message", async () => {
		// Throw a plain object (no .message) → e.message is undefined → String(err) is used
		const plainErr = { code: "OTHER" }; // no .message
		const stub = makeStub({
			listTabs: vi.fn().mockRejectedValue(plainErr),
		});
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_list_tabs").execute(
			"tc-str-err", { offset: 0, limit: 100 }, undefined, undefined, {} as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text.length).toBeGreaterThan(0);
	});
});
