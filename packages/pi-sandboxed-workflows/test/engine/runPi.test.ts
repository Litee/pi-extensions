/**
 * Tests for runPi engine.
 *
 * The sandbox provider is mocked — we feed canned pi --mode json events via
 * the onLine callback. No real pi subprocesses are spawned.
 */
import { describe, expect, it, vi } from "vitest";
import { runPi, buildPiCommand } from "../../src/engine/runPi.js";
import type { SandboxProvider, ExecOpts } from "../../src/engine/sandboxProvider.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a sandbox provider whose exec() invokes the given handler. */
function makeSandbox(
	handler: (opts: ExecOpts) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
): SandboxProvider & { exec: ReturnType<typeof vi.fn> } {
	return {
		exec: vi.fn(handler) as ReturnType<typeof vi.fn>,
	} as unknown as SandboxProvider & { exec: ReturnType<typeof vi.fn> };
}

/** Create a sandbox that feeds the given lines and returns exit 0. */
function linesSandbox(lines: string[]): SandboxProvider {
	return makeSandbox((opts) => {
		for (const line of lines) {
			opts.onLine?.(line);
		}
		return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
	});
}

const sessionLine = (id = "sess-abc") =>
	JSON.stringify({ type: "session", version: 3, id, timestamp: "now", cwd: "/tmp" });

const assistantMessage = (
	text: string,
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	...(usage !== undefined ? { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...usage } } : {}),
});

const messageEndLine = (
	text: string,
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
) => JSON.stringify({ type: "message_end", message: assistantMessage(text, usage) });

const agentEndLine = (messages: unknown[] = []) =>
	JSON.stringify({ type: "agent_end", messages });

/** Build a baseline RunPiOptions for tests. */
function baseOpts(
	sandbox: SandboxProvider,
	overrides: Partial<Parameters<typeof runPi>[0]> = {},
): Parameters<typeof runPi>[0] {
	return {
		prompt: "hi",
		cwd: "/tmp",
		sandbox,
		model: "test-model",
		signal: new AbortController().signal,
		idleTimeoutSeconds: 60,
		...overrides,
	};
}

// ── buildPiCommand ────────────────────────────────────────────────────────────

describe("buildPiCommand", () => {
	it("includes the required hermetic flags", () => {
		const cmd = buildPiCommand("sonnet:high");
		expect(cmd[0]).toBe("pi");
		expect(cmd).toContain("--print");
		expect(cmd).toContain("--mode");
		expect(cmd).toContain("json");
		expect(cmd).toContain("--no-extensions");
		expect(cmd).toContain("--no-skills");
		expect(cmd).toContain("--no-session");
		expect(cmd).toContain("--model");
		expect(cmd).toContain("sonnet:high");
	});

	it("omits --model when model is undefined", () => {
		const cmd = buildPiCommand(undefined);
		expect(cmd).not.toContain("--model");
	});

	it("omits --model when model is empty string", () => {
		const cmd = buildPiCommand("");
		expect(cmd).not.toContain("--model");
	});

	it("adds --tools when tools is provided", () => {
		const cmd = buildPiCommand(undefined, undefined, "read,grep,find,ls");
		const idx = cmd.indexOf("--tools");
		expect(idx).toBeGreaterThan(-1);
		expect(cmd[idx + 1]).toBe("read,grep,find,ls");
		expect(cmd).not.toContain("--no-tools");
	});

	it("adds --no-tools when noTools is true", () => {
		const cmd = buildPiCommand(undefined, undefined, undefined, true);
		expect(cmd).toContain("--no-tools");
		expect(cmd).not.toContain("--tools");
	});

	it("noTools takes precedence over tools when both set", () => {
		const cmd = buildPiCommand(undefined, undefined, "read", true);
		expect(cmd).toContain("--no-tools");
		expect(cmd).not.toContain("--tools");
	});

	it("adds --skill entries and omits --no-skills when skills are provided", () => {
		const cmd = buildPiCommand(undefined, undefined, undefined, undefined, [
			"/path/to/skill-a/SKILL.md",
			"/path/to/skill-b/SKILL.md",
		]);
		expect(cmd).not.toContain("--no-skills");
		// Each skill gets its own --skill <path> pair
		const pairs: string[] = [];
		for (let i = 0; i < cmd.length - 1; i++) {
			if (cmd[i] === "--skill") pairs.push(cmd[i + 1] as string);
		}
		expect(pairs).toEqual(["/path/to/skill-a/SKILL.md", "/path/to/skill-b/SKILL.md"]);
	});

	it("adds --no-skills when skills array is empty", () => {
		const cmd = buildPiCommand(undefined, undefined, undefined, undefined, []);
		expect(cmd).toContain("--no-skills");
		expect(cmd).not.toContain("--skill");
	});

	it("adds --no-skills when skills is undefined", () => {
		const cmd = buildPiCommand(undefined);
		expect(cmd).toContain("--no-skills");
	});

	it("does not include --resume / --continue / --fork flags", () => {
		const cmd = buildPiCommand("m");
		expect(cmd).not.toContain("--resume");
		expect(cmd).not.toContain("--continue");
		expect(cmd).not.toContain("--fork");
	});

	it("includes --no-session so sub-agents don't write session files", () => {
		const cmd = buildPiCommand("m");
		expect(cmd).toContain("--no-session");
	});

	it("uses --session-id and omits --no-session when sessionId is provided", () => {
		const cmd = buildPiCommand("m", undefined, undefined, undefined, undefined, "my-session-id");
		const idx = cmd.indexOf("--session-id");
		expect(idx).toBeGreaterThan(-1);
		expect(cmd[idx + 1]).toBe("my-session-id");
		expect(cmd).not.toContain("--no-session");
	});

	it("adds --append-system-prompt when appendSystemPrompt is provided", () => {
		const cmd = buildPiCommand("m", "emit JSON in <tag>");
		expect(cmd).toContain("--append-system-prompt");
		const idx = cmd.indexOf("--append-system-prompt");
		expect(cmd[idx + 1]).toBe("emit JSON in <tag>");
	});

	it("omits --append-system-prompt when appendSystemPrompt is undefined", () => {
		const cmd = buildPiCommand("m", undefined);
		expect(cmd).not.toContain("--append-system-prompt");
	});
});

