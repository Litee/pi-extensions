import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	AgentEndEvent,
	AgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import createExtension from "../src/index.js";

/**
 * Minimal `ExtensionAPI` stub that tracks active tools, the registry, the
 * registered event handlers, and `sendMessage` calls. Only the subset used
 * by this extension is implemented.
 */
function makeFakePi(initial: { all: ToolInfo[]; active: string[] }) {
	let active = new Set(initial.active);
	const registered: ToolDefinition[] = [];
	const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};

	const registerTool = vi.fn((t: ToolDefinition) => {
		registered.push(t);
		// Real pi: newly registered tools appear in getAllTools() AND become
		// callable without /reload, i.e. are added to the active set.
		initial.all = [...initial.all, { name: t.name, description: t.description } as ToolInfo];
		active.add(t.name);
	});
	const on = vi.fn((event: string, handler: (e: unknown, c: unknown) => unknown) => {
		(handlers[event] ??= []).push(handler);
	});
	const getAllTools = vi.fn(() => initial.all);
	const getActiveTools = vi.fn(() => [...active]);
	const setActiveTools = vi.fn((names: string[]) => {
		active = new Set(names);
	});
	const sendMessage = vi.fn();
	const sendUserMessage = vi.fn();
	const appendEntry = vi.fn();

	const api = {
		registerTool,
		on,
		getAllTools,
		getActiveTools,
		setActiveTools,
		sendMessage,
		sendUserMessage,
		appendEntry,
	} as unknown as ExtensionAPI;

	async function fire<T>(name: string, event: T, ctx: unknown): Promise<void> {
		const list = handlers[name];
		if (!list || list.length === 0) {
			throw new Error(`no handler registered for ${name}`);
		}
		for (const h of list) {
			await h(event, ctx);
		}
	}

	return {
		api,
		registerTool,
		on,
		setActiveTools,
		sendMessage,
		get tool(): ToolDefinition {
			const t = registered.find((r) => r.name === "manage_tools");
			if (!t) throw new Error("manage_tools not registered");
			return t;
		},
		get active(): Set<string> {
			return active;
		},
		async fireSessionStart(ctx: unknown = makeCtx()) {
			await fire("session_start", { reason: "startup" }, ctx);
		},
		async fireAgentStart(ctx: unknown = makeCtx()) {
			const ev: AgentStartEvent = { type: "agent_start" };
			await fire("agent_start", ev, ctx);
		},
		async fireAgentEnd(messages: AgentMessage[], ctx: unknown = makeCtx()) {
			const ev: AgentEndEvent = { type: "agent_end", messages };
			await fire("agent_end", ev, ctx);
		},
	};
}

function makeCtx(opts?: { isIdle?: boolean; selectedTools?: string[]; noGetSystemPromptOptions?: boolean }) {
	const base: Record<string, unknown> = {
		hasUI: true,
		ui: { notify: vi.fn() },
		cwd: "/tmp",
		isIdle: vi.fn(() => opts?.isIdle ?? true),
	};
	if (!opts?.noGetSystemPromptOptions) {
		base["getSystemPromptOptions"] = vi.fn(() => ({
			selectedTools: opts?.selectedTools ?? [],
			cwd: "/tmp",
		}));
	}
	return base as unknown as ExtensionContext;
}

const BASE_TOOLS: ToolInfo[] = [
	{ name: "read", description: "Read a file" } as ToolInfo,
	{ name: "bash", description: "Run a shell command" } as ToolInfo,
	{ name: "edit", description: "Edit a file" } as ToolInfo,
	{ name: "write", description: "Write a file" } as ToolInfo,
];

// ---------------------------------------------------------------------------
// Helpers to build minimal AgentMessage shapes for the tests.
// ---------------------------------------------------------------------------

function asstWithToolCall(name: string, args: object = {}, stopReason = "toolUse"): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `tc_${name}_${Math.random()}`, name, arguments: args }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: 0,
	} as unknown as AgentMessage;
}

function asstText(text: string, stopReason = "stop"): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: 0,
	} as unknown as AgentMessage;
}

// ===========================================================================
// Existing behaviour — registration, execute(list/activate/deactivate/reset).
// ===========================================================================

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

	it("subscribes to session_start, agent_start and agent_end", () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		const events = pi.on.mock.calls.map((c) => c[0]);
		expect(events).toContain("session_start");
		expect(events).toContain("agent_start");
		expect(events).toContain("agent_end");
	});
});

async function exec(tool: ToolDefinition, params: unknown, ctx?: ExtensionContext) {
	return tool.execute("tc", params, undefined, undefined, ctx ?? makeCtx());
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
	const first = result.content[0];
	if (!first || first.type !== "text") return "";
	return first.text ?? "";
}

// ===========================================================================
// Fake-timer setup: the agent_end handler defers sendMessage via setTimeout(0)
// so that it runs after finishRun() has cleared isStreaming. All tests that
// check sendMessage must call vi.runAllTimers() to flush that macrotask.
// ===========================================================================
beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

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
		expect(txt.toLowerCase()).toMatch(/active/);
	});

	it("sets terminate:true and queues a refresh even on pure list", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = (await exec(pi.tool, { action: "list" })) as { terminate?: boolean };
		expect(res.terminate).toBe(true);
		await pi.fireAgentEnd([asstWithToolCall("manage_tools")]);
		vi.runAllTimers();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const { msg, opts } = firstSendMessageCall(pi);
		expect(msg.customType).toBe("pi-tools-management-tool:refresh");
		expect(msg.display).toBe(false);
		expect(msg.content).toMatch(/Continue\./);
		expect(opts).toEqual({ triggerTurn: true });
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

	it("returns terminate:true when the activate flipped a tool on", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = (await exec(pi.tool, {
			action: "activate",
			tools: ["edit"],
		})) as { terminate?: boolean };
		expect(res.terminate).toBe(true);
	});

	it("sets terminate:true even when activate is a no-op (already active)", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "edit"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = (await exec(pi.tool, {
			action: "activate",
			tools: ["edit"],
		})) as { terminate?: boolean };
		expect(res.terminate).toBe(true);
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

	it("sets terminate:true and queues a refresh on deactivate", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash", "edit"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = (await exec(pi.tool, { action: "deactivate", tools: ["edit"] })) as {
			terminate?: boolean;
		};
		expect(res.terminate).toBe(true);
		await pi.fireAgentEnd([asstWithToolCall("manage_tools")]);
		vi.runAllTimers();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const { msg } = firstSendMessageCall(pi);
		expect(msg.content).toMatch(/Continue\./);
	});
});

