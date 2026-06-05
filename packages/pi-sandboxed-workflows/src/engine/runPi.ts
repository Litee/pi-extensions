/**
 * runPi — the in-package engine that drives a sub-agent for `host.runAgent()`.
 *
 * Each call spawns ONE `pi --print --mode json --no-extensions --no-skills
 * --no-session` invocation. Pi handles the full agent loop (model + tool
 * calls + responses) internally, so there is no outer iteration here.
 *
 * Why hermetic by default:
 *   - `--no-extensions` prevents the sub-agent from re-loading our own
 *     pi-sandboxed-workflows extension recursively.
 *   - `--no-skills` keeps the runtime narrow and predictable.
 *   - `--no-session` keeps the user's session history clean.
 *
 * Stream parsing: `--mode json` emits one JSON object per stdout line.
 *   1. First line is the session header `{type:"session", id, ...}`.
 *   2. Events follow: `agent_start`, `turn_start`, `message_*`, `turn_end`,
 *      `tool_execution_*`, `agent_end`. We aggregate text from `message_end`
 *      assistant events into the result and pull token usage from the
 *      `agent_end` event when present.
 *
 * Features kept from the previous (claude) engine:
 *   - Idle timeout: if no stdout for `idleTimeoutSeconds`, abort the run.
 *   - Abort signal: propagates cancellation into the sandbox exec.
 *   - Optional `onAgentStreamEvent` hook for telemetry.
 *
 * Features removed:
 *   - `--resume` and session-jsonl probing (no multi-iteration to resume).
 *   - `completionSignal` (no outer loop to short-circuit).
 *   - `maxIterations` (pi runs the full loop internally).
 */
import type { SandboxProvider, ExecOpts } from "./sandboxProvider.js";

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * Token usage from the sub-agent run. Field names match pi's
 * `AssistantMessage.usage` shape (snake_case-free, no `Tokens` suffix).
 */
export interface AgentUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export interface RunPiResult {
	/** Combined assistant-message text across the run. */
	readonly stdout: string;
	readonly usage?: AgentUsage;
	/** Number of model ↔ tools round-trips (turn_end events). */
	readonly turns: number;
	/** Session id from the pi session header (telemetry only — we don't resume). */
	readonly sessionId?: string;
	/** Every raw line received from stdout (including non-JSON noise). */
	readonly rawLines: string[];
	/** Full stderr from the subprocess. */
	readonly rawStderr: string;
}

/**
 * Subset of pi's `--mode json` event types we care about.
 * Other event shapes are forwarded to the optional hook untouched.
 */
export type PiStreamEvent =
	| { type: "session"; id: string; [k: string]: unknown }
	| { type: "agent_start"; [k: string]: unknown }
	| { type: "agent_end"; messages?: unknown; [k: string]: unknown }
	| { type: "turn_start"; [k: string]: unknown }
	| { type: "turn_end"; [k: string]: unknown }
	| { type: "message_start"; message?: unknown; [k: string]: unknown }
	| { type: "message_update"; message?: unknown; [k: string]: unknown }
	| { type: "message_end"; message?: unknown; [k: string]: unknown }
	| { type: "tool_execution_start"; [k: string]: unknown }
	| { type: "tool_execution_update"; [k: string]: unknown }
	| { type: "tool_execution_end"; [k: string]: unknown }
	| { type: string; [k: string]: unknown };

