/**
 * host.runAgent implementation — in-package engine that drives `pi --print`.
 *
 * `createAgentFn(deps)` returns the function workflows call as:
 *
 * ```ts
 * // Plain text:
 * const summary = await host.runAgent("Summarise the diff");
 *
 * // Structured output (schema → T):
 * const plan = await host.runAgent<Plan>("Draft a plan", { schema: PlanSchema });
 * ```
 *
 * Every call goes through `runPi`. When `schema` is provided the framework:
 *   1. Injects the fixed structured-output footer.
 *   2. Calls `runPi`.
 *   3. Scans the combined stdout for the last `<pi_sw_result>…</pi_sw_result>`.
 *   4. Parses + AJV-validates. On failure, appends the diagnostic and retries.
 *
 * Retry budget: `opts.retries` (default 2, i.e. 3 total attempts). Backoff 250/500/1000 ms.
 * Hard auth/quota errors do NOT retry. AbortError short-circuits immediately.
 */
import { runPi, buildPiCommand } from "./engine/runPi.js";
import type { SandboxProvider } from "./engine/sandboxProvider.js";
import type { AgentUsage } from "./engine/runPi.js";

import {
	buildStructuredOutputInstruction,
	extractTaggedJson,
	extractBlocker,
	validateJson,
	PI_SW_RESULT_TAG,
	type JsonSchema,
} from "./structuredOutput.js";
// Re-export so types.ts can forward them without knowing the module layout.
export type { JsonSchema };

/**
 * Replace any character outside `[a-zA-Z0-9_-]` with `-`, then trim to 80 chars.
 * Used to derive stable pi session IDs from composite strings.
 */
export function slugify(s: string): string {
	return s.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
}

/**
 * Thrown when a sub-agent emits a `<pi_sw_blocker>` tag instead of a result.
 * The framework does NOT retry on this error — it propagates immediately.
 * Workflow authors can catch it to handle unrecoverable probe failures.
 */
export class AgentBlockedError extends Error {
	readonly agentLabel: string;
	readonly reason: string;
	readonly stdout: string;

	constructor(label: string, reason: string, stdout: string) {
		super(`Agent '${label}' reported a blocker: ${reason}`);
		this.name = "AgentBlockedError";
		this.agentLabel = label;
		this.reason = reason;
		this.stdout = stdout;
	}
}

// ── Public types ───────────────────────────────────────────────────────────

/** Metadata returned to the workflow after a successful host.runAgent() call. */
export interface AgentMeta {
	/** Number of model ↔ tools round-trips (turn_end events from pi). */
	readonly turns: number;
	/**
	 * Token usage from pi. Uses pi's native field names.
	 * `cacheRead` and `cacheWrite` are cache token counts (Bedrock / Anthropic).
	 * Absent when pi did not report usage (provider doesn't emit usage).
	 */
	readonly usage?: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
	};
	/** Wall-clock milliseconds from start to completion of this agent call. */
	readonly durationMs: number;
}

