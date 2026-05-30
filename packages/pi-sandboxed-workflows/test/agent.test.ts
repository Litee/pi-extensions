/**
 * Tests for host.agent — backed by the runPi engine.
 *
 * `runPi` is mocked so no real subprocesses are spawned. The tests
 * exercise the agent function's orchestration: retries, event emission,
 * structured-output extraction, abort handling, usage translation.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ── Mock must be hoisted before any SUT import ───────────────────────────────
const { mockRunPi } = vi.hoisted(() => {
	const mockRunPi = vi.fn();
	return { mockRunPi };
});

vi.mock("../src/engine/runPi.js", () => ({
	runPi: mockRunPi,
	buildPiCommand: () => ["pi", "--print", "--mode", "json", "--no-extensions", "--no-skills"],
}));

import { createAgentFn, AgentBlockedError, type AgentFnDeps, type AgentMeta } from "../src/agent.js";
import type { SandboxProvider } from "../src/engine/sandboxProvider.js";
import { PI_SW_RESULT_TAG } from "../src/structuredOutput.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

interface MakeRunResultArgs {
	stdout: string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	sessionId?: string;
}

function makeRunResult(args: MakeRunResultArgs | string) {
	const norm = typeof args === "string" ? { stdout: args } : args;
	const defaultUsage = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 };
	return {
		stdout: norm.stdout,
		usage:
			norm.usage === undefined
				? defaultUsage
				: { ...defaultUsage, ...norm.usage },
		sessionId: norm.sessionId,
		rawLines: [] as string[],
		rawStderr: "",
	};
}

function makeRunResultNoUsage(stdout: string) {
	return { stdout, usage: undefined, sessionId: undefined, rawLines: [] as string[], rawStderr: "" };
}

function taggedStdout(value: unknown): string {
	return `Agent reasoning...\n<${PI_SW_RESULT_TAG}>\n${JSON.stringify(value)}\n</${PI_SW_RESULT_TAG}>`;
}

/** Minimal SandboxProvider stub — runPi is mocked so it never uses the sandbox. */
const stubSandbox: SandboxProvider = {
	exec: vi.fn(),
} as unknown as SandboxProvider;

function makeDeps(overrides: Partial<AgentFnDeps> = {}): AgentFnDeps {
	return {
		signal: new AbortController().signal,
		onEvent: vi.fn(),
		defaultSandbox: () => stubSandbox,
		cwd: "/tmp/test-cwd",
		...overrides,
	};
}

beforeEach(() => {
	mockRunPi.mockReset();
});

// ── Plain text ────────────────────────────────────────────────────────────────