export interface RunPiOptions {
	readonly prompt: string;
	/** Host path; used as the cwd for the subprocess. */
	readonly cwd: string;
	readonly sandbox: SandboxProvider;
	/**
	 * Pi `--model` value. Pass `undefined` to omit the flag and let pi use
	 * its own default provider/model.
	 */
	readonly model: string | undefined;
	/**
	 * Text appended to pi's system prompt via `--append-system-prompt`.
	 * Used to inject the structured-output tag instruction at system priority
	 * so the sub-agent follows it reliably.
	 */
	readonly appendSystemPrompt?: string;
	/**
	 * Comma-separated allowlist of tool names passed to pi via `--tools`.
	 * When set, only these tools are available to the sub-agent.
	 * Example: `"read,grep,find,ls"` for a read-only scout.
	 * Mutually exclusive with `noTools`.
	 */
	readonly tools?: string;
	/**
	 * Pass `--no-tools` to pi, disabling all built-in tools.
	 * Use for pure-reasoning agents (planner, reviewer) that don't need
	 * filesystem or shell access.
	 * Mutually exclusive with `tools`.
	 */
	readonly noTools?: boolean;
	/**
	 * Skill files to load via `--skill <path>` (can be repeated).
	 * When non-empty, `--no-skills` is omitted so the explicit files load.
	 * When empty/absent, `--no-skills` is added as before.
	 */
	readonly skills?: readonly string[];
	/**
	 * When set, passes --session-id to pi so the sub-agent run is persisted
	 * as a named pi session. Derived from the host session + workflow context
	 * so the session is stable across retries.
	 */
	readonly sessionId?: string;
	/**
	 * Called once for each tool call the sub-agent makes.
	 * `inputPreview` is a concise (≤80 char) first-line representation of the input.
	 * `toolCallId` is the unique id from pi's `tool_execution_start` event.
	 */
	readonly onToolCall?: (toolName: string, inputPreview: string, toolCallId: string) => void;
	/**
	 * Called when a tool execution completes (tool_execution_end).
	 * Matched to `onToolCall` by `toolCallId`.
	 */
	readonly onToolEnd?: (toolCallId: string) => void;
	/**
	 * Called when the agent produces a meaningful text output line.
	 * Fired on `message_end` events; the preview is the first non-trivial line.
	 */
	readonly onOutput?: (preview: string) => void;
	/**
	 * Called whenever the running token total is updated (after each
	 * assistant message that carries usage info). Receives the cumulative
	 * usage so far. Use this to surface live token counts in UIs.
	 */
	readonly onUsage?: (usage: AgentUsage) => void;
	/**
	 * Called immediately when the session header is received (first JSON line
	 * from pi). Fires before any tool calls or assistant turns.
	 * Used to surface the session ID for debugging.
	 */
	readonly onSessionStart?: (sessionId: string) => void;
	/** Seconds before an idle (no-output) run is killed. Default 600. */
	readonly idleTimeoutSeconds?: number;
	readonly signal: AbortSignal;
	/** Label for logging; not forwarded to pi. */
	readonly name?: string;
	/** Optional hook — called for every parsed stream-json event. */
	readonly onAgentStreamEvent?: (e: PiStreamEvent) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract concatenated text from an assistant message's `content` array.
 * Pi assistant content is a list of typed blocks; we only care about `text`.
 */
function extractAssistantText(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const m = message as { role?: unknown; content?: unknown };
	if (m.role !== "assistant") return "";
	if (!Array.isArray(m.content)) return "";
	let out = "";
	for (const block of m.content as Array<{ type?: unknown; text?: unknown }>) {
		if (block.type === "text" && typeof block.text === "string") {
			out += block.text;
		}
	}
	return out;
}

/** Pull token usage from an assistant message in pi's shape. */
function extractMessageUsage(message: unknown): AgentUsage | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const m = message as { role?: unknown; usage?: unknown };
	if (m.role !== "assistant") return undefined;
	if (typeof m.usage !== "object" || m.usage === null) return undefined;
	const u = m.usage as Record<string, unknown>;
	const num = (v: unknown): number => (typeof v === "number" ? v : 0);
	const usage: AgentUsage = {
		input: num(u["input"]),
		output: num(u["output"]),
		cacheRead: num(u["cacheRead"]),
		cacheWrite: num(u["cacheWrite"]),
	};
	if (
		usage.input === 0 &&
		usage.output === 0 &&
		usage.cacheRead === 0 &&
		usage.cacheWrite === 0
	) {
		return undefined;
	}
	return usage;
}

/** Sum two usage objects, treating undefined as zero. */
function addUsage(a: AgentUsage | undefined, b: AgentUsage | undefined): AgentUsage | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
	};
}

function toolInputPreview(toolName: string, input: unknown): string {
	const obj = (input !== null && typeof input === "object") ? input as Record<string, unknown> : {};
	const str = (v: unknown): string => (typeof v === "string" ? v : "");
	switch (toolName) {
		case "bash":
			return str(obj["command"]).split("\n")[0]?.slice(0, 80) ?? "";
		case "read":
			return str(obj["path"]);
		case "write":
		case "edit":
			return str(obj["path"]);
		case "grep":
			return `"${str(obj["pattern"])}" in ${str(obj["path"]) || "."}`;
		case "find":
			return `"${str(obj["pattern"])}" in ${str(obj["path"]) || "."}`;
		default:
			return JSON.stringify(input).slice(0, 80);
	}
}