/** Options for a single `host.runAgent(prompt, opts)` call. */
export interface AgentOpts<_T = unknown> {
	/** Run-history label. Default: `"agent"`. */
	readonly label?: string;
	/**
	 * JSON Schema for the response. When present, the agent is asked to emit
	 * structured output wrapped in a fixed XML tag. AJV validates the result.
	 */
	readonly schema?: JsonSchema;
	/** Sandbox provider. Defaults to the host's default sandbox (read-only srt). */
	readonly sandbox?: SandboxProvider;
	/** Working directory for the sandboxed run. Defaults to `host.cwd`. */
	readonly cwd?: string;
	/**
	 * Model to use for this agent call.
	 * Accepts a named alias (`"large"`, `"medium"`, `"small"`) or a raw
	 * Bedrock model ID. Falls back to `WORKFLOW_AGENT_MODEL` env var, then
	 * pi's own default.
	 */
	readonly model?: ModelAlias | (string & {});
	/** Idle timeout in seconds. Default `600`. */
	readonly idleTimeoutSeconds?: number;
	/**
	 * Wall-clock timeout in minutes. If the agent call hasn't completed
	 * within this duration the abort signal is fired and `runAgent` rejects
	 * with a `TimeoutError`. Independent of `idleTimeoutSeconds` (which
	 * fires only on prolonged silence). Default: no wall-clock timeout.
	 */
	readonly timeoutMinutes?: number;
	/**
	 * Comma-separated allowlist of tool names passed to pi via `--tools`.
	 * Only these tools are available to the sub-agent.
	 * Example: `"read,grep,find,ls"` for a read-only scout.
	 * Mutually exclusive with `noTools`.
	 */
	readonly tools?: string;
	/**
	 * Disable all built-in tools via `--no-tools`.
	 * Use for pure-reasoning agents (planner, reviewer) that don't need
	 * filesystem access. Mutually exclusive with `tools`.
	 */
	readonly noTools?: boolean;
	/**
	 * Skill SKILL.md files to load in the sub-agent via `--skill <path>`.
	 * When provided, disables automatic skill discovery (`--no-skills` is
	 * omitted) so only these files are loaded.
	 */
	readonly skills?: readonly string[];
	/**
	 * When provided, the sub-agent's pi session is persisted under this ID.
	 * Typically derived from the root session + workflow + agent label.
	 * Omit for ephemeral (no-session) runs.
	 */
	readonly sessionId?: string;
	/**
	 * Retry budget for validation/transient failures. Default `3`.
	 * Hard auth/quota errors do NOT retry.
	 */
	readonly retries?: number;
	/**
	 * Called once after a successful agent run (not called on retried failures,
	 * only on the final success). Receives turn count, raw token usage from pi,
	 * and wall-clock duration. Useful for printing a summary at workflow end.
	 */
	readonly onComplete?: (meta: AgentMeta) => void;
	/**
	 * When true, publishes the full agent prompt (before each attempt) and
	 * full stdout (after each attempt) as visible chat messages.
	 * Intended for debugging — keep false in production workflows.
	 */
	readonly debug?: boolean;
}

/** Event type for sub-agent lifecycle notifications. */
export type RunEvent =
	| {
			kind: "publish";
			event: { kind: string; message: string; details?: Record<string, unknown> };
			ts: number;
	  }
	| {
			kind: "agent.started";
			label: string;
			model: string;
			sandbox?: string;
			ts: number;
			agentRunId: string;
	  }
	| {
			kind: "agent.session";
			agentRunId: string;
			label: string;
			sessionId: string;
			display: boolean;
			ts: number;
	  }
	| {
			kind: "agent.completed";
			agentRunId: string;
			usage?: { inputTokens: number; outputTokens: number };
			durationMs: number;
			turns?: number;
			ts: number;
	  }
	| { kind: "agent.failed"; agentRunId: string; attempt: number; error: string; ts: number }
	| { kind: "agent.retried"; agentRunId: string; attempt: number; reason: string; ts: number }
	| {
			kind: "agent.input";
			agentRunId: string;
			label: string;
			prompt: string;
			appendSystemPrompt?: string;
			command?: string[];
			attempt: number;
			/** When true, the host should surface this in chat (display:true). */
			display: boolean;
			ts: number;
	  }
	| {
			kind: "agent.output_complete";
			agentRunId: string;
			label: string;
			output: string;
			/** When true, the host should surface this in chat (display:true). */
			display: boolean;
			ts: number;
	  }
	| {
			kind: "agent.raw_output";
			agentRunId: string;
			label: string;
			rawLines: string[];
			rawStderr: string;
			/** When true, the host should surface this in chat (display:true). */
			display: boolean;
			ts: number;
	  }
	| {
			kind: "agent.tool_call";
			agentRunId: string;
			toolName: string;
			/** First line of the tool input — safe, non-sensitive preview. */
			inputPreview: string;
			toolCallId: string;
			ts: number;
	  }
	| {
			kind: "agent.tool_end";
			agentRunId: string;
			toolCallId: string;
			ts: number;
	  }
	| {
			kind: "agent.output";
			agentRunId: string;
			/** First non-empty, non-trivial line of the agent's text output. */
			preview: string;
			ts: number;
	  }
	| {
			kind: "agent.usage";
			agentRunId: string;
			/** Cumulative token usage so far for this agent run. */
			usage: { inputTokens: number; outputTokens: number };
			ts: number;
	  };