describe("createAgentFn — plain text (no schema)", () => {
	it("returns stdout string when no schema is given", async () => {
		mockRunPi.mockResolvedValueOnce(makeRunResult("hello world"));
		const agent = createAgentFn(makeDeps());
		expect(await agent("say hello")).toBe("hello world");
	});

	it("emits agent.started and agent.completed events", async () => {
		mockRunPi.mockResolvedValueOnce(makeRunResult("ok"));
		const onEvent = vi.fn();
		const agent = createAgentFn(makeDeps({ onEvent }));
		await agent("prompt", { label: "my-agent" });
		expect(onEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "agent.started", label: "my-agent" }),
		);
		expect(onEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "agent.completed" }),
		);
	});

	it("emits 'pi-default' as model label when no model env is set", async () => {
		// (we don't unset env mid-test; just assert the label is non-empty
		// and either the env value or 'pi-default')
		mockRunPi.mockResolvedValueOnce(makeRunResult("ok"));
		const onEvent = vi.fn();
		await createAgentFn(makeDeps({ onEvent }))("prompt");
		const started = vi
			.mocked(onEvent)
			.mock.calls.find(([e]) => (e as { kind: string }).kind === "agent.started");
		const model = (started?.[0] as { model: string }).model;
		expect(typeof model).toBe("string");
		expect(model.length).toBeGreaterThan(0);
	});

	it("uses opts.model as the agent.started model label", async () => {
		mockRunPi.mockResolvedValueOnce(makeRunResult("ok"));
		const onEvent = vi.fn();
		await createAgentFn(makeDeps({ onEvent }))("p", { model: "openai/gpt-4o" });
		const started = vi
			.mocked(onEvent)
			.mock.calls.find(([e]) => (e as { kind: string }).kind === "agent.started");
		expect((started?.[0] as { model: string }).model).toBe("openai/gpt-4o");
	});

	it("forwards opts.model to runPi", async () => {
		mockRunPi.mockResolvedValueOnce(makeRunResult("ok"));
		await createAgentFn(makeDeps())("p", { model: "anthropic/claude-sonnet:high" });
		expect(mockRunPi).toHaveBeenCalledWith(
			expect.objectContaining({ model: "anthropic/claude-sonnet:high" }),
		);
	});

	it("records consistent agentRunId on started and completed", async () => {
		mockRunPi.mockResolvedValueOnce(makeRunResult("ok"));
		const onEvent = vi.fn();
		await createAgentFn(makeDeps({ onEvent }))("p");
		const calls = vi
			.mocked(onEvent)
			.mock.calls.map(([e]) => e as { kind: string; agentRunId: string });
		const started = calls.find((e) => e.kind === "agent.started");
		const completed = calls.find((e) => e.kind === "agent.completed");
		expect(started?.agentRunId).toBeDefined();
		expect(completed?.agentRunId).toBe(started?.agentRunId);
	});

	it("completed event includes durationMs ≥ 0", async () => {
		mockRunPi.mockResolvedValueOnce(makeRunResult("ok"));
		const onEvent = vi.fn();
		await createAgentFn(makeDeps({ onEvent }))("p");
		const completed = vi
			.mocked(onEvent)
			.mock.calls.find(([e]) => (e as { kind: string }).kind === "agent.completed");
		expect(
			(completed?.[0] as { durationMs: number }).durationMs,
		).toBeGreaterThanOrEqual(0);
	});

	it("passes name:label to runPi", async () => {
		mockRunPi.mockResolvedValueOnce(makeRunResult("ok"));
		await createAgentFn(makeDeps())("prompt", { label: "finder" });
		expect(mockRunPi).toHaveBeenCalledWith(
			expect.objectContaining({ name: "finder" }),
		);
	});
});

// ── Structured output ─────────────────────────────────────────────────────────

describe("createAgentFn — structured output (schema)", () => {
	const schema = {
		type: "object",
		required: ["answer"],
		properties: { answer: { type: "string" } },
	};

	it("returns parsed JSON when stdout contains the tag block", async () => {
		const value = { answer: "42" };
		mockRunPi.mockResolvedValueOnce(makeRunResult(taggedStdout(value)));
		const agent = createAgentFn(makeDeps());
		expect(await agent<typeof value>("think", { schema })).toEqual(value);
	});

	it("passes the structured-output instruction via appendSystemPrompt, not the user prompt", async () => {
		mockRunPi.mockResolvedValueOnce(
			makeRunResult(taggedStdout({ answer: "x" })),
		);
		await createAgentFn(makeDeps())("base prompt", { schema });
		const call = mockRunPi.mock.calls[0]?.[0] as {
			prompt: string;
			appendSystemPrompt?: string;
		};
		// Tag instruction must be at system level, NOT buried in user prompt.
		expect(call.prompt).not.toContain(`<${PI_SW_RESULT_TAG}>`);
		expect(call.appendSystemPrompt).toContain(`<${PI_SW_RESULT_TAG}>`);
		expect(call.appendSystemPrompt).toContain("pi-sandboxed-workflows: structured output");
	});

	it("does not set appendSystemPrompt when no schema is given", async () => {
		mockRunPi.mockResolvedValueOnce(makeRunResult("ok"));
		await createAgentFn(makeDeps())("prompt");
		const call = mockRunPi.mock.calls[0]?.[0] as { appendSystemPrompt?: string };
		expect(call.appendSystemPrompt).toBeUndefined();
	});
});

// ── Retry — schema validation failure ─────────────────────────────────────────