interface DetailsShape {
	action: string;
	active: string[];
	total: number;
	rows: { name: string; active: boolean; inPrompt: boolean; description: string }[];
	changed: { activated: string[]; deactivated: string[] };
	ignoredUnknown: string[];
	ignoredProtected: string[];
}
// Minimal fake theme — every styler is identity so the rendered Text contains
// the raw substrings we want to assert on.
function fakeTheme() {
	return {
		fg: (_role: string, s: string) => s,
		bold: (s: string) => s,
	} as unknown as Parameters<NonNullable<ToolDefinition["renderResult"]>>[2];
}

function renderText(
	tool: ToolDefinition,
	result: unknown,
	opts: { expanded: boolean; isPartial?: boolean } = { expanded: true },
): string {
	const rr = tool.renderResult;
	if (!rr) throw new Error("renderResult not defined");
	const comp = rr(
		result as Parameters<typeof rr>[0],
		{ expanded: opts.expanded, isPartial: opts.isPartial ?? false },
		fakeTheme(),
		{} as Parameters<typeof rr>[3],
	);
	const lines = (comp as { render(w: number): string[] }).render(1000);
	return lines.join("\n");
}

function detailsOf(result: { details?: unknown }): DetailsShape {
	return result.details as DetailsShape;
}

// -- issue #0003: expanded mode shows only changed tools, not all tools --
describe("tool.execute — details.changed (#0003)", () => {
	it("list: changed is empty (no flips)", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "list" });
		const d = detailsOf(res);
		expect(d.changed).toEqual({ activated: [], deactivated: [] });
	});

	it("activate: changed.activated lists only newly-flipped tools", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "edit"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		// edit is already active, write is new, nosuch is ignored.
		const res = await exec(pi.tool, { action: "activate", tools: ["edit", "write", "nosuch"] });
		const d = detailsOf(res);
		expect(d.changed.activated).toEqual(["write"]);
		expect(d.changed.deactivated).toEqual([]);
	});

	it("deactivate: changed.deactivated lists only newly-flipped tools", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash", "edit"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		// edit gets flipped off; write was never on; manage_tools is protected.
		const res = await exec(pi.tool, {
			action: "deactivate",
			tools: ["edit", "write", "manage_tools"],
		});
		const d = detailsOf(res);
		expect(d.changed.deactivated).toEqual(["edit"]);
		expect(d.changed.activated).toEqual([]);
	});

	it("reset: changed reflects both directions of the diff", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "deactivate", tools: ["bash"] });
		await exec(pi.tool, { action: "activate", tools: ["edit"] });
		const res = await exec(pi.tool, { action: "reset" });
		const d = detailsOf(res);
		expect(d.changed.activated.sort()).toEqual(["bash"]);
		expect(d.changed.deactivated.sort()).toEqual(["edit"]);
	});
});

describe("renderResult — expanded mode shows only changed tools (#0003)", () => {
	it("list: shows full tool roster", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "list" });
		const out = renderText(pi.tool, res, { expanded: true });
		expect(out).toContain("read");
		expect(out).toContain("bash");
		expect(out).toContain("edit");
		expect(out).toContain("write");
		expect(out).toContain("manage_tools");
	});

	it("activate: shows only the activated tools (not the full roster)", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "activate", tools: ["edit"] });
		const out = renderText(pi.tool, res, { expanded: true });
		expect(out).toMatch(/Activated/i);
		expect(out).toContain("edit");
		// 'bash' and 'write' were never touched — must NOT appear in expanded output.
		expect(out).not.toContain("bash");
		expect(out).not.toContain("write");
	});

	it("deactivate: shows only the deactivated tools (not the full roster)", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash", "edit"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "deactivate", tools: ["edit"] });
		const out = renderText(pi.tool, res, { expanded: true });
		expect(out).toMatch(/Deactivated/i);
		expect(out).toContain("edit");
		expect(out).not.toContain("bash");
		expect(out).not.toContain("read");
	});

	it("reset: shows both activated and deactivated diffs, not the full roster", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "deactivate", tools: ["bash"] });
		await exec(pi.tool, { action: "activate", tools: ["edit"] });
		const res = await exec(pi.tool, { action: "reset" });
		const out = renderText(pi.tool, res, { expanded: true });
		expect(out).toContain("bash"); // re-activated
		expect(out).toContain("edit"); // re-deactivated
		// 'write' was never flipped — must not appear.
		expect(out).not.toContain("write");
	});

	it("activate no-op: shows an explicit 'no changes' line, not the full roster", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "edit"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "activate", tools: ["edit"] });
		const out = renderText(pi.tool, res, { expanded: true });
		expect(out.toLowerCase()).toMatch(/no changes/);
		expect(out).not.toContain("bash");
		expect(out).not.toContain("write");
	});

	it("activate with ignored unknown: still surfaces the warning line in expanded mode", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, {
			action: "activate",
			tools: ["edit", "nosuch"],
		});
		const out = renderText(pi.tool, res, { expanded: true });
		expect(out).toContain("edit");
		expect(out).toMatch(/Ignored unknown:.*nosuch/);
	});
});