export function buildPiCommand(
	model: string | undefined,
	appendSystemPrompt?: string,
	tools?: string,
	noTools?: boolean,
	skills?: readonly string[],
	sessionId?: string,
): string[] {
	const cmd: string[] = [
		"pi",
		"--print",
		"--mode",
		"json",
		// Hermetic: prevents recursive load of our own extension and keeps
		// the sub-agent's runtime narrow and predictable.
		"--no-extensions",
	];
	if (sessionId !== undefined && sessionId !== "") {
		cmd.push("--session-id", sessionId);
	} else {
		cmd.push("--no-session");
	}
	if (model !== undefined && model !== "") {
		cmd.push("--model", model);
	}
	if (appendSystemPrompt !== undefined && appendSystemPrompt !== "") {
		// Inject the structured-output instruction at system level so the
		// sub-agent follows it reliably (user-prompt suffix is too easy to
		// override by the model's coding-assistant persona).
		cmd.push("--append-system-prompt", appendSystemPrompt);
	}
	if (skills !== undefined && skills.length > 0) {
		// Explicit skill files; omit --no-skills so they can load.
		for (const skill of skills) {
			cmd.push("--skill", skill);
		}
	} else {
		cmd.push("--no-skills");
	}
	if (noTools === true) {
		cmd.push("--no-tools");
	} else if (tools !== undefined && tools !== "") {
		cmd.push("--tools", tools);
	}
	return cmd;
}

// ── Engine ───────────────────────────────────────────────────────────────────

/**
 * Run pi --print inside the supplied sandbox and parse stream-json output.
 *
 * Returns the assistant's combined text, optional token usage, and the
 * session id from pi's session header.
 *
 * Throws on idle timeout, abort, or unrecoverable pi exit.
 */