// ── stdout aggregation ────────────────────────────────────────────────────────

describe("runPi — stdout aggregation", () => {
	it("aggregates text from message_end events", async () => {
		const sandbox = linesSandbox([
			sessionLine(),
			messageEndLine("hello "),
			messageEndLine("world"),
			agentEndLine(),
		]);
		const result = await runPi(baseOpts(sandbox));
		expect(result.stdout).toBe("hello world");
	});

	it("ignores non-assistant messages", async () => {
		const sandbox = linesSandbox([
			sessionLine(),
			JSON.stringify({
				type: "message_end",
				message: { role: "user", content: [{ type: "text", text: "u" }] },
			}),
			messageEndLine("only assistant"),
			agentEndLine(),
		]);
		const result = await runPi(baseOpts(sandbox));
		expect(result.stdout).toBe("only assistant");
	});

	it("ignores non-text content blocks", async () => {
		const sandbox = linesSandbox([
			sessionLine(),
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [
						{ type: "tool_use", name: "read", input: {} },
						{ type: "text", text: "answer" },
					],
				},
			}),
			agentEndLine(),
		]);
		const result = await runPi(baseOpts(sandbox));
		expect(result.stdout).toBe("answer");
	});

	it("handles missing assistant content gracefully", async () => {
		const sandbox = linesSandbox([
			sessionLine(),
			JSON.stringify({ type: "message_end", message: { role: "assistant" } }),
			agentEndLine(),
		]);
		const result = await runPi(baseOpts(sandbox));
		expect(result.stdout).toBe("");
	});
});

// ── session capture ─────────────────────────────────────────────────────────

describe("runPi — session id", () => {
	it("captures session id from the session header line", async () => {
		const sandbox = linesSandbox([
			sessionLine("my-uuid-1234"),
			messageEndLine("ok"),
			agentEndLine(),
		]);
		const result = await runPi(baseOpts(sandbox));
		expect(result.sessionId).toBe("my-uuid-1234");
	});

	it("leaves sessionId undefined when no header line is emitted", async () => {
		const sandbox = linesSandbox([messageEndLine("ok"), agentEndLine()]);
		const result = await runPi(baseOpts(sandbox));
		expect(result.sessionId).toBeUndefined();
	});

	it("calls onSessionStart immediately with the session id", async () => {
		const sandbox = linesSandbox([
			sessionLine("fire-immediately"),
			messageEndLine("ok"),
			agentEndLine(),
		]);
		const fired: string[] = [];
		await runPi(baseOpts(sandbox, { onSessionStart: (id) => fired.push(id) }));
		expect(fired).toEqual(["fire-immediately"]);
	});
});