describe("tool.execute — details (TUI renderer data)", () => {
	it("details.total equals the number of registered tools", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "list" });
		// BASE_TOOLS (4) + manage_tools (1) = 5
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
});

describe("tool.execute — reset", () => {
	it("restores the active set captured at session_start", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "activate", tools: ["edit", "write"] });
		expect(pi.active).toEqual(new Set(["read", "bash", "manage_tools", "edit", "write"]));
		await exec(pi.tool, { action: "reset" });
		expect(pi.active).toEqual(new Set(["read", "bash", "manage_tools"]));
	});

	it("re-snapshots on a subsequent session_start (new/resume/fork)", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		pi.setActiveTools(["read"]);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "activate", tools: ["edit", "write"] });
		await exec(pi.tool, { action: "reset" });
		expect(pi.active).toEqual(new Set(["read", "manage_tools"]));
	});

	it("returns terminate:true when reset re-activates a previously-deactivated tool", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		// LLM disables bash, then resets — reset flips bash back ON.
		await exec(pi.tool, { action: "deactivate", tools: ["bash"] });
		const res = (await exec(pi.tool, { action: "reset" })) as { terminate?: boolean };
		expect(res.terminate).toBe(true);
	});

	it("sets terminate:true even when reset is a no-op (state already matches startup)", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = (await exec(pi.tool, { action: "reset" })) as { terminate?: boolean };
		expect(res.terminate).toBe(true);
	});
});

interface RefreshMsg {
	customType: string;
	content: string;
	display: boolean;
}

function firstSendMessageCall(pi: { sendMessage: { mock: { calls: unknown[][] } } }): {
	msg: RefreshMsg;
	opts: { triggerTurn?: boolean; deliverAs?: string } | undefined;
} {
	const call = pi.sendMessage.mock.calls[0];
	if (!call) throw new Error("sendMessage was not called");
	return {
		msg: call[0] as RefreshMsg,
		opts: call[1] as { triggerTurn?: boolean; deliverAs?: string } | undefined,
	};
}

// ===========================================================================
// Auto-continue — agent_end listener behaviour.
// ===========================================================================

describe("auto-continue — happy path", () => {
	it("fires pi.sendMessage with generic Continue message after list", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "list" });
		await pi.fireAgentEnd([asstWithToolCall("manage_tools", { action: "list" })]);
		vi.runAllTimers();

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const { msg, opts } = firstSendMessageCall(pi);
		expect(msg.customType).toBe("pi-tools-management-tool:refresh");
		expect(msg.display).toBe(false);
		expect(msg.content).toMatch(/Continue\./);
		// No specific tool names in the generic message
		expect(msg.content).not.toMatch(/Newly available tools/);
		expect(opts).toEqual({ triggerTurn: true });
	});

	it("fires pi.sendMessage with generic Continue message after no-op activate", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "edit"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "activate", tools: ["edit"] }); // no-op: already active
		await pi.fireAgentEnd([asstWithToolCall("manage_tools", { action: "activate" })]);
		vi.runAllTimers();

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const { msg } = firstSendMessageCall(pi);
		expect(msg.content).toMatch(/Continue\./);
		expect(msg.content).not.toMatch(/Newly available tools/);
	});

	it("fires pi.sendMessage with tool-specific message after successful activate", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "activate", tools: ["edit"] });
		await pi.fireAgentEnd([asstWithToolCall("manage_tools", { action: "activate" })]);
		vi.runAllTimers();

		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const { msg, opts } = firstSendMessageCall(pi);
		expect(msg.customType).toBe("pi-tools-management-tool:refresh");
		expect(msg.display).toBe(false);
		expect(msg.content).toMatch(/edit/);
		expect(msg.content).toMatch(/Continue\./);
		expect(opts).toEqual({ triggerTurn: true });
	});

	it("lists newly available tools in alphabetical order in the refresh content", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "activate", tools: ["write", "edit"] });
		await pi.fireAgentEnd([asstWithToolCall("manage_tools")]);
		vi.runAllTimers();
		const { msg } = firstSendMessageCall(pi);
		expect(msg.content).toMatch(/edit, write/);
	});

	it("clears pendingRefresh after agent_end, so a second agent_end does not refire", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "activate", tools: ["edit"] });
		await pi.fireAgentEnd([asstWithToolCall("manage_tools")]);
		vi.runAllTimers();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		await pi.fireAgentEnd([asstText("done")]);
		vi.runAllTimers();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("does NOT fire when manage_tools was never called in the run", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await pi.fireAgentEnd([asstText("done")]);
		vi.runAllTimers();
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});
});

describe("auto-continue — accumulation across multiple manage_tools calls", () => {
	it("unions added names from two activates in the same run", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "activate", tools: ["edit"] });
		await exec(pi.tool, { action: "activate", tools: ["write"] });
		await pi.fireAgentEnd([
			asstWithToolCall("manage_tools"),
			asstWithToolCall("manage_tools"),
		]);
		vi.runAllTimers();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const { msg } = firstSendMessageCall(pi);
		expect(msg.content).toMatch(/edit, write/);
	});
});