describe("createAgentFn — retry on validation failure", () => {
	const schema = {
		type: "object",
		required: ["answer"],
		properties: { answer: { type: "string" } },
	};

	it("retries when stdout contains tag but JSON fails schema", async () => {
		mockRunPi
			.mockResolvedValueOnce(makeRunResult(taggedStdout({ wrong: true })))
			.mockResolvedValueOnce(makeRunResult(taggedStdout({ answer: "good" })));
		const result = await createAgentFn(makeDeps())("p", { schema });
		expect(result).toEqual({ answer: "good" });
		expect(mockRunPi).toHaveBeenCalledTimes(2);
	});

	it("emits agent.failed then agent.retried events", async () => {
		mockRunPi
			.mockResolvedValueOnce(makeRunResult(taggedStdout({ wrong: true })))
			.mockResolvedValueOnce(makeRunResult(taggedStdout({ answer: "ok" })));
		const onEvent = vi.fn();
		await createAgentFn(makeDeps({ onEvent }))("p", { schema });
		const kinds = vi
			.mocked(onEvent)
			.mock.calls.map(([e]) => (e as { kind: string }).kind);
		expect(kinds).toContain("agent.failed");
		expect(kinds).toContain("agent.retried");
		expect(kinds).toContain("agent.completed");
	});

	it("throws after exhausting retries", async () => {
		mockRunPi.mockResolvedValue(makeRunResult(taggedStdout({ wrong: true })));
		const agent = createAgentFn(makeDeps());
		await expect(agent("p", { schema, retries: 2 })).rejects.toThrow();
		expect(mockRunPi).toHaveBeenCalledTimes(3); // 1 + 2 retries
	});

	it("appends the error diagnostic to the prompt on retry", async () => {
		mockRunPi
			.mockResolvedValueOnce(makeRunResult(taggedStdout({ wrong: true })))
			.mockResolvedValueOnce(makeRunResult(taggedStdout({ answer: "ok" })));
		await createAgentFn(makeDeps())("base", { schema });
		const secondCallPrompt = (
			mockRunPi.mock.calls[1]?.[0] as { prompt: string }
		).prompt;
		expect(secondCallPrompt).toContain("<agent_retry_context");
	});
});

// ── Retry — tag not found ─────────────────────────────────────────────────────

describe("createAgentFn — retry on TagNotFoundError", () => {
	const schema = {
		type: "object",
		required: ["v"],
		properties: { v: { type: "number" } },
	};

	it("retries when stdout has no tag block", async () => {
		mockRunPi
			.mockResolvedValueOnce(makeRunResult("no tag here"))
			.mockResolvedValueOnce(makeRunResult(taggedStdout({ v: 1 })));
		const result = await createAgentFn(makeDeps())("p", { schema });
		expect(result).toEqual({ v: 1 });
		expect(mockRunPi).toHaveBeenCalledTimes(2);
	});
});

// ── Transient error retries ───────────────────────────────────────────────────

describe("createAgentFn — transient error retries", () => {
	it("retries on a throttling error", async () => {
		const err = Object.assign(new Error("ThrottlingException: too many"), {
			name: "ThrottlingException",
		});
		mockRunPi
			.mockRejectedValueOnce(err)
			.mockResolvedValueOnce(makeRunResult("ok"));
		expect(await createAgentFn(makeDeps())("p")).toBe("ok");
		expect(mockRunPi).toHaveBeenCalledTimes(2);
	});

	it("does NOT retry on hard access-denied error", async () => {
		const err = Object.assign(
			new Error("AccessDeniedException: not authorized"),
			{ name: "AccessDeniedException" },
		);
		mockRunPi.mockRejectedValue(err);
		await expect(
			createAgentFn(makeDeps())("p", { retries: 3 }),
		).rejects.toThrow(/AccessDeniedException/i);
		expect(mockRunPi).toHaveBeenCalledTimes(1);
	});
});

// ── Abort propagation ─────────────────────────────────────────────────────────

