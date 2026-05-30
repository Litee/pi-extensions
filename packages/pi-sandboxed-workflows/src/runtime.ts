/**
 * Workflow runtime — load `<script>.path` via dynamic `import()` and invoke
 * its default export with a {@link WorkflowContext}.
 *
 * Lifecycle the framework owns:
 *   1. publish a `started` event so chat shows the workflow began;
 *   2. await `mod.default(host)` (workflow's own events flow through);
 *   3. publish a `completed` or `error` event;
 *   4. clear the status pill.
 *
 * Concurrency: at most one active run per process. Second invocation while
 * one is in flight surfaces a `notify("error", ...)` toast AND publishes a
 * `concurrent-rejected` chat message via `pi.sendMessage`, so the LLM sees
 * the rejection in its next-turn context.
 *
 * Error visibility contract
 * ------------------------
 * Every framework error path is dual-emitted:
 *   - `pi.sendMessage(...)`  → the authoritative LLM-visible channel.
 *     Workflow chat messages with `customType:
 *     "pi-sandboxed-workflows:event"` show up in session history and are
 *     included in the next LLM prompt.
 *   - `ctx.ui.notify(...)`   → immediate UX toast.
 * `notify` alone is NEVER used for an error condition because notifies do
 * not enter the LLM context.
 */
import { pathToFileURL } from "node:url";

import {
	buildWorkflowHost,
	EVENT_CUSTOM_TYPE,
	slugify,
	type SendMessageFn,
	type UiForHost,
} from "./host.js";
import type { WorkflowModule } from "./types.js";

const STATUS_KEY = "pi-sandboxed-workflows";

/** Workflow script shape from {@link findWorkflowScripts}. Re-declared here so
 * the runtime module does not depend on discovery internals. */
export interface WorkflowScriptRef {
	readonly name: string;
	readonly path: string;
}

export interface RunWorkflowDeps {
	/** pi.sendMessage shim; see {@link SendMessageFn}. */
	readonly sendMessage: SendMessageFn;
	/** ctx.ui.notify shim. */
	readonly notify: (
		message: string,
		level?: "info" | "warning" | "error",
	) => void;
	/** ctx.ui.setStatus shim. Optional; may be a no-op outside interactive mode. */
	readonly setStatus: (key: string, content: string) => void;
	/** ctx.ui.setStatus(key, undefined) shim. */
	readonly clearStatus: (key: string) => void;
	/** ctx.cwd. */
	readonly cwd: string;
	/** ctx.signal — propagated into host.signal when present. */
	readonly signal: AbortSignal | undefined;
	/**
	 * Override `os.homedir()` for run history persistence.
	 * @deprecated No longer used — run history is managed via pi --session-id.
	 */
	readonly homedir?: string;
	/**
	 * Root pi session ID from the host session. Used to derive sub-agent session IDs.
	 * When provided, sub-agent sessions are persisted under deterministic IDs.
	 */
	readonly rootSessionId?: string;
	/** Invocation sequence number (incremented per /workflow:X call in the session).
	 * Combined with rootSessionId to namespace sub-agent sessions so two invocations
	 * of the same workflow never share a session ID. */
	readonly runSeq?: number;
	/**
	 * UI surface for `host.askUser`.
	 * Built from `ctx.ui` + `ctx.hasUI` by {@link depsFromCtx}.
	 * Absent in non-interactive mode (print / RPC) — `host.askUser` will throw.
	 */
	readonly ui?: UiForHost;
	/**
	 * Registers a live-updating TUI component above the editor.
	 * The factory receives `(tui, theme)` and returns a Component with
	 * `render(width): string[]`, `invalidate()`, and optional `dispose()`.
	 * Only defined when `ctx.hasUI` is true.
	 * Pass `undefined` as factory to clear the widget.
	 */
	readonly setWidget?: (
		key: string,
		factory: ((tui: { requestRender(): void }, theme: {
			fg(color: string, text: string): string;
			dim(text: string): string;
			bold(text: string): string;
		}) => { render(width: number): string[]; invalidate(): void; dispose?(): void }) | undefined,
	) => void;
}

export interface RunWorkflowParams {
	readonly deps: RunWorkflowDeps;
	readonly script: WorkflowScriptRef;
	readonly args: string;
}

// Module-level concurrency latch.
let activeRunId: string | undefined;

/** Reset the latch. Test-only escape hatch. */
export function resetActiveRunForTests(): void {
	activeRunId = undefined;
}

/** True iff a workflow is currently running in this pi process. */
export function isWorkflowActive(): boolean {
	return activeRunId !== undefined;
}