describe("auto-continue — filter against live active set", () => {
	it("activate-then-deactivate-same-tool same run fires a refresh (no new tools, but call happened)", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "activate", tools: ["edit"] });
		await exec(pi.tool, { action: "deactivate", tools: ["edit"] });
		await pi.fireAgentEnd([
			asstWithToolCall("manage_tools"),
			asstWithToolCall("manage_tools"),
		]);
		// refresh fires because manage_tools was called (pendingRefresh non-null),
		// but edit is no longer active so trulyAvailable is empty → generic message
		vi.runAllTimers();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const { msg } = firstSendMessageCall(pi);
		expect(msg.content).not.toMatch(/\bedit\b/);
		expect(msg.content).toMatch(/Continue\./);
	});

	it("partial filter: activate [edit, write], deactivate [edit] → refresh mentions only write", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "activate", tools: ["edit", "write"] });
		await exec(pi.tool, { action: "deactivate", tools: ["edit"] });
		await pi.fireAgentEnd([
			asstWithToolCall("manage_tools"),
			asstWithToolCall("manage_tools"),
		]);
		vi.runAllTimers();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const { msg } = firstSendMessageCall(pi);
		expect(msg.content).toMatch(/write/);
		expect(msg.content).not.toMatch(/\bedit\b/);
	});
});

describe("auto-continue — stop-reason filter", () => {
	for (const sr of ["error", "aborted", "length"]) {
		it(`does NOT fire when last assistant stopReason is "${sr}"`, async () => {
			const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
			createExtension(pi.api);
			await pi.fireSessionStart();
			await exec(pi.tool, { action: "activate", tools: ["edit"] });
			await pi.fireAgentEnd([asstWithToolCall("manage_tools", {}, sr)]);
			vi.runAllTimers();
			expect(pi.sendMessage).not.toHaveBeenCalled();
		});
	}

	for (const sr of ["stop", "toolUse"]) {
		it(`fires when last assistant stopReason is "${sr}"`, async () => {
			const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
			createExtension(pi.api);
			await pi.fireSessionStart();
			await exec(pi.tool, { action: "activate", tools: ["edit"] });
			await pi.fireAgentEnd([asstWithToolCall("manage_tools", {}, sr)]);
			vi.runAllTimers();
			expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		});
	}
});

describe("auto-continue — race / extension-collision guard", () => {
	it("does NOT fire when ctx.isIdle() returns false", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "activate", tools: ["edit"] });
		await pi.fireAgentEnd([asstWithToolCall("manage_tools")], makeCtx({ isIdle: false }));
		vi.runAllTimers();
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("clears pendingRefresh even when isIdle()===false (no later refire)", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "activate", tools: ["edit"] });
		await pi.fireAgentEnd([asstWithToolCall("manage_tools")], makeCtx({ isIdle: false }));
		vi.runAllTimers();
		await pi.fireAgentEnd([asstText("done")]);
		vi.runAllTimers();
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});
});

describe("auto-continue — loop guard (LLM already used new tool)", () => {
	it("suppresses refresh when the LLM called the new tool AFTER the last manage_tools call", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "activate", tools: ["edit"] });
		// In the real run the LLM would not be able to call edit on the same
		// turn, but the loop guard's contract is "if it shows up after the last
		// manage_tools toolCall, skip" — so emulate that.
		await pi.fireAgentEnd([
			asstWithToolCall("manage_tools"),
			asstWithToolCall("edit"),
		]);
		vi.runAllTimers();
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("does NOT suppress when empty trulyAvailable (list path) — loop guard is inert", async () => {
		// When manage_tools is called for list/deactivate/no-op, trulyAvailable is
		// empty and calledAnyAfterLastActivation cannot suppress. Even if the LLM
		// called another tool after manage_tools, the refresh still fires.
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "edit"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "list" });
		// Simulate: after list, LLM used edit (already active — not a newly-activated tool).
		await pi.fireAgentEnd([
			asstWithToolCall("manage_tools"),
			asstWithToolCall("edit"),
		]);
		// Refresh fires because trulyAvailable is empty, loop guard is inert.
		vi.runAllTimers();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const { msg } = firstSendMessageCall(pi);
		expect(msg.content).toMatch(/Continue\./);
	});

	it("does NOT suppress when the matching toolCall happened BEFORE the last manage_tools call", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "edit"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		// Earlier in the run, edit was already active and got called.
		// Then it was deactivated. Then re-activated.
		await exec(pi.tool, { action: "deactivate", tools: ["edit"] });
		await exec(pi.tool, { action: "activate", tools: ["edit"] });
		await pi.fireAgentEnd([
			asstWithToolCall("edit"), // earlier — must NOT count
			asstWithToolCall("manage_tools"), // deactivate
			asstWithToolCall("manage_tools"), // re-activate (the "last")
		]);
		vi.runAllTimers();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});
});

describe("auto-continue — batched manage_tools (with other tools)", () => {
	it("fires refresh at agent_end even when manage_tools was batched with another tool (list path)", async () => {
		// When manage_tools runs alongside another tool, `terminate:true` is
		// ignored by the loop (it requires ALL batch members to set it). The run
		// continues naturally and agent_end fires the refresh.
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "edit"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "list" });
		// Simulate a run where manage_tools and read were batched together.
		await pi.fireAgentEnd([
			asstWithToolCall("manage_tools"),
			asstWithToolCall("read"),
		]);
		vi.runAllTimers();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const { msg, opts } = firstSendMessageCall(pi);
		expect(msg.customType).toBe("pi-tools-management-tool:refresh");
		expect(opts).toEqual({ triggerTurn: true });
	});

	it("fires refresh with newly-available tools when batched with another tool (activate path)", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "activate", tools: ["edit"] });
		await pi.fireAgentEnd([
			asstWithToolCall("manage_tools"),
			asstWithToolCall("read"),
		]);
		vi.runAllTimers();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const { msg } = firstSendMessageCall(pi);
		expect(msg.content).toMatch(/edit/);
		expect(msg.content).toMatch(/Newly available tools/);
	});
});