export async function runPi(opts: RunPiOptions): Promise<RunPiResult> {
	const {
		prompt,
		cwd,
		sandbox,
		model,
		appendSystemPrompt,
		tools,
		noTools,
		skills,
		idleTimeoutSeconds = 600,
		signal,
		onAgentStreamEvent,
		onToolCall,
		onOutput,
		onSessionStart,
		// onToolEnd is accessed via opts.onToolEnd directly in onLine
	} = opts;

	if (signal.aborted) {
		const e = new Error("AbortError: workflow aborted");
		e.name = "AbortError";
		throw e;
	}

	let sessionId: string | undefined;
	let stdout = "";
	let usage: AgentUsage | undefined;
	let turns = 0;
	let pendingError: Error | undefined;
	const rawLines: string[] = [];

	// ── Abort + idle-timeout wiring ────────────────────────────────────────
	const innerAc = new AbortController();
	const IDLE_MS = idleTimeoutSeconds * 1000;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	const resetIdleTimer = (): void => {
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			const e = new Error(`Agent idle for ${idleTimeoutSeconds}s without output`);
			e.name = "IdleTimeoutError";
			innerAc.abort(e);
		}, IDLE_MS);
	};

	const onOuterAbort = (): void => {
		innerAc.abort(signal.reason);
	};
	signal.addEventListener("abort", onOuterAbort, { once: true });
	resetIdleTimer();

	// ── Line parser ────────────────────────────────────────────────────────
	const onLine = (line: string): void => {
		resetIdleTimer();
		rawLines.push(line);
		if (line.trim() === "") return;
		let event: PiStreamEvent;
		try {
			event = JSON.parse(line) as PiStreamEvent;
		} catch {
			// Non-JSON noise (e.g. startup banner from another tool) — ignore.
			return;
		}

		if (event.type === "session") {
			const id = (event as { id?: unknown }).id;
			if (typeof id === "string") {
				sessionId = id;
				onSessionStart?.(id);
			}
		} else if (event.type === "tool_execution_start") {
			const toolName = typeof event["name"] === "string" ? event["name"] : "tool";
			const preview = toolInputPreview(toolName, event["input"] ?? {});
			const toolCallId = typeof event["id"] === "string" ? event["id"] : `tc-${Date.now().toString(36)}`;
			onToolCall?.(toolName, preview, toolCallId);
		} else if (event.type === "tool_execution_end") {
			const id = typeof event["id"] === "string" ? event["id"] : undefined;
			if (id !== undefined) {
				opts.onToolEnd?.(id);
			}
		} else if (event.type === "message_end") {
			// If the provider returned an error turn (e.g. Bedrock network blocked
			// by the sandbox), abort and surface it rather than silently
			// producing empty stdout.
			const msg = (event as { message?: unknown }).message;
			if (typeof msg === "object" && msg !== null) {
				const m = msg as Record<string, unknown>;
				if (m["stopReason"] === "error" && typeof m["errorMessage"] === "string") {
					pendingError = new Error(`pi provider error: ${m["errorMessage"].slice(0, 512)}`);
					innerAc.abort(pendingError);
					return;
				}
			}
			// Aggregate assistant text. Each message_end may also carry usage
			// (pi attaches it per message); accumulate it here too.
			stdout += extractAssistantText(msg);
			const delta = extractMessageUsage(msg);
			if (delta !== undefined) {
				usage = addUsage(usage, delta);
				if (usage !== undefined) opts.onUsage?.(usage);
			}
			if (onOutput !== undefined) {
				const text = extractAssistantText(msg);
				const firstLine = text
					.split("\n")
					.map((l) => l.trim())
					.find((l) => l.length >= 15); // skip very short fragments
				if (firstLine !== undefined) {
					onOutput(firstLine.slice(0, 120));
				}
			}
		} else if (event.type === "turn_end") {
			turns++;
		} else if (event.type === "agent_end") {
			// Some pi versions only emit usage on agent_end's `messages` array.
			// Sum any usage we haven't already seen on per-message events.
			const messages = (event as { messages?: unknown }).messages;
			if (Array.isArray(messages) && usage === undefined) {
				let agg: AgentUsage | undefined;
				for (const m of messages) {
					agg = addUsage(agg, extractMessageUsage(m));
				}
				usage = agg;
				if (usage !== undefined) opts.onUsage?.(usage);
			}
		}

		onAgentStreamEvent?.(event);
	};

	// ── Execute ────────────────────────────────────────────────────────────
	const execOpts: ExecOpts = {
		command: buildPiCommand(model, appendSystemPrompt, tools, noTools, skills, opts.sessionId),
		cwd,
		stdin: prompt,
		onLine,
		signal: innerAc.signal,
		forceKillAfterMs: 5_000,
	};

	let execResult: import("./sandboxProvider.js").ExecResult | undefined;

	try {
		execResult = await sandbox.exec(execOpts);

		if (idleTimer !== undefined) clearTimeout(idleTimer);
		signal.removeEventListener("abort", onOuterAbort);

		if (pendingError !== undefined) {
			Object.assign(pendingError, { rawLines, rawStderr: execResult.stderr });
			throw pendingError;
		}

		if (signal.aborted) {
			const e = new Error("AbortError: workflow aborted");
			e.name = "AbortError";
			throw e;
		}

		if (execResult.exitCode !== 0 && stdout === "" && !innerAc.signal.aborted) {
			const e = new Error(
				`pi exited with code ${execResult.exitCode}` +
					(execResult.stderr ? `: ${execResult.stderr.slice(0, 512)}` : ""),
			);
			Object.assign(e, { rawLines, rawStderr: execResult.stderr });
			throw e;
		}
	} catch (err) {
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		signal.removeEventListener("abort", onOuterAbort);

		if (signal.aborted) {
			const e = new Error("AbortError: workflow aborted");
			e.name = "AbortError";
			throw e;
		}

		if (innerAc.signal.aborted) {
			const reason: unknown = innerAc.signal.reason;
			const toThrow = reason instanceof Error ? reason : new Error("aborted");
			Object.assign(toThrow, { rawLines, rawStderr: execResult?.stderr ?? "" });
			throw toThrow;
		}

		if (err instanceof Error) {
			Object.assign(err, { rawLines, rawStderr: execResult?.stderr ?? "" });
			throw err;
		}
		throw new Error(String(err));
	}

	return {
		stdout,
		...(usage !== undefined ? { usage } : {}),
		turns,
		...(sessionId !== undefined ? { sessionId } : {}),
		rawLines,
		rawStderr: execResult?.stderr ?? "",
	};
}
