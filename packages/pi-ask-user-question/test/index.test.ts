import { describe, expect, it, vi } from "vitest";

import type { ExtensionAPI, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import createExtension, { type RunDialogFn } from "../src/index.js";
import type { TParams } from "../src/schema.js";

/**
 * Minimal `ExtensionAPI` stub. The default export touches nothing except
 * `registerTool`, so that's all we need to capture.
 */
function makeFakePi() {
	// Any tool registered through this stub is stashed here for assertions.
	let tool: ToolDefinition | undefined;
	const registerTool = vi.fn((t: ToolDefinition) => {
		tool = t;
	});
	return {
		api: { registerTool, events: { emit: vi.fn() } } as unknown as ExtensionAPI,
		registerTool,
		get tool(): ToolDefinition {
			if (!tool) throw new Error("No tool registered");
			return tool;
		},
	};
}

const validParams: TParams = {
	questions: [{ question: "Pick one", options: [{ label: "A" }, { label: "B" }] }],
};

function makeCtx(hasUI: boolean) {
	return {
		hasUI,
		ui: {
			custom: vi.fn(),
		},
		cwd: "/tmp",
	} as unknown as ExtensionContext; // loose — we only pass it through
}

describe("default export — tool registration", () => {
	it("registers exactly one tool on the supplied pi API", () => {
		const pi = makeFakePi();
		createExtension(pi.api);
		expect(pi.registerTool).toHaveBeenCalledTimes(1);
		const t = pi.tool;
		expect(t.name).toBe("ask_user_question");
		expect(t.label).toBe("Ask User Question");
		expect(typeof t.description).toBe("string");
		expect(t.description.length).toBeGreaterThan(0);
		expect(typeof t.promptSnippet).toBe("string");
		expect(Array.isArray(t.promptGuidelines)).toBe(true);
		expect(t.promptGuidelines!.length).toBeGreaterThan(0);
		expect(t.parameters).toBeDefined();
		expect(typeof t.execute).toBe("function");
		expect(typeof t.renderCall).toBe("function");
		expect(typeof t.renderResult).toBe("function");
	});
});

describe("tool.execute() — non-interactive short-circuit", () => {
	it("returns the ERROR_NO_UI message when ctx.hasUI is false (runDialog is not called)", async () => {
		const pi = makeFakePi();
		const run = vi.fn<RunDialogFn>();
		createExtension(pi.api, { runDialog: run });
		const ctx = makeCtx(false);
		const result = await pi.tool.execute("tc-1", validParams, undefined, undefined, ctx);
		expect(run).not.toHaveBeenCalled();
		expect((result.content[0] as { text?: string } | undefined)?.text).toMatch(/UI not available/);
		expect(result.details).toMatchObject({ cancelled: true, error: expect.stringMatching(/UI not available/) as unknown });
	});
});

describe("tool.execute() — validation failures", () => {
	it("returns the validator message without calling runDialog", async () => {
		const pi = makeFakePi();
		const run = vi.fn<RunDialogFn>();
		createExtension(pi.api, { runDialog: run });
		const ctx = makeCtx(true);
		// Reserved label triggers a reserved_label failure.
		const bad: TParams = {
			questions: [
				{ question: "Pick", options: [{ label: "Other" }, { label: "B" }] },
			],
		};
		const result = await pi.tool.execute("tc-2", bad, undefined, undefined, ctx);
		expect(run).not.toHaveBeenCalled();
		expect(result.details).toMatchObject({ cancelled: true });
		expect((result.content[0] as { text?: string } | undefined)?.text).toContain("reserved");
	});

	it("returns a validator message even when questions field is missing entirely", async () => {
		const pi = makeFakePi();
		const run = vi.fn<RunDialogFn>();
		createExtension(pi.api, { runDialog: run });
		const ctx = makeCtx(true);
		const result = await pi.tool.execute(
			"tc-3",
			{ questions: undefined as unknown as TParams["questions"] },
			undefined,
			undefined,
			ctx,
		);
		expect(run).not.toHaveBeenCalled();
		expect((result.content[0] as { text?: string } | undefined)?.text).toMatch(/questions/);
	});
});

describe("tool.execute() — happy path", () => {
	it("invokes the injected runDialog and formats its result for the LLM", async () => {
		const pi = makeFakePi();
		const run = vi.fn<RunDialogFn>().mockResolvedValue({
			cancelled: false,
			answers: [{ kind: "single", index: 1, label: "B" }],
		});
		createExtension(pi.api, { runDialog: run });
		const ctx = makeCtx(true);
		const result = await pi.tool.execute("tc-4", validParams, undefined, undefined, ctx);

		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0]?.[0]).toBe(ctx);
		expect(run.mock.calls[0]?.[1]).toEqual(validParams.questions);
		expect((result.content[0] as { text?: string } | undefined)?.text).toBe("selected 2. B");
		expect(result.details).toMatchObject({ cancelled: false });
	});

	it("surfaces chat-abort results verbatim", async () => {
		const pi = makeFakePi();
		const run = vi.fn<RunDialogFn>().mockResolvedValue({
			cancelled: true,
			answers: [],
			chat: "want to rethink",
		});
		createExtension(pi.api, { runDialog: run });
		const ctx = makeCtx(true);
		const result = await pi.tool.execute("tc-5", validParams, undefined, undefined, ctx);
		expect((result.content[0] as { text?: string } | undefined)?.text).toContain("User cancelled the questionnaire. Chat: want to rethink");
	});

	it("propagates errors from runDialog", async () => {
		const pi = makeFakePi();
		const run = vi.fn<RunDialogFn>().mockRejectedValue(new Error("tui crashed"));
		createExtension(pi.api, { runDialog: run });
		const ctx = makeCtx(true);
		await expect(pi.tool.execute("tc-6", validParams, undefined, undefined, ctx)).rejects.toThrow(/tui crashed/);
	});
});