describe("auto-continue — counter cap", () => {
	it("suppresses and notifies after MAX_AUTO_REFRESHES consecutive auto-refreshes", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();

		// Three successful auto-refreshes (the cap is 3).
		for (let i = 0; i < 3; i++) {
			// Each "run" must start with an agent_start that does NOT reset
			// the counter — i.e. lastWasAutoRefresh is true going in.
			if (i > 0) await pi.fireAgentStart();
			// activate a different tool each cycle
			const tool = ["edit", "write", "bash"][i]!;
			// reset to make the activate non-no-op each cycle
			await exec(pi.tool, { action: "deactivate", tools: [tool] });
			await exec(pi.tool, { action: "activate", tools: [tool] });
			await pi.fireAgentEnd([asstWithToolCall("manage_tools")]);
			// Run timers inside the loop so lastWasAutoRefresh is set before
			// the next fireAgentStart call.
			vi.runAllTimers();
		}
		expect(pi.sendMessage).toHaveBeenCalledTimes(3);

		// Fourth run: counter is at the cap; refresh should be suppressed.
		await pi.fireAgentStart();
		await exec(pi.tool, { action: "deactivate", tools: ["bash"] });
		await exec(pi.tool, { action: "activate", tools: ["bash"] });
		const ctx = makeCtx();
		await pi.fireAgentEnd([asstWithToolCall("manage_tools")], ctx);
		vi.runAllTimers(); // timer not queued (cap check bails before setTimeout)
		expect(pi.sendMessage).toHaveBeenCalledTimes(3);
		// Notify must surface to the user.
		const notify = (ctx as unknown as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify;
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]?.[0]).toMatch(/auto-continue suppressed/i);
	});

	it("resets the counter on a user-initiated agent_start (lastWasAutoRefresh false)", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();

		// 3 cycles to hit the cap.
		for (let i = 0; i < 3; i++) {
			if (i > 0) await pi.fireAgentStart(); // chained → keep counter
			const tool = ["edit", "write", "bash"][i]!;
			await exec(pi.tool, { action: "deactivate", tools: [tool] });
			await exec(pi.tool, { action: "activate", tools: [tool] });
			await pi.fireAgentEnd([asstWithToolCall("manage_tools")]);
			vi.runAllTimers(); // flush so lastWasAutoRefresh is set before next fireAgentStart
		}
		expect(pi.sendMessage).toHaveBeenCalledTimes(3);

		// Simulate a fresh user prompt
		await pi.fireAgentStart(); // consumes lastWasAutoRefresh from cycle 3
		await pi.fireAgentStart(); // user-initiated — resets counter

		// Now another auto-refresh cycle should succeed.
		await exec(pi.tool, { action: "deactivate", tools: ["edit"] });
		await exec(pi.tool, { action: "activate", tools: ["edit"] });
		await pi.fireAgentEnd([asstWithToolCall("manage_tools")]);
		vi.runAllTimers();
		expect(pi.sendMessage).toHaveBeenCalledTimes(4);
	});
});

// ===========================================================================
// renderResult collapse threshold (#0001)
// ===========================================================================

describe("renderResult — collapse threshold (#0001)", () => {
	it("activate 1 tool: expanded=false renders 'Activated:' immediately (no ctrl+o)", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "activate", tools: ["edit"] });
		const out = renderText(pi.tool, res, { expanded: false });
		expect(out).toContain("Activated:");
		expect(out).not.toContain("ctrl+o");
	});

	it("activate 2 tools: expanded=false renders 'Activated:' immediately (no ctrl+o)", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "activate", tools: ["edit", "write"] });
		const out = renderText(pi.tool, res, { expanded: false });
		expect(out).toContain("Activated:");
		expect(out).not.toContain("ctrl+o");
	});

	it("list: expanded=false still shows ctrl+o hint", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "list" });
		const out = renderText(pi.tool, res, { expanded: false });
		expect(out).toContain("ctrl+o");
	});

	it("activate many tools (large output): expanded=false shows ctrl+o hint", async () => {
		// 20 tools with long names → diffText will exceed 400 chars.
		const manyTools: ToolInfo[] = Array.from({ length: 20 }, (_, i) =>
			({ name: `very_long_tool_name_${String(i).padStart(2, "0")}`, description: "desc" }) as ToolInfo,
		);
		const pi = makeFakePi({ all: [...BASE_TOOLS, ...manyTools], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "activate", tools: manyTools.map((t) => t.name) });
		const out = renderText(pi.tool, res, { expanded: false });
		expect(out).toContain("ctrl+o");
	});
});

describe("auto-continue — session_start resets state", () => {
	it("clears pendingRefresh on a fresh session_start", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "activate", tools: ["edit"] });
		// New session_start arrives before the agent_end (e.g. session switch).
		await pi.fireSessionStart();
		await pi.fireAgentEnd([asstWithToolCall("manage_tools")]);
		vi.runAllTimers();
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("clears the auto-refresh counter on session_start", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();

		// Burn the counter to the cap.
		for (let i = 0; i < 3; i++) {
			if (i > 0) await pi.fireAgentStart();
			const tool = ["edit", "write", "bash"][i]!;
			await exec(pi.tool, { action: "deactivate", tools: [tool] });
			await exec(pi.tool, { action: "activate", tools: [tool] });
			await pi.fireAgentEnd([asstWithToolCall("manage_tools")]);
			vi.runAllTimers();
		}
		expect(pi.sendMessage).toHaveBeenCalledTimes(3);

		// session_start should reset the counter so the next refresh fires.
		await pi.fireSessionStart();
		// All five tools are active by now (cycles left edit/write/bash on);
		// deactivate one first so the next activate is a real flip.
		await exec(pi.tool, { action: "deactivate", tools: ["edit"] });
		await exec(pi.tool, { action: "activate", tools: ["edit"] });
		await pi.fireAgentEnd([asstWithToolCall("manage_tools")]);
		vi.runAllTimers();
		expect(pi.sendMessage).toHaveBeenCalledTimes(4);
	});
});