/** Injectable dependencies for `createAgentFn`. */
export interface AgentFnDeps {
	/** AbortSignal from the workflow host. */
	readonly signal: AbortSignal;
	/** Record run events. Optional; no-op when absent. */
	readonly onEvent?: (event: RunEvent) => void;
	/**
	 * Default sandbox factory — called lazily on each `host.runAgent` invocation
	 * that does not supply `opts.sandbox`. The factory caches the result
	 * internally (built once per workflow run).
	 */
	readonly defaultSandbox: () => SandboxProvider;
	/** Default cwd for runPi (host.cwd). */
	readonly cwd: string;
	/**
	 * Prefix for deriving stable sub-agent session IDs.
	 * When set, each agent call computes its session ID as slugify(`${sessionPrefix}-${label}`).
	 */
	readonly sessionPrefix?: string;
}

export type AgentFn = <T = string>(
	prompt: string,
	opts?: AgentOpts<T>,
) => Promise<T>;

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Named model aliases for agent calls.
 *
 * Pass `"large"`, `"medium"`, or `"small"` to `host.runAgent({ model })`
 * instead of a raw Bedrock model ID.
 *
 * Hardcoded for now; will become configurable.
 */
export const MODEL_ALIASES = {
	large:  "global.anthropic.claude-opus-4-7",
	medium: "global.anthropic.claude-sonnet-4-6",
	small:  "global.anthropic.claude-haiku-4-5",
} as const;

export type ModelAlias = keyof typeof MODEL_ALIASES;

const RETRY_DELAYS_MS = [250, 500, 1000] as const;

/**
 * Default model for the pi `--model` flag.
 *
 * Resolution order:
 *   1. `opts.model` on the host.runAgent call.
 *   2. `WORKFLOW_AGENT_MODEL` environment variable.
 *   3. `undefined` — pi uses its own default provider/model.
 */
