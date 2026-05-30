/**
 * Public type surface for workflow scripts.
 *
 * Workflow files in `<cwd>/.pi/workflows/<name>.ts` should declare:
 *
 * ```ts
 * import type { WorkflowContext } from "pi-sandboxed-workflows";
 *
 * export default async function (host: WorkflowContext): Promise<void> {
 *   host.publishStatusUpdate({ kind: "started", message: `running ${host.name}` });
 *   // ...
 * }
 * ```
 *
 * The `import type` is erased at runtime so the workflow file does NOT need
 * `pi-sandboxed-workflows` installed in its own `node_modules` — the
 * framework injects every helper through the `host` argument.
 *
 * Changes vs the sandcastle-backed version:
 *   - `SandboxProvider` is our own interface (src/engine/sandboxProvider.ts).
 *   - `createWorktree` / `CreateWorktreeOptions` / `Worktree` come from
 *     src/engine/worktree.ts — no @ai-hero/sandcastle dependency.
 *   - `WorktreeBranchStrategy` replaces sandcastle's `WorktreeBranchStrategy`
 *     (same shapes; adds `{ type: "head" }` which sandcastle excluded).
 *   - `Worktree` no longer exposes `.run()`, `.interactive()`, or
 *     `.createSandbox()` (intentional: workflows use `host.runAgent` instead).
 *   - `host.sandbox` namespace removed; factories are top-level `create*` methods.
 */
import type { SandboxProvider } from "./engine/sandboxProvider.js";
import type {
	createWorktree,
	CreateWorktreeOptions,
	Worktree,
	BranchStrategy as WorktreeBranchStrategy,
} from "./engine/worktree.js";

import type {
	srt as srtImpl,
	noSandbox as noSandboxImpl,
	fake as fakeImpl,
} from "./sandbox/index.js";
import type { AgentFn, AgentMeta, AgentOpts, JsonSchema } from "./agent.js";
import type {
	FakeSandboxOptions,
	FakeResponse,
	FakeCall,
	FakeSandboxProvider,
} from "./sandbox/fake.js";
import type { NoSandboxOptions } from "./sandbox/noSandbox.js";
import type { SrtOptions } from "./sandbox/srt.js";

// Canonical public names for each factory's option bag.
// We keep the original module-level names as aliases so internal code
// can still use them; workflow authors import the Create* names.
export type CreateSandboxOptions = SrtOptions;
export type CreateNoOpSandboxOptions = NoSandboxOptions;
export type CreateFakeSandboxOptions = FakeSandboxOptions;

// Re-export so workflow authors can import these types without knowing
// the internal module layout.
export type {
	AgentFn,
	AgentMeta,
	AgentOpts,
	JsonSchema,
	SandboxProvider,
	// Legacy aliases (kept for internal use; workflow authors prefer Create* names)
	SrtOptions,
	NoSandboxOptions,
	FakeSandboxOptions,
	FakeResponse,
	FakeCall,
	FakeSandboxProvider,
	// Worktree types — needed by workflows that use host.createWorktree.
	CreateWorktreeOptions,
	Worktree,
	WorktreeBranchStrategy,
};

/** A single progress event published from inside a workflow. */
export interface WorkflowEvent {
	/** Workflow-defined string. The framework reserves `started`, `error`, `completed`. */
	readonly kind: string;
	/** Short human-readable line shown in pi chat. */
	readonly message: string;
	/** Freeform structured payload — surfaced via the message renderer's details. */
	readonly details?: Record<string, unknown>;
	/**
	 * When `true`, the message is rendered visibly in the pi chat window
	 * (the LLM also sees it). When `false` (default), the message is
	 * delivered to the LLM context only — not shown visually.
	 * Use `true` sparingly: for final results that the user must read.
	 */
	readonly display?: boolean;
}

/**
 * Argument passed to a workflow's default export.
 *
 * v2 surface:
 * - `runAgent` — in-package runPi sub-agent.
 * - `createSandbox` / `createNoOpSandbox` / `createFakeSandbox` — top-level
 *   sandbox factory methods (no `host.sandbox` namespace).
 * - `askUser` — direct user-question dispatch (interactive mode only).
 * - `createWorktree` — slim git worktree wrapper.
 */
export interface WorkflowContext {
	/** Script basename without `.ts`. Same as the suffix of `/workflow:<name>`. */
	readonly name: string;
	/** Raw text the user typed after `/workflow:<name>`. May be empty. */
	readonly args: string;
	/** Working directory pi was launched in (a.k.a. `ctx.cwd`). */
	readonly cwd: string;
	/** Opaque per-invocation id; useful for logs and run-correlation. */
	readonly runId: string;
	/** Aborts when the user cancels the workflow (Esc / Ctrl+C). */
	readonly signal: AbortSignal;