// ── usage extraction ────────────────────────────────────────────────────────

describe("runPi — usage extraction", () => {
	it("captures usage from per-message_end events", async () => {
		const sandbox = linesSandbox([
			sessionLine(),
			messageEndLine("a", { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }),
			messageEndLine("b", { input: 50, output: 25 }),
			agentEndLine(),
		]);
		const result = await runPi(baseOpts(sandbox));
		expect(result.usage).toEqual({
			input: 150,
			output: 75,
			cacheRead: 10,
			cacheWrite: 5,
		});
	});

	it("falls back to agent_end.messages when no per-message usage was seen", async () => {
		const sandbox = linesSandbox([
			sessionLine(),
			// message_end without usage on the message
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "x" }] },
			}),
			JSON.stringify({
				type: "agent_end",
				messages: [
					assistantMessage("x", { input: 200, output: 30, cacheRead: 0, cacheWrite: 0 }),
				],
			}),
		]);
		const result = await runPi(baseOpts(sandbox));
		expect(result.usage).toEqual({
			input: 200,
			output: 30,
			cacheRead: 0,
			cacheWrite: 0,
		});
	});

	it("leaves usage undefined when no usage data is anywhere", async () => {
		const sandbox = linesSandbox([
			sessionLine(),
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "x" }] },
			}),
			agentEndLine(),
		]);
		const result = await runPi(baseOpts(sandbox));
		expect(result.usage).toBeUndefined();
	});
});

// ── prompt and CLI invocation ───────────────────────────────────────────────

describe("runPi — sandbox.exec invocation", () => {
	it("passes the prompt via stdin (not argv)", async () => {
		const sandbox = makeSandbox((opts) => {
			opts.onLine?.(sessionLine());
			opts.onLine?.(messageEndLine("ok"));
			opts.onLine?.(agentEndLine());
			return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
		});
		await runPi(baseOpts(sandbox, { prompt: "the user prompt" }));
		const callOpts = sandbox.exec.mock.calls[0]?.[0] as ExecOpts;
		expect(callOpts.stdin).toBe("the user prompt");
		// And the prompt MUST NOT appear as an argv token.
		expect((callOpts.command as string[])).not.toContain("the user prompt");
	});

	it("forwards the cwd unchanged", async () => {
		const sandbox = makeSandbox((opts) => {
			opts.onLine?.(sessionLine());
			opts.onLine?.(messageEndLine("ok"));
			opts.onLine?.(agentEndLine());
			return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
		});
		await runPi(baseOpts(sandbox, { cwd: "/some/path" }));
		const callOpts = sandbox.exec.mock.calls[0]?.[0] as ExecOpts;
		expect(callOpts.cwd).toBe("/some/path");
	});

	it("passes --model when supplied", async () => {
		const sandbox = makeSandbox((opts) => {
			opts.onLine?.(sessionLine());
			opts.onLine?.(messageEndLine("ok"));
			opts.onLine?.(agentEndLine());
			return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
		});
		await runPi(baseOpts(sandbox, { model: "anthropic/claude-sonnet:high" }));
		const callOpts = sandbox.exec.mock.calls[0]?.[0] as ExecOpts;
		expect((callOpts.command as string[])).toContain("--model");
		expect((callOpts.command as string[])).toContain("anthropic/claude-sonnet:high");
	});

	it("omits --model when model is undefined", async () => {
		const sandbox = makeSandbox((opts) => {
			opts.onLine?.(sessionLine());
			opts.onLine?.(messageEndLine("ok"));
			opts.onLine?.(agentEndLine());
			return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
		});
		await runPi(baseOpts(sandbox, { model: undefined }));
		const callOpts = sandbox.exec.mock.calls[0]?.[0] as ExecOpts;
		expect((callOpts.command as string[])).not.toContain("--model");
	});
});

// ── abort propagation ───────────────────────────────────────────────────────

