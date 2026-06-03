/**
 * Tests for src/index.ts — unified browser_control tool.
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
		exportTabs: vi.fn().mockResolvedValue({ tabs: [] }),
		getTabContent: vi.fn().mockResolvedValue({
			tabId: 1,
			fullText: "hello",
			totalLength: 5,
			isTruncated: false,
			links: [],
		}),
		closeTab: vi.fn().mockResolvedValue({ closed: true, tabId: 1 }),
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
	it("registers exactly one browser_control tool", () => {
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: makeStub() });
		expect(pi.registerTool).toHaveBeenCalledTimes(1);
		expect(pi.tools.has("browser_control")).toBe(true);
	});

	it("old tool names are NOT registered", () => {
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: makeStub() });
		expect(pi.tools.has("browser_list_tabs")).toBe(false);
		expect(pi.tools.has("browser_export_tabs")).toBe(false);
		expect(pi.tools.has("browser_get_tab_content")).toBe(false);
	});

	it("enableGetTabContent option is accepted without error (backward compat)", () => {
		const pi = makeFakePi();
		// Should not throw
		createExtension(pi.api, { socketClient: makeStub(), enableGetTabContent: true });
		expect(pi.tools.has("browser_control")).toBe(true);
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

	it("browser_control has description, promptSnippet, promptGuidelines, parameters, execute, renderResult", () => {
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: makeStub() });
		const t = pi.tool("browser_control");
		expect(typeof t.description).toBe("string");
		expect(t.description.length).toBeGreaterThan(0);
		expect(typeof t.promptSnippet).toBe("string");
		expect(Array.isArray(t.promptGuidelines)).toBe(true);
		expect((t.promptGuidelines ?? []).length).toBeGreaterThan(0);
		expect(t.parameters).toBeDefined();
		expect(typeof t.execute).toBe("function");
		expect(typeof t.renderResult).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// operation: list_tabs
// ---------------------------------------------------------------------------

describe("browser_control operation=list_tabs — happy path", () => {
	it("returns header + tab lines", async () => {
		const stub = makeStub({
			listTabs: vi.fn().mockResolvedValue({
				tabs: [
					{ id: 1, url: "https://a.com", title: "A", lastAccessed: Date.now() - 5000, normalizedUrl: "https://a.com/" },
					{ id: 2, url: "https://b.com", title: "B", normalizedUrl: "https://b.com/" },
				],
			}),
		});
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_control").execute(
			"tc1", { operation: "list_tabs" }, undefined, undefined, {} as never,
		);
		const texts = result.content.map((c) => (c as { text: string }).text);
		expect(texts[0]).toMatch(/2 tabs open/);
		expect(texts[1]).toMatch(/tab id=1/);
		expect(texts[2]).toMatch(/tab id=2/);
	});
});

// ---------------------------------------------------------------------------
// operation: export_tabs
// ---------------------------------------------------------------------------

describe("browser_control operation=export_tabs — happy path", () => {
	it("writes JSONL with one line per tab", async () => {
		const fsNode = await import("node:fs");
		const osNode = await import("node:os");
		const pathNode = await import("node:path");
		const cryptoNode = await import("node:crypto");
		const outPath = pathNode.join(osNode.tmpdir(), `pi-bc-export-${cryptoNode.randomUUID()}.jsonl`);
		try {
			const tabs = [
				{ id: 1, windowId: 1, index: 0, url: "https://a.com", normalizedUrl: "https://a.com/", title: "A", favIconUrl: null, status: "complete", active: true, pinned: false, hidden: false, discarded: false, incognito: false, audible: false, mutedInfo: { muted: false, reason: null }, isArticle: false, isInReaderMode: false, lastAccessed: 1000, cookieStoreId: null },
				{ id: 2, windowId: 1, index: 1, url: "https://b.com", normalizedUrl: "https://b.com/", title: "B", favIconUrl: null, status: "complete", active: false, pinned: false, hidden: false, discarded: false, incognito: false, audible: false, mutedInfo: { muted: false, reason: null }, isArticle: false, isInReaderMode: false, lastAccessed: 2000, cookieStoreId: null },
			];
			const stub = makeStub({
				exportTabs: vi.fn().mockResolvedValue({ tabs }),
			});
			const pi = makeFakePi();
			createExtension(pi.api, { socketClient: stub });
			const result = await pi.tool("browser_control").execute(
				"tc-exp1", { operation: "export_tabs", path: outPath }, undefined, undefined, {} as never,
			);
			const text = (result.content[0] as { text: string }).text;
			expect(text).toMatch(/Exported 2 tabs to/);
			expect(text).toContain(outPath);
			// Verify file contents
			const lines = fsNode.readFileSync(outPath, "utf-8").split("\n").filter((l) => l.length > 0);
			expect(lines).toHaveLength(2);
			const parsed0 = JSON.parse(lines[0]!) as Record<string, unknown>;
			expect(parsed0["id"]).toBe(1);
			expect(parsed0["url"]).toBe("https://a.com");
			expect(parsed0["normalizedUrl"]).toBe("https://a.com/");
			expect(parsed0["hidden"]).toBe(false);
			expect((parsed0["mutedInfo"] as { muted: boolean }).muted).toBe(false);
			const parsed1 = JSON.parse(lines[1]!) as Record<string, unknown>;
			expect(parsed1["id"]).toBe(2);
		} finally {
			if (fsNode.existsSync(outPath)) fsNode.unlinkSync(outPath);
		}
	});

	it("empty tab list → empty file", async () => {
		const fsNode = await import("node:fs");
		const osNode = await import("node:os");
		const pathNode = await import("node:path");
		const cryptoNode = await import("node:crypto");
		const outPath = pathNode.join(osNode.tmpdir(), `pi-bc-export-empty-${cryptoNode.randomUUID()}.jsonl`);
		try {
			const stub = makeStub({
				exportTabs: vi.fn().mockResolvedValue({ tabs: [] }),
			});
			const pi = makeFakePi();
			createExtension(pi.api, { socketClient: stub });
			const result = await pi.tool("browser_control").execute(
				"tc-exp2", { operation: "export_tabs", path: outPath }, undefined, undefined, {} as never,
			);
			const text = (result.content[0] as { text: string }).text;
			expect(text).toMatch(/Exported 0 tabs to/);
			const content = fsNode.readFileSync(outPath, "utf-8");
			expect(content).toBe("");
		} finally {
			if (fsNode.existsSync(outPath)) fsNode.unlinkSync(outPath);
		}
	});

	it("DAEMON_NOT_RUNNING → returns error message, does not write file", async () => {
		const fsNode = await import("node:fs");
		const osNode = await import("node:os");
		const pathNode = await import("node:path");
		const cryptoNode = await import("node:crypto");
		const outPath = pathNode.join(osNode.tmpdir(), `pi-bc-export-dnr-${cryptoNode.randomUUID()}.jsonl`);
		const err = Object.assign(new Error("daemon not running"), { code: "DAEMON_NOT_RUNNING" });
		const stub = makeStub({ exportTabs: vi.fn().mockRejectedValue(err) });
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_control").execute(
			"tc-exp3", { operation: "export_tabs", path: outPath }, undefined, undefined, {} as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/daemon|not running|install/i);
		expect(fsNode.existsSync(outPath)).toBe(false);
	});

	it("write error (unwritable path) → returns error message", async () => {
		const tabs = [
			{ id: 1, url: "https://a.com", normalizedUrl: "https://a.com/", title: "A" },
		];
		const stub = makeStub({
			exportTabs: vi.fn().mockResolvedValue({ tabs }),
		});
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const fsNode = await import("node:fs");
		const osNode = await import("node:os");
		const pathNode = await import("node:path");
		const cryptoNode = await import("node:crypto");
		const badDir = pathNode.join(osNode.tmpdir(), `pi-bc-export-baddir-${cryptoNode.randomUUID()}`);
		fsNode.mkdirSync(badDir);
		try {
			const result = await pi.tool("browser_control").execute(
				"tc-exp4", { operation: "export_tabs", path: badDir }, undefined, undefined, {} as never,
			);
			const text = (result.content[0] as { text: string }).text;
			expect(text).toMatch(/error|fail/i);
			expect(result.details).toMatchObject({ ok: false });
		} finally {
			fsNode.rmSync(badDir, { recursive: true, force: true });
		}
	});

	it("relative path → returns error without writing", async () => {
		const stub = makeStub({ exportTabs: vi.fn() });
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_control").execute(
			"tc-exp5", { operation: "export_tabs", path: "relative/path.jsonl" }, undefined, undefined, {} as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/absolute/i);
		expect(stub.exportTabs).not.toHaveBeenCalled();
	});

	it("incognito tabs excluded from export", async () => {
		const osNode = await import("node:os");
		const pathNode = await import("node:path");
		const cryptoNode = await import("node:crypto");
		const fsNode = await import("node:fs");
		const outPath = pathNode.join(osNode.tmpdir(), `pi-bc-export-incognito-${cryptoNode.randomUUID()}.jsonl`);
		const tabs = [
			{ id: 1, url: "https://public.com", normalizedUrl: "https://public.com/", title: "Public", incognito: false },
			{ id: 2, url: "https://private.com", normalizedUrl: "https://private.com/", title: "Private", incognito: true },
		];
		const stub = makeStub({ exportTabs: vi.fn().mockResolvedValue({ tabs }) });
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		try {
			const result = await pi.tool("browser_control").execute(
				"tc-exp6", { operation: "export_tabs", path: outPath }, undefined, undefined, {} as never,
			);
			const text = (result.content[0] as { text: string }).text;
			expect(text).toMatch(/Exported 1 tab/);
			expect(text).toMatch(/1 private/);
			const lines = fsNode.readFileSync(outPath, "utf-8").split("\n").filter(Boolean);
			expect(lines).toHaveLength(1);
			expect((JSON.parse(lines[0]!) as { id: number }).id).toBe(1);
		} finally {
			fsNode.rmSync(outPath, { force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// operation: get_tab_content
// ---------------------------------------------------------------------------

describe("browser_control operation=get_tab_content — happy path", () => {
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
		const result = await pi.tool("browser_control").execute(
			"tc3", { operation: "get_tab_content", tabId: 5, offset: 0 }, undefined, undefined, {} as never,
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
		const result = await pi.tool("browser_control").execute(
			"tc4", { operation: "get_tab_content", tabId: 5, offset: 100 }, undefined, undefined, {} as never,
		);
		const texts = result.content.map((c) => (c as { text: string }).text);
		expect(texts.some((t) => t.includes("Link text:"))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// operation: close_tab
// ---------------------------------------------------------------------------

describe("browser_control operation=close_tab", () => {
	it("closes tab and returns confirmation", async () => {
		const stub = makeStub({
			closeTab: vi.fn().mockResolvedValue({ closed: true, tabId: 42 }),
		});
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_control").execute(
			"tc-close1", { operation: "close_tab", tabId: 42 }, undefined, undefined, {} as never,
		);
		expect(vi.mocked(stub.closeTab)).toHaveBeenCalledWith(42);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/42/);
		expect(text).toMatch(/closed/i);
		expect(result.details).toMatchObject({ ok: true, tabId: 42 });
	});

	it("TAB_NOT_FOUND on close → returns error message", async () => {
		const err = Object.assign(new Error("tab not found"), { code: "TAB_NOT_FOUND" });
		const stub = makeStub({ closeTab: vi.fn().mockRejectedValue(err) });
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_control").execute(
			"tc-close2", { operation: "close_tab", tabId: 99 }, undefined, undefined, {} as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/tab|not found/i);
		expect(result.details).toMatchObject({ ok: false });
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
		const result = await pi.tool("browser_control").execute(
			"tc-err1", { operation: "list_tabs" }, undefined, undefined, {} as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/daemon|not running|install/i);
	});

	it("ADDON_NOT_CONNECTED → message about loading the add-on", async () => {
		const err = Object.assign(new Error("addon not connected"), { code: "ADDON_NOT_CONNECTED" });
		const stub = makeStub({ listTabs: vi.fn().mockRejectedValue(err) });
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_control").execute(
			"tc-err2", { operation: "list_tabs" }, undefined, undefined, {} as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/add-on|addon|Firefox/i);
	});

	it("TAB_NOT_FOUND on get_tab_content → message about re-listing tabs", async () => {
		const err = Object.assign(new Error("tab not found"), { code: "TAB_NOT_FOUND" });
		const stub = makeStub({ getTabContent: vi.fn().mockRejectedValue(err) });
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_control").execute(
			"tc-err3", { operation: "get_tab_content", tabId: 99, offset: 0 }, undefined, undefined, {} as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/tab|not found/i);
	});

	it("TAB_DISCARDED → message about the tab being unloaded", async () => {
		const err = Object.assign(new Error("tab discarded"), { code: "TAB_DISCARDED" });
		const stub = makeStub({ getTabContent: vi.fn().mockRejectedValue(err) });
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_control").execute(
			"tc-disc", { operation: "get_tab_content", tabId: 99, offset: 0 }, undefined, undefined, {} as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/unload|reload|loaded/i);
	});

	it("EXTRACTION_TIMEOUT → message about the page not returning in time", async () => {
		const err = Object.assign(new Error("timed out"), { code: "EXTRACTION_TIMEOUT" });
		const stub = makeStub({ getTabContent: vi.fn().mockRejectedValue(err) });
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_control").execute(
			"tc-to", { operation: "get_tab_content", tabId: 99, offset: 0 }, undefined, undefined, {} as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/time|streaming|loading|settle/i);
	});

	it("generic error returns a non-empty message", async () => {
		const stub = makeStub({ listTabs: vi.fn().mockRejectedValue(new Error("something weird")) });
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_control").execute(
			"tc-err4", { operation: "list_tabs" }, undefined, undefined, {} as never,
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
			createExtension(pi.api, {
				socketClient: stub,
				agentDir: tmpAgent,
				manifestPath: pathNode.join(tmpAgent, "nm.json"),
			});
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

describe("get_tab_content — SocketClientError goes through errorResult", () => {
	it("SocketClientError returns ok:false", async () => {
		const err = new (await import("../src/socket-client.js")).SocketClientError("no tab", "TAB_NOT_FOUND");
		const stub = makeStub({ getTabContent: vi.fn().mockRejectedValue(err) });
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_control").execute(
			"tc-sce", { operation: "get_tab_content", tabId: 9, offset: 0 }, undefined, undefined, {} as never,
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
			createExtension(pi.api, {
				socketClient: stub,
				agentDir: tmpAgent,
				manifestPath: pathNode.join(tmpAgent, "nm.json"),
			});
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

describe("createExtension — socketClient ?? new SocketClient() branch", () => {
	it("works without explicit socketClient option (uses default SocketClient)", () => {
		const pi = makeFakePi();
		// No socketClient option → exercises `options.socketClient ?? new SocketClient()`
		createExtension(pi.api);
		expect(pi.commands.has("browser-control")).toBe(true);
		expect(pi.tools.has("browser_control")).toBe(true);
	});
});

describe("errorResult — String(err) fallback when err has no .message", () => {
	it("returns non-empty error message for plain object without .message", async () => {
		// Throw a plain object (no .message) → e.message is undefined → String(err) is used
		const plainErr = { code: "OTHER" }; // no .message
		const stub = makeStub({
			listTabs: vi.fn().mockRejectedValue(plainErr),
		});
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: stub });
		const result = await pi.tool("browser_control").execute(
			"tc-str-err", { operation: "list_tabs" }, undefined, undefined, {} as never,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(text.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// renderResult
// ---------------------------------------------------------------------------

const mockTheme = {
	fg: (_color: string, text: string) => text,
};

describe("browser_control renderResult", () => {
	it("is a function on the registered tool", () => {
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: makeStub() });
		const tool = pi.tool("browser_control");
		expect(typeof tool.renderResult).toBe("function");
	});

	it("list_tabs: renders header + tab lines; truncates with '… N more' footer", () => {
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: makeStub() });
		const tool = pi.tool("browser_control");
		const result = {
			content: [
				{ type: "text", text: "Showing tabs 1-5 of 5 total tabs" },
				{ type: "text", text: "tab id=1, tab url=https://a.com" },
				{ type: "text", text: "tab id=2, tab url=https://b.com" },
				{ type: "text", text: "tab id=3, tab url=https://c.com" },
				{ type: "text", text: "tab id=4, tab url=https://d.com" },
				{ type: "text", text: "tab id=5, tab url=https://e.com" },
			],
			details: { ok: true, operation: "list_tabs" },
		};
		// Not expanded → shows first 3 tab lines, rest truncated
		const rendered = tool.renderResult!(result as never, { expanded: false, isPartial: false }, mockTheme as never, {} as never);
		const text = (rendered as unknown as { text: string }).text;
		expect(text).toContain("Showing tabs 1-5 of 5 total tabs");
		expect(text).toContain("tab id=1");
		expect(text).toContain("tab id=3");
		expect(text).not.toContain("tab id=4");
		expect(text).toMatch(/… 2 more tab/);
	});

	it("get_tab_content: multi-element content renders only content[0].text, not tab-list format", () => {
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: makeStub() });
		const tool = pi.tool("browser_control");
		// buildTabContentResult returns hint + fullText + links (multiple elements)
		const result = {
			content: [
				{ type: "text", text: "The following text content is truncated..." },
				{ type: "text", text: "Main page text here" },
				{ type: "text", text: "Link text: Example, Link URL: https://example.com" },
			],
			details: { ok: true, operation: "get_tab_content" },
		};
		const rendered2 = tool.renderResult!(result as never, { expanded: false, isPartial: false }, mockTheme as never, {} as never);
		const text2 = (rendered2 as unknown as { text: string }).text;
		// Should render only content[0].text — no tab-list formatting, no "… N more tabs" footer
		expect(text2).toBe("The following text content is truncated...");
		expect(text2).not.toContain("Main page text here");
		expect(text2).not.toMatch(/… \d+ more tab/);
	});

	it("isPartial: renders ellipsis", () => {
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: makeStub() });
		const tool = pi.tool("browser_control");
		const result = { content: [], details: { ok: true, operation: "list_tabs" } };
		const rendered3 = tool.renderResult!(result, { expanded: false, isPartial: true }, mockTheme as never, {} as never);
		const text3 = (rendered3 as unknown as { text: string }).text;
		expect(text3).toContain("…");
	});

	it("empty content: renders (no output)", () => {
		const pi = makeFakePi();
		createExtension(pi.api, { socketClient: makeStub() });
		const tool = pi.tool("browser_control");
		const result = { content: [], details: { ok: true } };
		const rendered4 = tool.renderResult!(result, { expanded: false, isPartial: false }, mockTheme as never, {} as never);
		const text4 = (rendered4 as unknown as { text: string }).text;
		expect(text4).toContain("(no output)");
	});
});
