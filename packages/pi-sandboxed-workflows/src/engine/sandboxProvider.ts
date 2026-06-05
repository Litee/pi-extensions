/**
 * Internal SandboxProvider interface — replaces @ai-hero/sandcastle's
 * BindMountSandboxProvider with a focused, minimal contract.
 *
 * Every provider (srt, noSandbox, fake) satisfies this interface.
 * `runClaudeCode` drives providers exclusively through `exec()`.
 *
 * Changes vs sandcastle's BindMountSandboxProvider:
 *   - No `create()` step / handle split — setup is eager in the provider ctor.
 *   - `command` is `string | readonly string[]` (array avoids shell-quoting issues).
 *   - `signal` in ExecOpts: providers kill the subprocess when fired.
 *   - `sandboxHomedir`: optional path to the home dir inside the sandbox;
 *     used by runClaudeCode to locate claude session JSONL for `--resume`.
 */

/** Options for a single `exec()` invocation. */
export interface ExecOpts {
	/** Shell string OR argv array. Providers run arrays without a shell. */
	readonly command: string | readonly string[];
	/** Working directory for the spawned process. */
	readonly cwd?: string;
	/** Extra env vars merged on top of the provider's own env. */
	readonly env?: Record<string, string>;
	/** Written to the subprocess stdin and closed immediately. */
	readonly stdin?: string;
	/**
	 * Called for each decoded line of stdout (streaming).
	 * Implementations MUST emit lines as they arrive — not buffer until exit.
	 */
	readonly onLine?: (line: string) => void;
	/**
	 * When aborted, the provider kills the subprocess (SIGTERM, then SIGKILL
	 * after a grace period) and rejects the returned Promise.
	 */
	readonly signal?: AbortSignal;
	/**
	 * Milliseconds after SIGTERM to send SIGKILL when the abort signal fires.
	 * Prevents a subprocess that ignores SIGTERM (e.g. blocked on a long
	 * network call) from hanging indefinitely. Default: 5000.
	 */
	readonly forceKillAfterMs?: number;
}

/** Result of a completed exec. */
export interface ExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** The core sandbox abstraction used by runClaudeCode and the agent loop. */
export interface SandboxProvider {
	/** Human-readable name (logged in events). */
	readonly name: string;
	/**
	 * Absolute path to the home directory INSIDE the sandbox.
	 * - srt: path to the per-run fakeHome directory.
	 * - noSandbox: undefined (home == host $HOME).
	 * - fake: undefined.
	 * Used by runClaudeCode to locate `$HOME/.claude/projects/<session>.jsonl`.
	 */
	readonly sandboxHomedir?: string;
	/** Execute a command inside the sandbox. */
	exec(opts: ExecOpts): Promise<ExecResult>;
}