/**
 * Load and run a workflow file. Always resolves (errors become events).
 */
export async function runWorkflow(params: RunWorkflowParams): Promise<void> {
	const { deps, script, args } = params;

	if (activeRunId !== undefined) {
		const rejection = `Cannot start /workflow:${script.name}: another workflow is already running (run ${activeRunId}).`;
		// LLM-visible chat message. Without this the LLM has no idea the
		// rejection happened — a notify-only path is invisible to the model.
		try {
			deps.sendMessage(
				{
					customType: EVENT_CUSTOM_TYPE,
					content: rejection,
					display: true,
					details: {
						kind: "concurrent-rejected",
						name: script.name,
						activeRunId,
						requestedScript: script.name,
					},
				},
				{ triggerTurn: false },
			);
		} catch {
			/* swallow — sendMessage failures must not block toast/return */
		}
		deps.notify(rejection, "error");
		return;
	}

	const runId = makeRunId();
	activeRunId = runId;

	// Compute a deterministic session prefix for sub-agent session IDs.
	const sessionPrefix = deps.rootSessionId !== undefined
		? slugify(`${deps.rootSessionId}-${script.name}-${String(deps.runSeq ?? 0)}`)
		: undefined;

	// Bridge ctx.signal → an internal AbortController so we always own a
	// definite signal for host.signal (sandcastle requires AbortSignal,
	// not AbortSignal | undefined).
	const ac = new AbortController();
	const onParentAbort = (): void => {
		ac.abort(deps.signal?.reason);
	};
	if (deps.signal !== undefined) {
		if (deps.signal.aborted) {
			ac.abort(deps.signal.reason);
		} else {
			deps.signal.addEventListener("abort", onParentAbort, { once: true });
		}
	}

	deps.setStatus(STATUS_KEY, `${script.name}: running`);

	const publishLifecycle = (
		kind: "started" | "completed" | "error",
		message: string,
		details: Record<string, unknown> = {},
	): void => {
		try {
			deps.sendMessage(
				{
					customType: EVENT_CUSTOM_TYPE,
					content: message,
					display: true,
					details: { ...details, kind, runId, name: script.name },
				},
				{ triggerTurn: false },
			);
		} catch {
			// Swallow — UI failures must not break run cleanup.
		}
		// Lifecycle errors also fire a toast for immediate UX. The sendMessage
		// above is the LLM-visible channel; this notify is purely the user-
		// facing surface.
		if (kind === "error") {
			try {
				deps.notify(message, "error");
			} catch {
				/* swallow */
			}
		}
	};

	publishLifecycle("started", `Started /workflow:${script.name}`, { args });

	try {
		// Cache-bust on every invocation so edits to the workflow file are
		// picked up without `/reload`. jiti respects the URL with a query
		// string and re-loads + transpiles on cache misses.
		const url = `${pathToFileURL(script.path).href}?t=${Date.now().toString()}`;
		const mod = (await import(url)) as Partial<WorkflowModule> & {
			default?: unknown;
		};
		if (!("default" in mod) || mod.default === undefined) {
			publishLifecycle(
				"error",
				`Workflow ${script.path} has no default export.`,
			);
			return;
		}
		const fn = mod.default;
		if (typeof fn !== "function") {
			publishLifecycle(
				"error",
				`Workflow ${script.path} default export is not a function (got ${typeof fn}).`,
			);
			return;
		}

		const host = buildWorkflowHost({
			name: script.name,
			args,
			cwd: deps.cwd,
			runId,
			signal: ac.signal,
			sendMessage: deps.sendMessage,
			notify: deps.notify,
			...(sessionPrefix !== undefined ? { sessionPrefix } : {}),
			...(deps.ui !== undefined ? { ui: deps.ui } : {}),
			...(deps.setWidget !== undefined ? { setWidget: deps.setWidget } : {}),
		});

		const result = await Promise.resolve(fn(host));
		publishLifecycle(
			"completed",
			`Completed /workflow:${script.name}`,
			result === undefined ? {} : { result },
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		publishLifecycle(
			"error",
			message,
			err instanceof Error && err.stack !== undefined
				? { stack: err.stack }
				: {},
		);
	} finally {
		activeRunId = undefined;
		if (deps.signal !== undefined) {
			deps.signal.removeEventListener("abort", onParentAbort);
		}
		deps.setWidget?.(STATUS_KEY, undefined);
		deps.clearStatus(STATUS_KEY);
	}
}

function makeRunId(): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 8);
	return `${ts}-${rand}`;
}
