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
 *   2. The user-message prompt contains the structural tokens we care
 *      about: `goal:` as the recap lead, `Next:` for the optional step,
 *      no `recap:` self-prefix (the widget already paints that label),
 *      and the `Skip:` negative-list line.
 *
 *   3. The transcript is actually embedded inside the prompt's
 *      `<transcript>` block — if this regresses, the LLM is being asked
 *      to summarise empty input.
 *
 * The existing `test/index.test.ts` suite never mocks `completeSimple`,
 * so the prompt is otherwise entirely uncovered. This file lives apart
 * from that one because `vi.mock("@mariozechner/pi-ai", …)` is hoisted
 * to module scope and would leak into unrelated tests if colocated.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted: every import of `@mariozechner/pi-ai` in this file's module graph
// resolves to these mocks. `completeSimple` captures its args via a vi.fn;
// `getModel` is unused on the no-override path this suite exercises.
vi.mock("@mariozechner/pi-ai", () => ({
	completeSimple: vi.fn(),
	getModel: vi.fn(() => undefined),
}));

import { completeSimple } from "@mariozechner/pi-ai";

import createExtension from "../src/index.js";

// --- stub pi + ctx (trimmed copies of the fixtures in index.test.ts) ------

interface StubPi {
	on: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
	registerFlag: ReturnType<typeof vi.fn>;
	registerMessageRenderer: ReturnType<typeof vi.fn>;
	sendMessage: ReturnType<typeof vi.fn>;
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
		registerCommand: vi.fn((name: string, def) => {
			commands.set(name, def);
		}),
		registerFlag: vi.fn(),
		registerMessageRenderer: vi.fn(),
		sendMessage: vi.fn(),
		// No flags seeded — defaults apply. `--recap-model` and `--recap-disable`
		// read as undefined, so the manual path uses ctx.model and runs.
		getFlag: vi.fn(() => undefined),
		commands,
	};
}

/**
 * Branch with one user message + one assistant message carrying a tool
 * call. Clears `hasMeaningfulActivity` (toolCalls > 0), and
 * `buildRecentTranscript` will emit both a `User:` line and a tool-call
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
			// Stable leaf so the post-await "leaf moved" check doesn't discard
			// the recap.
			getLeafId: vi.fn(() => "leaf-1"),
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
			content: [{ type: "text", text: "goal: add Skip rule. Edited index.ts. Next: run tests." }],
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

	it("user prompt's Format line leads with `goal:` as the template token", async () => {
		const { context } = await runManualRecap();
		const prompt = userPromptText(context);
		expect(prompt).toMatch(/`goal:\s*<[^>]+>`|goal:\s*<overall goal>/);
	});

	it("user prompt's Format line does NOT start with a `recap:` self-prefix (the widget already paints that label)", async () => {
		// Kept separate from the `goal:` assertion so a regression that removes
		// `goal:` doesn't short-circuit this independent invariant. Literal
		// `recap:` inside the rules body is fine (e.g. "Do not prefix with
		// `recap:`"); only the Format template line is forbidden from using it.
		const { context } = await runManualRecap();
		const prompt = userPromptText(context);
		const formatLine = prompt.split("\n").find((l) => l.includes("Format:"));
		expect(formatLine).toBeDefined();
		expect(formatLine!).not.toMatch(/`recap:\s*</);
	});

	it("user prompt preserves the `Next:` optional clause and its omission rule", async () => {
		const { context } = await runManualRecap();
		const prompt = userPromptText(context);
		expect(prompt).toContain("Next:");
		expect(prompt.toLowerCase()).toContain("omit the `next:` clause");
	});

	it("user prompt includes a `Skip:` negative-list line (root-cause narrative, em-dash tangents, etc.)", async () => {
		const { context } = await runManualRecap();
		const prompt = userPromptText(context);
		const skipLine = prompt.split("\n").find((l) => l.trimStart().startsWith("- Skip:"));
		expect(skipLine, "expected a `- Skip: …` rule line in the recap prompt").toBeDefined();
		// Keep this loose — we assert the intent, not the exact words. If the
		// Skip list shrinks below these three we've probably lost the signal.
		expect(skipLine!.toLowerCase()).toContain("root-cause");
		expect(skipLine!.toLowerCase()).toContain("em-dash");
		expect(skipLine!.toLowerCase()).toContain("to-do");
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
});