describe("runPi — abort signal", () => {
	it("throws before exec when signal is already aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		const sandbox = makeSandbox(() => Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }));
		await expect(runPi(baseOpts(sandbox, { signal: ac.signal }))).rejects.toThrow(/abort/i);
		expect(sandbox.exec).not.toHaveBeenCalled();
	});

	it("propagates abort from exec rejection", async () => {
		const sandbox = makeSandbox(
			(opts) =>
				new Promise<{ exitCode: number; stdout: string; stderr: string }>((_, reject) => {
					opts.signal?.addEventListener("abort", () => {
						const e = new Error("aborted by signal");
						e.name = "AbortError";
						reject(e);
					});
				}),
		);
		const ac = new AbortController();
		const promise = runPi(baseOpts(sandbox, { signal: ac.signal }));
		setTimeout(() => ac.abort(), 5);
		await expect(promise).rejects.toThrow(/abort/i);
	});
});

// ── idle timeout ────────────────────────────────────────────────────────────

describe("runPi — idle timeout", () => {
	it("throws an idle timeout error when exec produces no output", async () => {
		const sandbox = makeSandbox(
			(opts) =>
				new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
					opts.signal?.addEventListener("abort", () => {
						const reason: unknown = (opts.signal as AbortSignal).reason;
						reject(reason instanceof Error ? reason : new Error("aborted"));
					});
					// Never emits lines; only resolves if not aborted (it will be).
					setTimeout(() => resolve({ exitCode: 0, stdout: "", stderr: "" }), 5_000);
				}),
		);
		await expect(
			runPi(baseOpts(sandbox, { idleTimeoutSeconds: 0.05 })),
		).rejects.toThrow(/idle/i);
	});
});

// ── non-JSON stdout ─────────────────────────────────────────────────────────

describe("runPi — non-JSON stdout lines", () => {
	it("ignores non-JSON lines and still captures the result", async () => {
		const sandbox = linesSandbox([
			"plain banner text",
			sessionLine(),
			"more noise",
			messageEndLine("good"),
			agentEndLine(),
		]);
		const result = await runPi(baseOpts(sandbox));
		expect(result.stdout).toBe("good");
	});
});

// ── exit-code handling ──────────────────────────────────────────────────────

describe("runPi — non-zero exit", () => {
	it("throws when pi exits non-zero with no captured stdout", async () => {
		const sandbox = makeSandbox(() => Promise.resolve({
			exitCode: 1,
			stdout: "",
			stderr: "error: some pi failure",
		}));
		await expect(runPi(baseOpts(sandbox))).rejects.toThrow(/pi exited with code 1/);
	});

	it("does NOT throw on non-zero exit when stdout was captured", async () => {
		// Some pi paths produce useful output and then exit non-zero. Tolerate.
		const sandbox = makeSandbox((opts) => {
			opts.onLine?.(sessionLine());
			opts.onLine?.(messageEndLine("partial"));
			opts.onLine?.(agentEndLine());
			return Promise.resolve({ exitCode: 1, stdout: "", stderr: "noisy stderr" });
		});
		const result = await runPi(baseOpts(sandbox));
		expect(result.stdout).toBe("partial");
	});
});

// ── onAgentStreamEvent hook ─────────────────────────────────────────────────

describe("runPi — turn counting", () => {
	it("counts turn_end events as turns", async () => {
		const sandbox = linesSandbox([
			sessionLine(),
			JSON.stringify({ type: "turn_start" }),
			messageEndLine("first"),
			JSON.stringify({ type: "turn_end" }),
			JSON.stringify({ type: "turn_start" }),
			messageEndLine("second"),
			JSON.stringify({ type: "turn_end" }),
			agentEndLine(),
		]);
		const result = await runPi(baseOpts(sandbox));
		expect(result.turns).toBe(2);
	});

	it("returns turns=0 when no turn_end events are emitted", async () => {
		const sandbox = linesSandbox([sessionLine(), agentEndLine()]);
		const result = await runPi(baseOpts(sandbox));
		expect(result.turns).toBe(0);
	});
});

describe("runPi — onAgentStreamEvent", () => {
	it("calls onAgentStreamEvent for each parsed event", async () => {
		const sandbox = linesSandbox([
			sessionLine("s1"),
			messageEndLine("hi"),
			agentEndLine(),
		]);
		const events: unknown[] = [];
		await runPi(
			baseOpts(sandbox, {
				onAgentStreamEvent: (e) => events.push(e),
			}),
		);
		const types = events.map((e) => (e as { type: string }).type);
		expect(types).toEqual(["session", "message_end", "agent_end"]);
	});
});