// ===========================================================================
// prompt-diff markers ([x] / [~] / [ ]) — issue #0002
// ===========================================================================

describe("list — prompt-diff markers (#0002)", () => {
	it("degrades gracefully when getSystemPromptOptions is absent (all active tools show [~])", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const ctx = makeCtx({ noGetSystemPromptOptions: true });
		const res = await exec(pi.tool, { action: "list" }, ctx);
		// Must return a valid AgentToolResult (no crash, no malformed result)
		const txt = textOf(res);
		expect(txt).toBeTruthy();
		// Active tools show [~] (in registry, not in prompt) rather than erroring
		expect(txt).toContain("[~] read");
		expect(txt).toContain("[~] bash");
		expect(txt).toContain("[ ] edit");
	});

	it("active-in-registry but missing from selectedTools shows [~] in text output", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		// read is in registry + in prompt, bash is active but NOT in prompt
		const ctx = makeCtx({ selectedTools: ["read", "manage_tools"] });
		const res = await exec(pi.tool, { action: "list" }, ctx);
		const txt = textOf(res);
		expect(txt).toContain("[x] read");
		expect(txt).toContain("[~] bash");
		expect(txt).toContain("[ ] edit");
	});

	it("details.rows carries inPrompt flag correctly", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const ctx = makeCtx({ selectedTools: ["read"] });
		const res = await exec(pi.tool, { action: "list" }, ctx);
		const d = detailsOf(res);
		expect(d.rows.find((r) => r.name === "read")?.inPrompt).toBe(true);
		expect(d.rows.find((r) => r.name === "bash")?.inPrompt).toBe(false);
		expect(d.rows.find((r) => r.name === "edit")?.inPrompt).toBe(false);
	});

	it("when selectedTools is empty array, all active tools show [~]", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const ctx = makeCtx({ selectedTools: [] });
		const res = await exec(pi.tool, { action: "list" }, ctx);
		const txt = textOf(res);
		expect(txt).toContain("[~] bash");
		expect(txt).toContain("[~] read");
		expect(txt).not.toContain("[x]");
	});

	it("when all active tools are in selectedTools, all show [x] (no [~])", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const ctx = makeCtx({ selectedTools: ["read", "bash", "manage_tools"] });
		const res = await exec(pi.tool, { action: "list" }, ctx);
		const txt = textOf(res);
		expect(txt).toContain("[x] bash");
		expect(txt).toContain("[x] read");
		expect(txt).not.toContain("[~]");
	});
});

describe("renderResult — prompt-diff markers in TUI (#0002)", () => {
	it("shows [~] for tool active in registry but not in system prompt", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		// bash is active but not in selectedTools
		const ctx = makeCtx({ selectedTools: ["read", "manage_tools"] });
		const res = await exec(pi.tool, { action: "list" }, ctx);
		const out = renderText(pi.tool, res, { expanded: true });
		expect(out).toContain("[x]"); // at least read
		expect(out).toContain("[~]"); // bash
		expect(out).toContain("bash");
	});

	it("shows [x] for tool active in registry AND in system prompt", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const ctx = makeCtx({ selectedTools: ["read", "bash", "manage_tools"] });
		const res = await exec(pi.tool, { action: "list" }, ctx);
		const out = renderText(pi.tool, res, { expanded: true });
		expect(out).toContain("[x]");
		expect(out).not.toContain("[~]");
	});

	it("degrades gracefully when getSystemPromptOptions is absent", async () => {
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const ctx = makeCtx({ noGetSystemPromptOptions: true });
		const res = await exec(pi.tool, { action: "list" }, ctx);
		// Must return a valid AgentToolResult with content — no crash
		const out = renderText(pi.tool, res, { expanded: true });
		expect(out).toBeTruthy();
		// All active tools show [~] (no prompt snapshot available)
		expect(out).toContain("[~]");
		expect(out).not.toContain("[x]");
	});
});

// ===========================================================================
// Additional branch coverage
// ===========================================================================

describe("lastAssistantStopReason — return undefined path (line 225)", () => {
	it("auto-continue fires when agent_end has no messages (stopReason→undefined)", async () => {
		// Covers the `return undefined` at the end of lastAssistantStopReason.
		// With no messages, the for-loop never executes → returns undefined.
		// In agent_end: `stopReason !== undefined` is false → don't bail → refresh fires.
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "list" });
		await pi.fireAgentEnd([]);
		vi.runAllTimers();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const { msg } = firstSendMessageCall(pi);
		expect(msg.content).toMatch(/Continue\./);
	});

	it("auto-continue fires when all messages are non-assistant role (m.role !== 'assistant')", async () => {
		// Covers the `m.role !== "assistant"` branch in lastAssistantStopReason
		// (loop skips non-assistant messages and falls through to `return undefined`).
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "list" });
		const userMsg = { role: "user", content: [] } as unknown as AgentMessage;
		await pi.fireAgentEnd([userMsg]);
		vi.runAllTimers();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("auto-continue fires when assistant message has no stopReason (typeof sr !== 'string')", async () => {
		// Covers the `: undefined` branch of `typeof sr === "string" ? sr : undefined`.
		// stopReason absent → sr is undefined → typeof check fails → returns undefined.
		// In agent_end: stopReason === undefined → condition `stopReason !== undefined` is false
		// → don't bail early → refresh fires.
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "list" });
		const msgNoStopReason: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "x", name: "manage_tools", arguments: {} }],
			// stopReason intentionally absent
		} as unknown as AgentMessage;
		await pi.fireAgentEnd([msgNoStopReason]);
		vi.runAllTimers();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});
});