describe("tool.execute() — event emission", () => {
	it("emits user_attention_requested before dialog and user_attention_resolved after", async () => {
		const order: string[] = [];
		let capturedTool: ToolDefinition | undefined;
		const registerTool = vi.fn((t: ToolDefinition) => { capturedTool = t; });
		const emit = vi.fn((channel: string) => { order.push(channel); });
		const api = { registerTool, events: { emit } } as unknown as ExtensionAPI;
		const run = vi.fn<RunDialogFn>().mockImplementation(() => {
			order.push("dialog");
			return Promise.resolve({ cancelled: false, answers: [] });
		});
		createExtension(api, { runDialog: run });
		if (!capturedTool) throw new Error("No tool registered");
		await capturedTool.execute("tc-events", validParams, undefined, undefined, makeCtx(true));
		expect(order).toEqual(["user_attention_requested", "dialog", "user_attention_resolved"]);
	});

	it("emits user_attention_resolved even when the dialog throws", async () => {
		const emitted: string[] = [];
		let capturedTool: ToolDefinition | undefined;
		const registerTool = vi.fn((t: ToolDefinition) => { capturedTool = t; });
		const emit = vi.fn((channel: string) => { emitted.push(channel); });
		const api = { registerTool, events: { emit } } as unknown as ExtensionAPI;
		const run = vi.fn<RunDialogFn>().mockRejectedValue(new Error("crash"));
		createExtension(api, { runDialog: run });
		if (!capturedTool) throw new Error("No tool registered");
		await expect(
			capturedTool.execute("tc-throw", validParams, undefined, undefined, makeCtx(true))
		).rejects.toThrow("crash");
		expect(emitted).toContain("user_attention_resolved");
	});
});

describe("tool.renderCall / tool.renderResult", () => {
	function makeTheme(): Theme {
		return {
			fg: (_c: string, t: string) => t,
			bold: (t: string) => t,
			bg: (_c: string, t: string) => t,
		} as unknown as Theme;
	}

	it("renderCall produces a Text component describing the questions", () => {
		const pi = makeFakePi();
		createExtension(pi.api);
		const comp = pi.tool.renderCall!(validParams, makeTheme(), {} as never);
		expect(typeof comp.render).toBe("function");
		const out = comp.render(80)[0] ?? "";
		expect(out).toContain("ask_user_question");
		expect(out).toContain("1 question");
	});

	it("renderResult turns a success payload into a Text component with the summary", () => {
		const pi = makeFakePi();
		createExtension(pi.api);
		const theme = makeTheme();
		const comp = pi.tool.renderResult!(
			{ content: [{ type: "text", text: "ok" }], details: { answers: [], cancelled: false } },
			{ expanded: false, isPartial: false },
			theme,
			{} as never,
		);
		expect((comp.render(80)[0] ?? "").trimEnd()).toBe("ok");
	});
});
