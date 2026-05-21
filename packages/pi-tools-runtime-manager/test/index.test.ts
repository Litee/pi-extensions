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

function makeCtx(opts?: { isIdle?: boolean }) {
	return {
		hasUI: true,
		ui: { notify: vi.fn() },
		cwd: "/tmp",
		isIdle: vi.fn(() => opts?.isIdle ?? true),
	} as unknown as ExtensionContext;
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

async function exec(tool: ToolDefinition, params: unknown) {
	return tool.execute("tc", params, undefined, undefined, makeCtx());
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
		expect(msg.customType).toBe("pi-tools-runtime-manager:refresh");
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
	rows: { name: string; active: boolean; description: string }[];
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
		expect(msg.customType).toBe("pi-tools-runtime-manager:refresh");
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
		expect(msg.customType).toBe("pi-tools-runtime-manager:refresh");
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
		expect(msg.customType).toBe("pi-tools-runtime-manager:refresh");
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