describe("renderResult — ignoredProtected TUI warning (line 481)", () => {
	it("shows Refused (protected) warning when a protected tool deactivation was attempted", async () => {
		// Covers `if (d?.ignoredProtected?.length)` true branch in renderResult.
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "deactivate", tools: ["manage_tools"] });
		const out = renderText(pi.tool, res, { expanded: true });
		expect(out).toMatch(/Refused \(protected\)/);
		expect(out).toContain("manage_tools");
	});
});

describe("execute deactivate — ignoredUnknown in LLM text (line 556)", () => {
	it("reports ignored unknown tool names in LLM text for deactivate action", async () => {
		// Covers `if (result.ignoredUnknown.length > 0)` true branch in the `deactivate` switch case.
		// The activate case already has a test for ignoredUnknown; this covers the deactivate case.
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash", "edit"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "deactivate", tools: ["edit", "phantom_tool"] });
		const txt = textOf(res);
		expect(txt).toMatch(/phantom_tool/);
		expect(txt).toMatch(/Ignored unknown/i);
		expect(pi.active.has("edit")).toBe(false); // edit was properly deactivated
		expect(pi.active.has("bash")).toBe(true); // bash untouched
	});
});

describe("renderResult — isPartial and missing-details branches", () => {
	it("isPartial: true renders ellipsis placeholder without executing the full render", async () => {
		// Covers `if (isPartial) return new Text(...)` true branch.
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "list" });
		const out = renderText(pi.tool, res, { expanded: false, isPartial: true });
		expect(out).toContain("...");
	});

	it("details=undefined (collapsed): shows 0/0 with ctrl+o hint and does not crash", () => {
		// Covers d?.active.length ?? 0, d?.total ?? 0, d?.changed?.activated ?? [],
		// d?.changed?.deactivated ?? [], d?.action === undefined (shouldCollapse true path).
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		const out = renderText(pi.tool, {}, { expanded: false });
		// action is undefined → back-compat list path → large list → shouldCollapse=true
		expect(out).toContain("ctrl+o");
		expect(out).toContain("0"); // 0 active / 0 total
	});

	it("details=undefined (expanded): enters back-compat list path with empty rows", () => {
		// Covers d?.rows ?? [] fallback and d?.action === undefined in else-if.
		// Also covers d?.ignoredUnknown?.length and d?.ignoredProtected?.length false branches
		// when d is undefined (both are falsy → no warning appended).
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		const out = renderText(pi.tool, {}, { expanded: true });
		// Empty rows → no tool lines. The header line with 0/0 should still render.
		expect(out).toBeTruthy();
		expect(out).toContain("0");
		// No warnings appended (d is undefined → both ignoredUnknown and ignoredProtected are falsy)
		expect(out).not.toContain("Ignored unknown");
		expect(out).not.toContain("Refused");
	});

	it("getSystemPromptOptions().selectedTools=undefined falls back to [] via ?? []", async () => {
		// Covers the `selectedTools ?? []` branch in execute() when selectedTools is undefined.
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const ctx = makeCtx();
		// Override to return undefined selectedTools
		(ctx as unknown as Record<string, unknown>)["getSystemPromptOptions"] =
			vi.fn(() => ({ selectedTools: undefined }));
		const res = await exec(pi.tool, { action: "list" }, ctx);
		const txt = textOf(res);
		expect(txt).toBeTruthy();
		// With no selectedTools, all active tools show as [~] (active but not in prompt)
		expect(txt).toContain("[~] read");
	});
});

// ===========================================================================
// Additional branch coverage — lines 167, 180, 225, 254, 467, 481, 556
// ===========================================================================

describe("lastAssistantStopReason — return undefined path (line 225)", () => {
	it("auto-continue fires when agent_end has no messages (stopReason→undefined)", async () => {
		// Covers the `return undefined` at the end of lastAssistantStopReason.
		// Empty messages → for-loop never executes → returns undefined.
		// In agent_end: `stopReason !== undefined` is false → don't bail → refresh fires.
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "list" });
		await pi.fireAgentEnd([]);
		vi.runAllTimers();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const { msg } = firstSendMessageCall(pi);
		expect(msg.content).toMatch(/Continue\./);
	});

	it("auto-continue fires when all messages are non-assistant role (m.role !== 'assistant')", async () => {
		// Covers the `m.role !== "assistant"` false branch in lastAssistantStopReason
		// first loop — loop skips the user message and falls through to `return undefined`.
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "list" });
		const userMsg = { role: "user", content: [] } as unknown as AgentMessage;
		await pi.fireAgentEnd([userMsg]);
		vi.runAllTimers();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("auto-continue fires when assistant message has no stopReason (typeof sr !== 'string')", async () => {
		// Covers the `: undefined` branch of `typeof sr === "string" ? sr : undefined`.
		// stopReason absent → sr is undefined → typeof check fails → returns undefined.
		// In agent_end: stopReason === undefined → `stopReason !== undefined` is false
		// → don't bail early → refresh fires.
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "list" });
		const msgNoStopReason: AgentMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "x", name: "manage_tools", arguments: {} }],
			// stopReason intentionally absent
		} as unknown as AgentMessage;
		await pi.fireAgentEnd([msgNoStopReason]);
		vi.runAllTimers();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});
});

