import { describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionContext, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import createExtension from "../src/index.js";

/**
 * Minimal `ExtensionAPI` stub that tracks active tools, the registry,
 * and the registered session_start handler. Only the subset used by this
 * extension is implemented.
 */
function makeFakePi(initial: { all: ToolInfo[]; active: string[] }) {
	let active = new Set(initial.active);
	const registered: ToolDefinition[] = [];
	const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};

	const registerTool = vi.fn((t: ToolDefinition) => {
		registered.push(t);
		// Real pi: newly registered tools appear in getAllTools() AND become
		// callable without /reload, i.e. are added to the active set.
		initial.all = [...initial.all, { name: t.name, description: t.description } as ToolInfo];
		active.add(t.name);
	});
	const on = vi.fn((event: string, handler: (e: unknown, c: unknown) => unknown) => {
		handlers[event] = handler;
	});
	const getAllTools = vi.fn(() => initial.all);
	const getActiveTools = vi.fn(() => [...active]);
	const setActiveTools = vi.fn((names: string[]) => {
		active = new Set(names);
	});

	const api = { registerTool, on, getAllTools, getActiveTools, setActiveTools } as unknown as ExtensionAPI;

	return {
		api,
		registerTool,
		on,
		setActiveTools,
		get tool(): ToolDefinition {
			const t = registered.find((r) => r.name === "manage_tools");
			if (!t) throw new Error("manage_tools not registered");
			return t;
		},
		get active(): Set<string> {
			return active;
		},
		async fireSessionStart(ctx: unknown = makeCtx()) {
			const h = handlers["session_start"];
			if (!h) throw new Error("no session_start handler");
			await h({ reason: "startup" }, ctx);
		},
	};
}

function makeCtx() {
	return {
		hasUI: true,
		ui: { notify: vi.fn() },
		cwd: "/tmp",
	} as unknown as ExtensionContext;
}

const BASE_TOOLS: ToolInfo[] = [
	{ name: "read", description: "Read a file" } as ToolInfo,
	{ name: "bash", description: "Run a shell command" } as ToolInfo,
	{ name: "edit", description: "Edit a file" } as ToolInfo,
	{ name: "write", description: "Write a file" } as ToolInfo,
];

describe("extension registration", () => {
	it("registers exactly one tool named manage_tools", () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		expect(pi.registerTool.mock.calls).toHaveLength(1);
		const t = pi.tool;
		expect(t.name).toBe("manage_tools");
		expect(typeof t.description).toBe("string");
		expect(t.description.length).toBeGreaterThan(0);
		expect(typeof t.promptSnippet).toBe("string");
		expect(Array.isArray(t.promptGuidelines)).toBe(true);
		expect(typeof t.execute).toBe("function");
	});

	it("subscribes to session_start so it can snapshot the startup active set", () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		expect(pi.on.mock.calls.some((c) => c[0] === "session_start")).toBe(true);
	});
});

async function exec(tool: ToolDefinition, params: unknown) {
	return tool.execute("tc", params, undefined, undefined, makeCtx());
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
	const first = result.content[0];
	if (!first || first.type !== "text") return "";
	return first.text ?? "";
}

describe("tool.execute — list", () => {
	it("returns all tools with their active state and descriptions", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "list" });
		const txt = textOf(res);
		expect(txt).toContain("read");
		expect(txt).toContain("bash");
		expect(txt).toContain("edit");
		expect(txt).toContain("manage_tools");
		// Active state must be reported.
		expect(txt.toLowerCase()).toMatch(/active/);
	});
});

describe("tool.execute — activate", () => {
	it("activates multiple tools in one call", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "activate", tools: ["edit", "write"] });
		expect(pi.active).toEqual(new Set(["read", "manage_tools", "edit", "write"]));
	});

	it("reports ignored unknown names in the result text", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "activate", tools: ["edit", "nosuch"] });
		const txt = textOf(res);
		expect(txt).toMatch(/nosuch/);
		expect(pi.active.has("edit")).toBe(true);
		expect(pi.active.has("nosuch")).toBe(false);
	});
});

describe("tool.execute — deactivate", () => {
	it("deactivates multiple tools in one call", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash", "edit", "write"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "deactivate", tools: ["edit", "write"] });
		expect(pi.active.has("edit")).toBe(false);
		expect(pi.active.has("write")).toBe(false);
		expect(pi.active.has("read")).toBe(true);
		expect(pi.active.has("bash")).toBe(true);
	});

	it("never deactivates manage_tools, even if requested", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "deactivate", tools: ["manage_tools"] });
		expect(pi.active.has("manage_tools")).toBe(true);
		expect(textOf(res).toLowerCase()).toMatch(/protect/);
	});
});

// ---------------------------------------------------------------------------
// Helper to pull the typed details out of an execute result.
// ---------------------------------------------------------------------------

interface DetailsShape {
	action: string;
	active: string[];
	total: number;
	rows: { name: string; active: boolean; description: string }[];
	ignoredUnknown: string[];
	ignoredProtected: string[];
}

function detailsOf(result: { details?: unknown }): DetailsShape {
	return result.details as DetailsShape;
}

describe("tool.execute — details (TUI renderer data)", () => {
	it("details.total equals the number of registered tools", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		// BASE_TOOLS (4) + manage_tools (1) = 5
		const res = await exec(pi.tool, { action: "list" });
		expect(detailsOf(res).total).toBe(5);
	});

	it("details.rows has one entry per tool with correct active flag", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "list" });
		const d = detailsOf(res);
		expect(d.rows).toHaveLength(d.total);
		expect(d.rows.find((r) => r.name === "read")?.active).toBe(true);
		expect(d.rows.find((r) => r.name === "edit")?.active).toBe(false);
	});

	it("details.rows carries the tool description", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "list" });
		const bashRow = detailsOf(res).rows.find((r) => r.name === "bash");
		expect(bashRow?.description).toBe("Run a shell command");
	});

	it("details.total and rows reflect state after activate", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "activate", tools: ["edit"] });
		const d = detailsOf(res);
		expect(d.total).toBe(5);
		expect(d.rows.find((r) => r.name === "edit")?.active).toBe(true);
	});

	it("details.rows reflects deactivated tools", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash", "edit"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "deactivate", tools: ["bash"] });
		expect(detailsOf(res).rows.find((r) => r.name === "bash")?.active).toBe(false);
	});
});

describe("tool.execute — reset", () => {
	it("restores the active set captured at session_start", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		// session_start snapshots {read, bash, manage_tools}.
		await pi.fireSessionStart();
		// LLM wanders off.
		await exec(pi.tool, { action: "activate", tools: ["edit", "write"] });
		expect(pi.active).toEqual(new Set(["read", "bash", "manage_tools", "edit", "write"]));
		// Reset must put it back.
		await exec(pi.tool, { action: "reset" });
		expect(pi.active).toEqual(new Set(["read", "bash", "manage_tools"]));
	});

	it("re-snapshots on a subsequent session_start (new/resume/fork)", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		// Simulate session switch: previous session ended with a smaller active set
		// that is now being restored into pi before session_start fires again.
		pi.setActiveTools(["read"]);
		await pi.fireSessionStart();
		// Wander, then reset — should land on the *new* snapshot.
		await exec(pi.tool, { action: "activate", tools: ["edit", "write"] });
		await exec(pi.tool, { action: "reset" });
		expect(pi.active).toEqual(new Set(["read", "manage_tools"]));
	});
});
