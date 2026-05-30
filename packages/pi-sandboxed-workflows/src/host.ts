/**
 * WorkflowContext factory.
 *
 * `buildWorkflowHost(deps)` is called once per `/workflow:<name>` invocation.
 * It returns the `WorkflowContext` handed to the workflow's default export.
 *
 * Key responsibilities:
 *  - `publishStatusUpdate()` — forward events to pi without triggering an LLM turn.
 *  - `runAgent` — in-package runPi sub-agent (see src/agent.ts).
 *  - `askUser` — dispatch user questions through pi's interactive UI.
 *  - `createSandbox` / `createNoOpSandbox` / `createFakeSandbox` — top-level factory methods.
 *  - `createWorktree` — slim git worktree wrapper (see src/engine/worktree.ts).
 *
 * Default sandbox policy:
 *  - `noSandbox()` — no HOME override, no srt isolation.
 *  - Pi reads its provider config and API keys from `~/.pi/agent/settings.json`
 *    (the real home). Credentials come from the parent process's env.
 *  - Workflows that need OS-level isolation (e.g. an implementor writing to a
 *    worktree) should call `host.createSandbox()` explicitly.
 *
 * Note: the srt sandbox sets HOME=fakeHome which blocks pi from reading its
 * own config (~/.pi/agent/). Pi is not claude; it manages its own provider
 * credentials and must not have its home directory overridden by default.
 */
import { srt, noSandbox, fake } from "./sandbox/index.js";
import { createWorktree } from "./engine/worktree.js";
import { createAgentFn } from "./agent.js";
import { WorkflowWidgetState, type WidgetTheme, type WidgetComponent, type WidgetTui } from "./widgetState.js";
import type { SandboxProvider } from "./engine/sandboxProvider.js";
import type {
	WorkflowContext,
	WorkflowEvent,
	AskUserFn,
	Question,
	Answer,
} from "./types.js";

export type { WorkflowContext, WorkflowEvent, WorkflowModule } from "./types.js";
export { slugify } from "./agent.js";

/** customType used for every workflow-emitted message in pi chat. */
export const EVENT_CUSTOM_TYPE = "pi-sandboxed-workflows:event";

/**
 * Minimal slice of `pi.sendMessage` we depend on.
 * Tests inject a stub of this shape so they don't need a live `ExtensionAPI`.
 */
export type SendMessageFn = (
	message: {
		readonly customType: string;
		readonly content: string;
		readonly display: boolean;
		readonly details?: Record<string, unknown>;
	},
	options?: {
		readonly triggerTurn?: boolean;
		readonly deliverAs?: "steer" | "followUp" | "nextTurn";
	},
) => void;

/** UI surface for question dispatch. */
export interface UiForHost {
	readonly input: (prompt: string, defaultValue?: string) => Promise<string | null | undefined>;
	readonly select: (prompt: string, options: readonly string[]) => Promise<string | null | undefined>;
	readonly confirm: (title: string, body: string) => Promise<boolean>;
	readonly hasUI: boolean;
}

export interface BuildHostDeps {
	readonly name: string;
	readonly args: string;
	readonly cwd: string;
	readonly runId: string;
	readonly signal: AbortSignal;
	readonly sendMessage: SendMessageFn;
	/**
	 * Optional toast sink. When provided, `host.publish({ kind: "error", ... })`
	 * also fires a `notify(message, "error")` so the user spots the failure
	 * without having to scroll the chat.
	 */
	readonly notify?: (message: string, level: "info" | "warning" | "error") => void;
	/**
	 * Prefix for deriving stable sub-agent session IDs.
	 * Computed from `rootSessionId + workflow name` in runtime.ts.
	 * Omit for ephemeral (no-session) runs.
	 */
	readonly sessionPrefix?: string;
	/**
	 * UI surface for `host.askUser`. When absent (non-interactive mode or
	 * tests that don't call askUser), asking will throw WorkflowError.
	 */
	readonly ui?: UiForHost;
	/**
	 * Widget registration function from `ctx.ui.setWidget`.
	 * Absent when running in non-interactive (print/RPC) mode.
	 */
	readonly setWidget?: (
		key: string,
		factory: ((tui: WidgetTui, theme: WidgetTheme) => WidgetComponent) | undefined,
	) => void;
	/**
	 * TEST-ONLY seam — reserved for future use.
	 */
	readonly _reserved?: never;
}