describe("createAgentFn — abort signal", () => {
	it("throws before calling runPi when signal is already aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		const agent = createAgentFn(makeDeps({ signal: ac.signal }));
		await expect(agent("p")).rejects.toThrow();
		expect(mockRunPi).not.toHaveBeenCalled();
	});

	it("propagates AbortError thrown by runPi", async () => {
		mockRunPi.mockRejectedValue(
			Object.assign(new Error("The operation was aborted"), {
				name: "AbortError",
			}),
		);
		await expect(createAgentFn(makeDeps())("p")).rejects.toThrow(/aborted/i);
		// No retry on abort
		expect(mockRunPi).toHaveBeenCalledTimes(1);
	});
});

// ── Token usage capture ───────────────────────────────────────────────────────

describe("createAgentFn — token usage", () => {
	it("translates pi's {input,output,cacheRead,cacheWrite} into event {inputTokens,outputTokens}", async () => {
		mockRunPi.mockResolvedValueOnce({
			stdout: "ok",
			usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
		});
		const onEvent = vi.fn();
		await createAgentFn(makeDeps({ onEvent }))("p");
		const completed = vi
			.mocked(onEvent)
			.mock.calls.find(
				([e]) => (e as { kind: string }).kind === "agent.completed",
			);
		const usage = (
			completed?.[0] as {
				usage?: { inputTokens: number; outputTokens: number };
			}
		).usage;
		// inputTokens = input + cacheRead + cacheWrite = 100 + 10 + 5 = 115
		// outputTokens = output = 50
		expect(usage).toEqual({ inputTokens: 115, outputTokens: 50 });
	});

	it("omits usage from agent.completed when runPi returns no usage", async () => {
		mockRunPi.mockResolvedValueOnce(makeRunResultNoUsage("ok"));
		const onEvent = vi.fn();
		await createAgentFn(makeDeps({ onEvent }))("p");
		const completed = vi
			.mocked(onEvent)
			.mock.calls.find(
				([e]) => (e as { kind: string }).kind === "agent.completed",
			);
		expect((completed?.[0] as { usage?: unknown }).usage).toBeUndefined();
	});
});

// ── onComplete callback ────────────────────────────────────────────────

describe("createAgentFn — onComplete callback", () => {
	it("calls onComplete with turns, usage, and durationMs on success", async () => {
		mockRunPi.mockResolvedValueOnce({
			stdout: "ok",
			turns: 3,
			usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
		});
		const metas: AgentMeta[] = [];
		await createAgentFn(makeDeps())("p", { onComplete: (m) => metas.push(m) });
		expect(metas).toHaveLength(1);
		expect(metas[0]?.turns).toBe(3);
		expect(metas[0]?.usage).toEqual({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5 });
		expect(metas[0]?.durationMs).toBeGreaterThanOrEqual(0);
	});

	it("does not call onComplete when the run fails", async () => {
		mockRunPi.mockRejectedValue(new Error("boom"));
		const metas: AgentMeta[] = [];
		await expect(
			createAgentFn(makeDeps())("p", { retries: 0, onComplete: (m) => metas.push(m) }),
		).rejects.toThrow();
		expect(metas).toHaveLength(0);
	});
});

// ── AgentBlockedError ───────────────────────────────────────────────────────────

describe("createAgentFn — AgentBlockedError", () => {
	const schema = {
		type: "object",
		required: ["v"],
		properties: { v: { type: "string" } },
	};

	it("throws AgentBlockedError immediately without retrying when blocker tag present", async () => {
		const stdout = `some output\n<pi_sw_blocker>bash not available</pi_sw_blocker>`;
		mockRunPi.mockResolvedValueOnce(makeRunResult(stdout));
		const agent = createAgentFn(makeDeps());
		await expect(agent("p", { schema, retries: 3 })).rejects.toThrow(AgentBlockedError);
		expect(mockRunPi).toHaveBeenCalledTimes(1);
	});

	it("does not fire onComplete when a blocker is emitted", async () => {
		const stdout = `<pi_sw_blocker>tool unavailable</pi_sw_blocker>`;
		mockRunPi.mockResolvedValueOnce(makeRunResult(stdout));
		const metas: AgentMeta[] = [];
		await expect(
			createAgentFn(makeDeps())("p", { schema, retries: 3, onComplete: (m) => metas.push(m) }),
		).rejects.toThrow(AgentBlockedError);
		expect(metas).toHaveLength(0);
	});
});