const DEFAULT_MODEL = process.env["WORKFLOW_AGENT_MODEL"];

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function makeAgentRunId(): string {
	return `ar-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function isHardError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const lower = err.message.toLowerCase();
	return (
		lower.includes("access denied") ||
		lower.includes("accessdenied") ||
		lower.includes("not authorized") ||
		lower.includes("unauthorized") ||
		lower.includes("quota exceeded") ||
		lower.includes("invalid client token")
	);
}

function isAbortError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	return (
		err.name === "AbortError" ||
		err.name === "TimeoutError" ||
		err.message.toLowerCase().includes("aborted")
	);
}

/**
 * Translate pi's per-call usage shape into the `{inputTokens, outputTokens}`
 * shape the onEvent callback expects. Cache reads/writes roll into
 * `inputTokens` consistent with how the previous engine reported usage.
 */
function toEventUsage(
	usage: AgentUsage | undefined,
): { inputTokens: number; outputTokens: number } | undefined {
	if (usage === undefined) return undefined;
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	const outputTokens = usage.output;
	if (inputTokens === 0 && outputTokens === 0) return undefined;
	return { inputTokens, outputTokens };
}

/**
 * Duck-type check for the fake provider side-channel.
 * Avoids importing FakeSandboxProvider in production code paths.
 */
function hasFakeSideChannel(
	sandbox: SandboxProvider,
): sandbox is SandboxProvider & { setCurrentLabel: (l: string) => void } {
	return (
		typeof (sandbox as unknown as Record<string, unknown>)["setCurrentLabel"] ===
		"function"
	);
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Create the `host.runAgent` function bound to the provided deps.
 * Injected into `WorkflowContext.agent` by `buildWorkflowHost`.
 */
export function createAgentFn(deps: AgentFnDeps): AgentFn {
	return async function agent<T = string>(
		prompt: string,
		opts?: AgentOpts<T>,
	): Promise<T> {
		const label = opts?.label ?? "agent";
		const schema = opts?.schema;
		const idleTimeoutSeconds = opts?.idleTimeoutSeconds ?? 600;
		const timeoutMinutes = opts?.timeoutMinutes;
		const retries = opts?.retries ?? 2;
		const cwd = opts?.cwd ?? deps.cwd;
		const sandbox = opts?.sandbox ?? deps.defaultSandbox();
		const rawModel = opts?.model ?? DEFAULT_MODEL;
		const model = rawModel !== undefined
			? (MODEL_ALIASES[rawModel as ModelAlias] ?? rawModel)
			: undefined;
		const modelLabel = model ?? "pi-default";
		const tools = opts?.tools;
		const noTools = opts?.noTools;
		const skills = opts?.skills;
		const debug = opts?.debug ?? false;

		const agentRunId = makeAgentRunId();

		// Derive stable session ID: external override wins, then compute from prefix.
		const agentSessionId = opts?.sessionId ?? (
			deps.sessionPrefix !== undefined
				? slugify(`${deps.sessionPrefix}-${label}`)
				: undefined
		);

		// Side channel: tell a fake provider which label is active.
		if (hasFakeSideChannel(sandbox)) {
			sandbox.setCurrentLabel(label);
		}

		deps.onEvent?.({
			kind: "agent.started",
			label,
			model: modelLabel,
			sandbox: sandbox.name,
			...(timeoutMinutes !== undefined ? { timeoutMinutes } : {}),
			ts: Date.now(),
			agentRunId,
		});

		// Structured-output instruction goes via --append-system-prompt so it
		// arrives at system priority, not buried in the user message where the
		// coding-assistant persona can override it.
		const appendSystemPrompt =
			schema !== undefined
				? buildStructuredOutputInstruction(PI_SW_RESULT_TAG, schema)
				: undefined;

		const startedAt = Date.now();
		let lastError: Error | undefined;
		let lastStdout: string | undefined;

		for (let attempt = 0; attempt <= retries; attempt++) {
			if (attempt > 0) {
				const delay =
					RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)] ??
					1000;
				await sleep(delay);
				deps.onEvent?.({
					kind: "agent.retried",
					agentRunId,
					attempt,
					reason: lastError?.message ?? "unknown",
					ts: Date.now(),
				});
			}

			if (deps.signal.aborted) {
				const e = new Error("AbortError: workflow aborted");
				e.name = "AbortError";
				throw e;
			}

			// On retries, append the previous error as a diagnostic hint.
			const effectivePrompt =
				attempt === 0 || lastError === undefined
					? prompt
					: `${prompt}\n\n<agent_retry_context attempt="${String(attempt)}" max="${String(retries)}">\n` +
					  `Your previous response was rejected:\n${lastError.message.slice(0, 512)}\n` +
					  (lastStdout !== undefined && lastStdout.length > 0
					      ? `\nYour actual output was (truncated to 800 chars):\n${lastStdout.slice(0, 800)}\n`
					      : "\nYour output was empty.\n") +
					  `Fix the above and try again.\n` +
					  `</agent_retry_context>`;
			if (debug) {
				deps.onEvent?.({
					kind: "agent.input",
					agentRunId,
					label,
					prompt: effectivePrompt,
					...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
					command: buildPiCommand(model, appendSystemPrompt, tools, noTools, skills),
					attempt,
					display: true,
					ts: Date.now(),
				});
			}
			try {
				// Combine the workflow signal with an optional wall-clock timeout.
				const attemptSignal = timeoutMinutes !== undefined
					? AbortSignal.any([deps.signal, AbortSignal.timeout(timeoutMinutes * 60 * 1000)])
					: deps.signal;
				const result = await runPi({
					prompt: effectivePrompt,
					cwd,
					sandbox,
					model,
					...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
					...(tools !== undefined ? { tools } : {}),
					...(noTools === true ? { noTools } : {}),
					...(skills !== undefined && skills.length > 0 ? { skills } : {}),
					...(agentSessionId !== undefined ? { sessionId: agentSessionId } : {}),
					idleTimeoutSeconds,
					signal: attemptSignal,
					name: label,
					onToolCall: (toolName, inputPreview, toolCallId) => {
						deps.onEvent?.({
							kind: "agent.tool_call",
							agentRunId,
							toolName,
							inputPreview,
							toolCallId,
							ts: Date.now(),
						});
					},
					onToolEnd: (toolCallId) => {
						deps.onEvent?.({
							kind: "agent.tool_end",
							agentRunId,
							toolCallId,
							ts: Date.now(),
						});
					},
					onOutput: (preview) => {
						deps.onEvent?.({
							kind: "agent.output",
							agentRunId,
							preview,
							ts: Date.now(),
						});
					},
					onUsage: (rawUsage) => {
						const u = toEventUsage(rawUsage);
						if (u === undefined) return;
						deps.onEvent?.({
							kind: "agent.usage",
							agentRunId,
							usage: u,
							ts: Date.now(),
						});
					},
					onSessionStart: (sessionId) => {
						deps.onEvent?.({
							kind: "agent.session",
							agentRunId,
							label,
							sessionId,
							display: debug,
							ts: Date.now(),
						});
					},
				});

				lastStdout = result.stdout;

				if (debug) {
					deps.onEvent?.({
						kind: "agent.raw_output",
						agentRunId,
						label,
						rawLines: result.rawLines,
						rawStderr: result.rawStderr,
						display: true,
						ts: Date.now(),
					});
				}

				if (debug) {
					deps.onEvent?.({
						kind: "agent.output_complete",
						agentRunId,
						label,
						output: result.stdout,
						display: true,
						ts: Date.now(),
					});
				}

				const usage = toEventUsage(result.usage);

				// ── Blocker check (schema calls only) ────────────────────────────────────
				if (schema !== undefined) {
					const blockerReason = extractBlocker(result.stdout);
					if (blockerReason !== undefined) {
						// Blockers are not retried — propagate immediately.
						throw new AgentBlockedError(label, blockerReason, result.stdout);
					}
				}

				// ── Schema validation ──────────────────────────────────────────
				let returnValue: T;
				if (schema !== undefined) {
					const inner = extractTaggedJson(result.stdout, PI_SW_RESULT_TAG);
					const parsed: unknown = JSON.parse(inner);
					validateJson(parsed, schema);
					returnValue = parsed as T;
				} else {
					returnValue = result.stdout as unknown as T;
				}

				// ── Fire onComplete only after successful validation ─────────────────
				deps.onEvent?.({
					kind: "agent.completed",
					agentRunId,
					...(usage !== undefined ? { usage } : {}),
					turns: result.turns,
					durationMs: Date.now() - startedAt,
					ts: Date.now(),
				});

				opts?.onComplete?.({
					turns: result.turns,
					...(result.usage !== undefined ? { usage: result.usage } : {}),
					durationMs: Date.now() - startedAt,
				});

				return returnValue;
			} catch (err: unknown) {
				// Abort: propagate immediately — no retry.
				if (deps.signal.aborted || isAbortError(err)) {
					throw err instanceof Error ? err : new Error(String(err));
				}

				// Hard auth/quota errors: no retry.
				if (isHardError(err)) {
					deps.onEvent?.({
						kind: "agent.failed",
						agentRunId,
						attempt,
						error: err instanceof Error ? err.message : String(err),
						ts: Date.now(),
					});
					throw err instanceof Error ? err : new Error(String(err));
				}

				// AgentBlockedError: propagate immediately — never retry.
				if (err instanceof AgentBlockedError) {
					deps.onEvent?.({
						kind: "agent.failed",
						agentRunId,
						attempt,
						error: err.message,
						ts: Date.now(),
					});
					throw err;
				}

				lastError =
					err instanceof Error ? err : new Error(String(err));

				if (debug && err instanceof Error) {
					const raw = err as Error & { rawLines?: string[]; rawStderr?: string };
					deps.onEvent?.({
						kind: "agent.raw_output",
						agentRunId,
						label,
						rawLines: raw.rawLines ?? [],
						rawStderr: raw.rawStderr ?? "",
						display: true,
						ts: Date.now(),
					});
				}

				deps.onEvent?.({
					kind: "agent.failed",
					agentRunId,
					attempt,
					error: lastError.message,
					ts: Date.now(),
				});

				if (attempt >= retries) {
					// Annotate with attempt count so callers don't have to infer it.
					const attempts = retries + 1; // retries=3 → 4 total attempts
					const annotated = new Error(
						`${lastError.message} (failed after ${String(attempts)} attempt${attempts === 1 ? "" : "s"})`,
					);
					annotated.name = lastError.name;
					throw annotated;
				}
			}
		}

		throw lastError ?? new Error("Agent exhausted retries");
	};
}
