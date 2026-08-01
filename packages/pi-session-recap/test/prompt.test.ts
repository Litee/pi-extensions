/**
 * Prompt-contract tests for `generateRecap`.
 *
 * These tests pin the load-bearing invariants of the LLM call in
 * `src/index.ts::generateRecap` without over-specifying wording:
 *
 *   1. The Context passed to `completeSimple` has NO `tools` field
 *      (all providers gate tool emission on `context.tools?.length`, so
 *      omitting the field = no tools sent). This is the "tools disabled"
 *      regression guard.
 *
 *   2. The user-message prompt follows the v0.2 "stepped away / re-enter
 *      flow" framing: 1-3 short plain-text sentences, lead with the
 *      high-level task, end with the concrete next step, skip status
 *      reports, and say explicitly if the last turn aborted/errored.
 *
 *   3. The transcript is actually embedded inside the prompt's
 *      `<transcript>` block — if this regresses, the LLM is being asked
 *      to summarise empty input.
 *
 * The existing `test/index.test.ts` suite never mocks `completeSimple`,
 * so the prompt is otherwise entirely uncovered. This file lives apart
 * from that one because `vi.mock("@earendil-works/pi-ai", …)` is hoisted
 * to module scope and would leak into unrelated tests if colocated.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted: every import of `@earendil-works/pi-ai` in this file's module graph
// resolves to these mocks. `completeSimple` captures its args via a vi.fn;
// `getModel` is unused on the no-override path this suite exercises.
vi.mock("@earendil-works/pi-ai", () => ({
	completeSimple: vi.fn(),
	getModel: vi.fn(() => undefined),
}));

import { completeSimple } from "@earendil-works/pi-ai";

import createExtension from "../src/index.js";

// --- stub pi + ctx (trimmed copies of the fixtures in index.test.ts) ------

interface StubPi {
	on: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
	registerFlag: ReturnType<typeof vi.fn>;
	registerMessageRenderer: ReturnType<typeof vi.fn>;
	sendMessage: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
	getFlag: ReturnType<typeof vi.fn>;
	readonly commands: Map<
		string,
		{ description: string; handler: (args: string, ctx: unknown) => unknown }
	>;
}

function makeFakePi(): StubPi {
	const commands = new Map<
		string,
		{ description: string; handler: (args: string, ctx: unknown) => unknown }
	>();
	return {
		on: vi.fn(),
		registerCommand: vi.fn((name: string, def: { description: string; handler: (args: string, ctx: unknown) => unknown }) => {
			commands.set(name, def);
		}),
		registerFlag: vi.fn(),
		registerMessageRenderer: vi.fn(),
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		// No flags seeded — defaults apply. `--recap-model` reads as undefined,
		// so the manual path uses ctx.model and runs.
		getFlag: vi.fn(() => undefined),
		commands,
	};
}

/**
 * Branch with one user message + one assistant message carrying a tool
 * call. Clears `hasMeaningfulActivity` (toolCalls > 0), and
 * `buildTranscript` will emit both a `User:` line and a tool-call
 * summary line.
 */
function branchWithActivity(): unknown[] {
	return [
		{
			type: "message",
			message: {
				role: "user",
				content: [{ type: "text", text: "Add a Skip rule to the recap prompt." }],
			},
		},
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Editing src/index.ts to add the new rule." },
					{
						type: "toolCall",
						name: "edit",
						arguments: { path: "src/index.ts", oldText: "A", newText: "B" },
					},
				],
			},
		},
	];
}

function makeFakeCtx(branch: unknown[]) {
	return {
		hasUI: true,
		model: { provider: "anthropic", id: "claude-sonnet-4-6" },
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
			theme: {
				fg: (_c: string, t: string) => t,
				bold: (t: string) => t,
			},
		},
		sessionManager: {
			getBranch: vi.fn(() => branch),
		},
		modelRegistry: {
			// Return a usable key so generateRecap gets past the auth gate.
			getApiKeyAndHeaders: vi.fn(() => ({ ok: true, apiKey: "test-key" })),
		},
	};
}

// --- tests ---------------------------------------------------------------