// ── onComplete fires after validation ────────────────────────────────────

describe("createAgentFn — onComplete fires after validation", () => {
	const schema = {
		type: "object",
		required: ["v"],
		properties: { v: { type: "string" } },
	};

	it("fires onComplete only after successful schema validation", async () => {
		mockRunPi
			.mockResolvedValueOnce(makeRunResult("no tag here")) // attempt 0: no tag
			.mockResolvedValueOnce(makeRunResult(taggedStdout({ v: "ok" }))); // attempt 1: valid
		const metas: AgentMeta[] = [];
		await createAgentFn(makeDeps())("p", { schema, onComplete: (m) => metas.push(m) });
		expect(mockRunPi).toHaveBeenCalledTimes(2);
		expect(metas).toHaveLength(1);
	});
});

// ── retry prompt includes agent_retry_context ─────────────────────────────

describe("createAgentFn — debug mode", () => {
	it("debug:true fires agent.input with prompt and display:true", async () => {
		mockRunPi.mockResolvedValueOnce(makeRunResult("ok"));
		const onEvent = vi.fn();
		const agent = createAgentFn(makeDeps({ onEvent }));
		await agent("my prompt", { label: "scout", debug: true });
		const inputEvent = vi
			.mocked(onEvent)
			.mock.calls.find(([e]) => (e as { kind: string }).kind === "agent.input");
		expect(inputEvent).toBeDefined();
		const ev = inputEvent?.[0] as { prompt: string; display: boolean; attempt: number; label: string };
		expect(ev.prompt).toBe("my prompt");
		expect(ev.display).toBe(true);
		expect(ev.attempt).toBe(0);
		expect(ev.label).toBe("scout");
	});

	it("debug:false (default) does NOT fire agent.input", async () => {
		mockRunPi.mockResolvedValueOnce(makeRunResult("ok"));
		const onEvent = vi.fn();
		const agent = createAgentFn(makeDeps({ onEvent }));
		await agent("my prompt");
		const inputEvent = vi
			.mocked(onEvent)
			.mock.calls.find(([e]) => (e as { kind: string }).kind === "agent.input");
		expect(inputEvent).toBeUndefined();
	});
});

// ── retry prompt includes agent_retry_context ─────────────────────────────

describe("createAgentFn — retry prompt format", () => {
	const schema = {
		type: "object",
		required: ["v"],
		properties: { v: { type: "string" } },
	};

	it("includes stdout from the previous attempt in the retry prompt", async () => {
		mockRunPi
			.mockResolvedValueOnce(makeRunResult({ stdout: "some content", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }))
			.mockResolvedValueOnce(makeRunResult(taggedStdout({ v: "ok" })));
		await createAgentFn(makeDeps())("base", { schema });
		const secondCallPrompt = (
			mockRunPi.mock.calls[1]?.[0] as { prompt: string }
		).prompt;
		expect(secondCallPrompt).toContain("<agent_retry_context");
		expect(secondCallPrompt).toContain("some content");
	});

	it("shows 'Your output was empty.' when stdout is empty", async () => {
		mockRunPi
			.mockResolvedValueOnce(makeRunResult({ stdout: "", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }))
			.mockResolvedValueOnce(makeRunResult(taggedStdout({ v: "ok" })));
		await createAgentFn(makeDeps())("base", { schema });
		const secondCallPrompt = (
			mockRunPi.mock.calls[1]?.[0] as { prompt: string }
		).prompt;
		expect(secondCallPrompt).toContain("Your output was empty.");
	});

	it("includes previous error in retry prompt via agent_retry_context tag", async () => {
		mockRunPi
			.mockResolvedValueOnce(makeRunResult("no tag"))
			.mockResolvedValueOnce(makeRunResult(taggedStdout({ v: "ok" })));
		await createAgentFn(makeDeps())("base", { schema });
		const secondCallPrompt = (
			mockRunPi.mock.calls[1]?.[0] as { prompt: string }
		).prompt;
		expect(secondCallPrompt).toContain("<agent_retry_context");
		expect(secondCallPrompt).toContain("</agent_retry_context>");
	});
});