export function buildWorkflowHost(deps: BuildHostDeps): WorkflowContext {
	// ── publishStatusUpdate ─────────────────────────────────────────────────
	const publishStatusUpdate = (event: WorkflowEvent): void => {
		try {
			deps.sendMessage(
				{
					customType: EVENT_CUSTOM_TYPE,
					content: event.message,
					display: event.display ?? false,
					details: {
						...(event.details ?? {}),
						kind: event.kind,
						runId: deps.runId,
						name: deps.name,
					},
				},
				{ triggerTurn: false },
			);
		} catch {
			// Swallow — workflow code must not have to defend against UI failure.
		}

		if (event.kind === "error" && deps.notify !== undefined) {
			try {
				deps.notify(event.message, "error");
			} catch {
				/* swallow */
			}
		}
	};

	// ── lazy default sandbox (cached per host instance) ────────────────────
	let _cachedDefaultSandbox: SandboxProvider | undefined;

	function getRegion(): string {
		return (
			process.env["AWS_REGION"] ??
			process.env["WORKFLOW_AWS_REGION"] ??
			"us-west-2"
		);
	}

	function getDefaultSandbox(): SandboxProvider {
		if (_cachedDefaultSandbox !== undefined) return _cachedDefaultSandbox;
		// Use noSandbox so pi can read its own config (~/.pi/agent/settings.json)
		// and provider API keys from the real home directory. Pi manages its own
		// credentials; it must not have HOME overridden by the srt fakeHome.
		// Credentials for the parent's LLM provider flow through process.env.
		_cachedDefaultSandbox = noSandbox();
		return _cachedDefaultSandbox;
	}

	/**
	 * `host.createSandbox` — srt factory exposed to workflows.
	 * Auto-whitelists the Bedrock runtime endpoint so the pi sub-agent
	 * can reach the LLM. Caller-supplied allowedDomains are merged in.
	 * Credentials flow through the inherited process env (AWS_PROFILE +
	 * ~/.aws/) — no static keys are injected.
	 */
	function createSandbox(opts?: Parameters<typeof srt>[0]): SandboxProvider {
		const region = getRegion();
		const bedrockDomains = [`bedrock-runtime.${region}.amazonaws.com`, "sts.amazonaws.com"];
		const allowedDomains = Array.from(
			new Set([...bedrockDomains, ...(opts?.allowedDomains ?? [])]),
		);
		return srt({
			...(opts ?? {}),
			allowedDomains,
			...(opts?.env !== undefined ? { env: opts.env } : {}),
		});
	}

	// ── Widget ────────────────────────────────────────────────────────────────
	const widgetState = deps.setWidget !== undefined
		? new WorkflowWidgetState(deps.name)
		: undefined;

	let _requestRender: (() => void) | undefined;

	if (deps.setWidget !== undefined && widgetState !== undefined) {
		deps.setWidget("pi-sandboxed-workflows", (tui, theme) => {
			_requestRender = () => tui.requestRender();
			let spinnerFrame = 0;
			const timer = setInterval(() => {
				spinnerFrame++;
				tui.requestRender();
			}, 100);
			return {
				render(width: number): string[] {
					return widgetState.renderLines(width, spinnerFrame, theme);
				},
				invalidate(): void { /* theme changed; render() will pick up new theme */ },
				dispose(): void {
					clearInterval(timer);
					_requestRender = undefined;
				},
			};
		});
	}

	// ── agent ────────────────────────────────────────────────────────────────
	const agent = createAgentFn({
		signal: deps.signal,
		onEvent: (e) => {
			if (widgetState !== undefined) {
				widgetState.update(e);
				_requestRender?.();
			}
			if (e.kind === "agent.session") {
				const ev = e as { label: string; sessionId: string; display: boolean };
				if (ev.display) {
					publishStatusUpdate({
						kind: "agent-session",
						message: `▶ ${ev.label}  session: ${ev.sessionId}`,
						display: true,
					});
				}
			}
			if (e.kind === "agent.input") {
				const ev = e as { label: string; prompt: string; appendSystemPrompt?: string; command?: string[]; attempt: number; display: boolean };
				if (ev.display) {
					const cmdLine = ev.command !== undefined ? `\`${ev.command.join(" ")}\`\n\n` : "";
					const sysPart = ev.appendSystemPrompt !== undefined
						? `\n\n**System prompt append:**\n\`\`\`\n${ev.appendSystemPrompt}\n\`\`\``
						: "";
					publishStatusUpdate({
						kind: "agent-input",
						message: `📥 **${ev.label}** — attempt ${String(ev.attempt + 1)}\n\n${cmdLine}${ev.prompt}${sysPart}`,
						display: true,
					});
				}
			}
			if (e.kind === "agent.output_complete") {
				const ev = e as { label: string; output: string; display: boolean };
				if (ev.display) {
					publishStatusUpdate({
						kind: "agent-output",
						message: `📤 **${ev.label}**\n\n${ev.output}`,
						display: true,
					});
				}
			}
			if (e.kind === "agent.raw_output") {
				const ev = e as { label: string; rawLines: string[]; rawStderr: string; display: boolean };
				if (ev.display) {
					// Extract errors and notable events from JSON lines rather than
					// dumping raw JSON — keeps the debug output readable.
					const notable: string[] = [];
					for (const line of ev.rawLines) {
						try {
							const parsed = JSON.parse(line) as Record<string, unknown>;
							const type = parsed["type"];
							const msg = parsed["message"] as Record<string, unknown> | undefined;
							const errMsg = msg?.["errorMessage"] ?? parsed["errorMessage"];
							if (typeof errMsg === "string") {
								notable.push(`❌ [${typeof type === "string" ? type : "error"}] ${errMsg}`);
							} else if (type === "session") {
								notable.push(`🔑 session ${typeof parsed["id"] === "string" ? parsed["id"] : ""}`);
							} else if (type === "message_start" && msg?.["role"] === "assistant") {
								notable.push(`🤖 assistant turn — model: ${typeof msg["model"] === "string" ? msg["model"] : ""}`);
							}
						} catch {
							// Non-JSON line — show as-is
							notable.push(`  ${line}`);
						}
					}
					if (notable.length > 0) {
						publishStatusUpdate({
							kind: "agent-raw-stdout",
							message: `📋 **${ev.label}** stdout summary:\n\n${notable.join("\n")}`,
							display: true,
						});
					}
					if (ev.rawStderr.trim().length > 0) {
						publishStatusUpdate({
							kind: "agent-raw-stderr",
							message: `⚠️ **${ev.label}** stderr:\n\n\`\`\`\n${ev.rawStderr.trim()}\n\`\`\``,
							display: true,
						});
					}
				}
			}
		},
		defaultSandbox: getDefaultSandbox,
		cwd: deps.cwd,
		...(deps.sessionPrefix !== undefined ? { sessionPrefix: deps.sessionPrefix } : {}),
	});

	// ── askUser ──────────────────────────────────────────────────────────────
	const askUser: AskUserFn = async (q: Question): Promise<Answer> => {
		if (deps.signal.aborted) {
			const e = new Error("AbortError: workflow aborted");
			e.name = "AbortError";
			throw e;
		}

		if (deps.ui === undefined || !deps.ui.hasUI) {
			throw new Error(
				"host.askUser requires an interactive session (ctx.hasUI === false)",
			);
		}

		// Listen for abort mid-question.
		const abortPromise = new Promise<never>((_, reject) => {
			const onAbort = (): void => {
				const e = new Error("AbortError: workflow aborted");
				e.name = "AbortError";
				reject(e);
			};
			if (deps.signal.aborted) {
				onAbort();
			} else {
				deps.signal.addEventListener("abort", onAbort, { once: true });
			}
		});

		const id = q.id;

		if (q.kind === "input") {
			const rawValue = await Promise.race([
				deps.ui.input(q.text, q.default),
				abortPromise,
			]);
			return {
				...(id !== undefined ? { id } : {}),
				kind: "input",
				value: rawValue ?? "",
			};
		}

		if (q.kind === "select") {
			const rawValue = await Promise.race([
				deps.ui.select(q.text, q.options),
				abortPromise,
			]);
			if (rawValue === null || rawValue === undefined) {
				if (q.default !== undefined) {
					return { ...(id !== undefined ? { id } : {}), kind: "select", value: q.default };
				}
				throw new Error("host.askUser: user cancelled selection with no default");
			}
			return { ...(id !== undefined ? { id } : {}), kind: "select", value: rawValue };
		}

		// kind === "confirm"
		const confirmed = await Promise.race([
			deps.ui.confirm("", q.text),
			abortPromise,
		]);
		return { ...(id !== undefined ? { id } : {}), kind: "confirm", value: confirmed };
	};

	return {
		name: deps.name,
		args: deps.args,
		cwd: deps.cwd,
		runId: deps.runId,
		signal: deps.signal,
		publishStatusUpdate,
		runAgent: agent,
		askUser,
		createWorktree,
		createSandbox,
		createNoOpSandbox: noSandbox,
		createFakeSandbox: fake,
	};
}