describe("renderResult — ignoredProtected TUI warning (line 481)", () => {
	it("shows Refused (protected) warning when a protected tool deactivation was attempted", async () => {
		// Covers `if (d?.ignoredProtected?.length)` true branch in renderResult.
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "deactivate", tools: ["manage_tools"] });
		const out = renderText(pi.tool, res, { expanded: true });
		expect(out).toMatch(/Refused \(protected\)/);
		expect(out).toContain("manage_tools");
	});
});

describe("execute deactivate — ignoredUnknown in LLM text (line 556)", () => {
	it("reports ignored unknown tool names in LLM text for deactivate action", async () => {
		// Covers `if (result.ignoredUnknown.length > 0)` true branch in the `deactivate` case.
		// The activate case already has a test for ignoredUnknown; this covers the deactivate case.
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read", "bash", "edit"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "deactivate", tools: ["edit", "phantom_tool"] });
		const txt = textOf(res);
		expect(txt).toMatch(/phantom_tool/);
		expect(txt).toMatch(/Ignored unknown/i);
		expect(pi.active.has("edit")).toBe(false);
		expect(pi.active.has("bash")).toBe(true);
	});
});

describe("renderResult — isPartial and missing-details branches", () => {
	it("isPartial: true renders ellipsis placeholder without executing the full render", async () => {
		// Covers `if (isPartial) return new Text(...)` true branch.
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "list" });
		const out = renderText(pi.tool, res, { expanded: false, isPartial: true });
		expect(out).toContain("...");
	});

	it("details=undefined (collapsed): shows 0/0 with ctrl+o hint and does not crash", () => {
		// Covers d?.active.length ?? 0, d?.total ?? 0, d?.changed?.activated ?? [],
		// d?.changed?.deactivated ?? [], d?.action === undefined (shouldCollapse true path).
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		const out = renderText(pi.tool, {}, { expanded: false });
		// action is undefined → back-compat list path → large list → shouldCollapse=true
		expect(out).toContain("ctrl+o");
		expect(out).toContain("0");
	});

	it("details=undefined (expanded): enters back-compat list path with empty rows", () => {
		// Covers d?.rows ?? [] fallback and d?.action === undefined in else-if.
		// Also covers d?.ignoredUnknown?.length and d?.ignoredProtected?.length false branches
		// when d is undefined.
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		const out = renderText(pi.tool, {}, { expanded: true });
		expect(out).toBeTruthy();
		expect(out).toContain("0");
		expect(out).not.toContain("Ignored unknown");
		expect(out).not.toContain("Refused");
	});

	it("getSystemPromptOptions().selectedTools=undefined falls back to [] via ?? []", async () => {
		// Covers the `selectedTools ?? []` branch in execute() when selectedTools is undefined.
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const ctx = makeCtx();
		(ctx as unknown as Record<string, unknown>)["getSystemPromptOptions"] =
			vi.fn(() => ({ selectedTools: undefined }));
		const res = await exec(pi.tool, { action: "list" }, ctx);
		const txt = textOf(res);
		expect(txt).toBeTruthy();
		expect(txt).toContain("[~] read");
	});
});

describe("buildListing / renderListing / renderResult — empty description (lines 167, 180, 467)", () => {
	it("tool with non-string description: buildListing falls back to '' (line 167), renderListing skips separator (line 180), renderResult skips separator (line 467)", async () => {
		// Use description: undefined to force the typeof !== 'string' branch (line 167).
		// buildListing stores "", renderListing r.description falsy → "" (line 180),
		// renderResult row.description falsy → "" (line 467).
		const noDescTool = { name: "nodesc", description: undefined } as unknown as ToolInfo;
		const pi = makeFakePi({ all: [...BASE_TOOLS, noDescTool], active: ["read", "nodesc"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		const res = await exec(pi.tool, { action: "list" });
		// LLM text (renderListing): "nodesc" should appear without a " — " separator.
		const txt = textOf(res);
		expect(txt).toContain("nodesc");
		const nodescLlmLine = txt.split("\n").find((l) => /\bnodesc\b/.test(l) && !l.includes("manage"));
		expect(nodescLlmLine).toBeDefined();
		expect(nodescLlmLine).not.toContain("—");
		// TUI output (renderResult, list expanded): same tool row without separator.
		const out = renderText(pi.tool, res, { expanded: true });
		expect(out).toContain("nodesc");
		const nodescTuiLine = out.split("\n").find((l) => /\bnodesc\b/.test(l) && !l.includes("manage"));
		expect(nodescTuiLine).toBeDefined();
		expect(nodescTuiLine).not.toContain("—");
	});
});

describe("calledAnyAfterLastActivation — non-assistant message in second loop (line 254)", () => {
	it("skips non-assistant messages after the last manage_tools call and still fires refresh", async () => {
		// Covers `if (!m || m.role !== 'assistant') continue` in the SECOND loop of
		// calledAnyAfterLastActivation (i.e. after lastIdx has been found).
		// A user message after the manage_tools call is skipped, no qualifying toolCall
		// found → returns false → refresh fires advertising the newly-activated tool.
		const pi = makeFakePi({ all: [...BASE_TOOLS], active: ["read"] });
		createExtension(pi.api);
		await pi.fireSessionStart();
		await exec(pi.tool, { action: "activate", tools: ["edit"] });
		const userMsg = { role: "user", content: [] } as unknown as AgentMessage;
		await pi.fireAgentEnd([asstWithToolCall("manage_tools"), userMsg]);
		vi.runAllTimers();
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const { msg } = firstSendMessageCall(pi);
		expect(msg.content).toMatch(/edit/);
	});
});