	/** Post a non-LLM-triggering chat update. Errors are swallowed. */
	publishStatusUpdate(event: WorkflowEvent): void;

	/**
	 * The ONE primitive for spawning sub-agents.
	 *
	 * Every call goes through `runPi` inside a sandbox (default:
	 * read-only srt with Bedrock allow-list). No direct Bedrock SDK calls.
	 *
	 * When `opts.schema` is provided the framework auto-injects the tag
	 * footer, scans the combined stdout for the last `<pi_sw_result>` block,
	 * parses and AJV-validates, and retries on failures.
	 *
	 * `host.signal` is propagated into every runPi call.
	 *
	 * @returns `T` when schema is given; `string` otherwise.
	 */
	runAgent: AgentFn;

	/**
	 * Ask the user a single question via pi's interactive UI.
	 *
	 * Throws `WorkflowError` when the session is non-interactive
	 * (`ctx.hasUI === false`). Workflow authors who want a fallback wrap
	 * the call with try/catch.
	 *
	 * Rejects with `AbortError` when `host.signal` fires.
	 */
	askUser: AskUserFn;

	/**
	 * Create an OS-sandboxed provider (Seatbelt on macOS, bubblewrap on Linux).
	 *
	 * Runs the real `pi` CLI subprocess inside a Seatbelt/bubblewrap
	 * policy. Bedrock credentials are auto-injected; workflow-supplied `env`
	 * keys override them on collision. Use for any sub-agent that must be
	 * isolated from the host filesystem and network.
	 *
	 * **This spawns real subprocesses and incurs real LLM cost.**
	 * For unit tests, use `host.createFakeSandbox()` instead.
	 */
	createSandbox: typeof srtImpl;

	/**
	 * Create a no-isolation provider. Runs the real `pi` CLI subprocess
	 * directly on the host — no Seatbelt, no bubblewrap, no policy.
	 *
	 * **This spawns real subprocesses and incurs real LLM cost.**
	 * The only difference from `createSandbox` is the absence of OS-level
	 * isolation. Useful for CI runners or Docker containers that provide
	 * isolation externally, or for debugging sandbox-policy issues by
	 * stripping Seatbelt from the equation.
	 *
	 * Do NOT confuse with `createFakeSandbox`: noOp still runs the real
	 * pi CLI and makes real filesystem writes. It is not a mock.
	 */
	createNoOpSandbox: typeof noSandboxImpl;

	/**
	 * Create an in-process fake sandbox for unit tests.
	 *
	 * **This spawns NO subprocesses and incurs ZERO LLM cost.**
	 * Responses are keyed by agent label and consumed from a FIFO queue you
	 * configure in your test. All invocations are logged to `.calls` for
	 * assertion after the fact.
	 *
	 * This is the ONLY sandbox suitable for fast, hermetic unit tests. Do
	 * not use `createNoOpSandbox` in tests — it would invoke the real pi
	 * CLI and charge your LLM account.
	 */
	createFakeSandbox: typeof fakeImpl;

	/**
	 * Create a git worktree for an isolated, writable agent run.
	 *
	 * Slim wrapper around `git worktree add`. The handle is
	 * `await using`-compatible and exposes `.worktreePath` and `.branch`.
	 *
	 * Intentional divergence from the sandcastle-backed version:
	 *   - `.run()`, `.interactive()`, `.createSandbox()` are NOT available.
	 *     Workflows use `host.runAgent(..., { cwd: wt.worktreePath })` instead.
	 *   - `{ type: "head" }` strategy is now supported (no-op handle).
	 *
	 * ```ts
	 * await using wt = await host.createWorktree({
	 *   cwd: host.cwd,
	 *   branchStrategy: { type: "branch", branch: "pi-sw/my-branch" },
	 * });
	 * await host.runAgent("implement the plan", { cwd: wt.worktreePath });
	 * ```
	 */
	readonly createWorktree: typeof createWorktree;
}

// ── askUser types ────────────────────────────────────────────────────────────

export type Question =
	| {
			readonly id?: string;
			readonly kind: "input";
			readonly text: string;
			readonly default?: string;
	  }
	| {
			readonly id?: string;
			readonly kind: "select";
			readonly text: string;
			readonly options: readonly string[];
			readonly default?: string;
	  }
	| {
			readonly id?: string;
			readonly kind: "confirm";
			readonly text: string;
			readonly default?: boolean;
	  };

export type Answer =
	| { readonly id?: string; readonly kind: "input"; readonly value: string }
	| { readonly id?: string; readonly kind: "select"; readonly value: string }
	| {
			readonly id?: string;
			readonly kind: "confirm";
			readonly value: boolean;
	  };

export type AskUserFn = (q: Question) => Promise<Answer>;

/** A workflow module — what `await import(workflowPath)` should resolve to. */
export interface WorkflowModule {
	default: (host: WorkflowContext) => Promise<unknown>;
}