describe("generateRecap prompt contract", () => {
	let agentDir: string;
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pi-session-recap-prompt-"));
		prevAgentDir = process.env["PI_CODING_AGENT_DIR"];
		process.env["PI_CODING_AGENT_DIR"] = agentDir;
		// Reset captured calls between tests. The vi.mock factory creates a
		// single shared vi.fn() instance, so calls from prior tests would
		// otherwise bleed into `mock.calls` here.
		vi.mocked(completeSimple).mockReset();
		vi.mocked(completeSimple).mockResolvedValue({
			role: "assistant",
			content: [{ type: "text", text: "Building a parser. Next: run the tests." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} as never);
	});

	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = prevAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function runManualRecap(): Promise<{
		model: unknown;
		context: { systemPrompt?: string; messages: Array<{ content: unknown }>; tools?: unknown };
		options: unknown;
	}> {
		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx(branchWithActivity());
		const cmd = pi.commands.get("recap");
		expect(cmd).toBeDefined();
		await cmd!.handler("", ctx);

		expect(completeSimple).toHaveBeenCalledTimes(1);
		const [model, context, options] = vi.mocked(completeSimple).mock.calls[0] as unknown as [
			unknown,
			{ systemPrompt?: string; messages: Array<{ content: unknown }>; tools?: unknown },
			unknown,
		];
		return { model, context, options };
	}

	/**
	 * Pull the text of the first user message out of the captured Context.
	 * Messages are built as `[{ role: "user", content: [{ type: "text", text }] }]`
	 * in index.ts; a shape change here means the prompt-building path has
	 * regressed and the rest of this suite is lying.
	 */
	function userPromptText(context: {
		messages: Array<{ content: unknown }>;
	}): string {
		const first = context.messages[0];
		expect(first).toBeDefined();
		const content = first!.content;
		expect(Array.isArray(content)).toBe(true);
		const parts = (content as Array<{ type?: string; text?: string }>).filter(
			(c) => c.type === "text" && typeof c.text === "string",
		);
		expect(parts.length).toBeGreaterThan(0);
		return parts.map((p) => p.text!).join("\n");
	}

	// --- (1) tools disabled ------------------------------------------------

	it("does NOT set `tools` on the Context — every provider gates tool emission on context.tools?.length, so omission = disabled", async () => {
		const { context } = await runManualRecap();
		// The property must be absent OR explicitly undefined / empty. The
		// current implementation omits it entirely; we accept either shape
		// so a future refactor to `tools: []` stays green.
		if ("tools" in context) {
			expect(context.tools === undefined || (Array.isArray(context.tools) && context.tools.length === 0)).toBe(true);
		}
	});

	// --- (2) prompt structure ----------------------------------------------

	it("user prompt opens with the stepped-away / re-enter-flow framing", async () => {
		const { context } = await runManualRecap();
		const prompt = userPromptText(context);
		expect(prompt).toMatch(/stepped away/i);
		expect(prompt).toMatch(/re-enter flow/i);
	});

	it("user prompt asks for 1-3 short plain-text sentences with no preamble / markdown / bullets", async () => {
		const { context } = await runManualRecap();
		const prompt = userPromptText(context);
		expect(prompt).toMatch(/1-3 short sentences/i);
		expect(prompt).toMatch(/plain text/i);
		expect(prompt).toMatch(/no preamble, no markdown, no bullets/i);
	});

	it("user prompt says to start with the high-level task, not implementation minutiae", async () => {
		const { context } = await runManualRecap();
		const prompt = userPromptText(context);
		const rule = prompt.split("\n").find((l) => l.startsWith("- Start by stating"));
		expect(rule).toBeDefined();
		expect(rule!).toMatch(/high-level task/i);
		expect(rule!).toMatch(/not implementation minutiae/i);
	});

	it("user prompt says to end with the concrete next step", async () => {
		const { context } = await runManualRecap();
		const prompt = userPromptText(context);
		const rule = prompt.split("\n").find((l) => l.startsWith("- End with"));
		expect(rule).toBeDefined();
		expect(rule!).toMatch(/concrete next step/i);
	});

	it("user prompt instructs the model to skip status reports and orient the reader", async () => {
		const { context } = await runManualRecap();
		const prompt = userPromptText(context);
		const rule = prompt.split("\n").find((l) => l.startsWith("- Skip"));
		expect(rule).toBeDefined();
		expect(rule!.toLowerCase()).toContain("status reports");
		expect(rule!.toLowerCase()).toContain("orient");
	});

	it("user prompt says to state explicitly when the last turn aborted or errored", async () => {
		const { context } = await runManualRecap();
		const prompt = userPromptText(context);
		expect(prompt).toMatch(/aborted or errored/i);
		expect(prompt).toMatch(/"aborted during X"/);
	});

	it("user prompt caps the output at ~400 characters", async () => {
		const { context } = await runManualRecap();
		const prompt = userPromptText(context);
		expect(prompt).toMatch(/~400 characters/);
	});

	it("user prompt embeds the session transcript inside a `<transcript>` block", async () => {
		const { context } = await runManualRecap();
		const prompt = userPromptText(context);
		expect(prompt).toContain("<transcript>");
		expect(prompt).toContain("</transcript>");
		// Our seeded branch produces both a User: line and a tool-call summary.
		// If the transcript ever stops flowing, these two canaries go missing.
		expect(prompt).toContain("User: Add a Skip rule to the recap prompt.");
		expect(prompt).toMatch(/- edit\(/);
	});

	// --- (3) sanity: systemPrompt present (openai-codex-responses needs it) ---

	it("sets a non-empty `systemPrompt` on the Context (openai-codex-responses rejects empty top-level instructions)", async () => {
		const { context } = await runManualRecap();
		expect(typeof context.systemPrompt).toBe("string");
		expect(context.systemPrompt!.length).toBeGreaterThan(0);
	});

	// --- (4) model-call options --------------------------------------------

	it("sends cacheRetention 'none' and maxTokens 256 for the recap call", async () => {
		const { options } = await runManualRecap();
		const o = options as Record<string, unknown>;
		expect(o["cacheRetention"]).toBe("none");
		expect(o["maxTokens"]).toBe(256);
	});

	// --- (5) error handling ------------------------------------------------

	it("writes a session-recap:error entry via pi.appendEntry when the model call fails with a non-provider error", async () => {
		vi.mocked(completeSimple).mockRejectedValue(new Error("provider returned 429"));

		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx(branchWithActivity());
		await pi.commands.get("recap")!.handler("", ctx);

		const errorCalls = pi.appendEntry.mock.calls.filter(
			(c: unknown[]) => c[0] === "session-recap:error",
		);
		expect(errorCalls).toHaveLength(1);
		expect(errorCalls[0]![1]).toEqual({ message: "provider returned 429" });
	});

	it("skips silently (no error entry) when the provider is unknown to pi-ai", async () => {
		vi.mocked(completeSimple).mockRejectedValue(
			new Error("No API provider registered for api: bridge"),
		);

		const pi = makeFakePi();
		createExtension(pi as never);
		const ctx = makeFakeCtx(branchWithActivity());
		await pi.commands.get("recap")!.handler("", ctx);

		const errorCalls = pi.appendEntry.mock.calls.filter(
			(c: unknown[]) => c[0] === "session-recap:error",
		);
		expect(errorCalls).toHaveLength(0);
	});
});
