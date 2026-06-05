/**
 * Slim git-worktree wrapper — replaces @ai-hero/sandcastle's createWorktree.
 *
 * Only exposes what pi workflows actually need:
 *   - `worktreePath`  — host path to the checked-out branch
 *   - `branch`        — the branch name in use
 *   - `dispose()`     — clean up the worktree
 *   - `[Symbol.asyncDispose]()` — for `await using`
 *
 * Worktree paths live under `<cwd>/.pi-workflows/worktrees/<sanitized-branch>`.
 *
 * Branch strategies:
 *   - `{ type: "branch", branch }` — creates a new git worktree on that branch.
 *   - `{ type: "head" }`            — returns a no-op handle pointing at cwd.
 *   - `{ type: "merge-to-head" }`   — creates a temp branch, on dispose
 *                                      fast-forward merges back to HEAD.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, rmdirSync } from "node:fs";
import { join } from "node:path";

export type BranchStrategy =
	| { readonly type: "branch"; readonly branch: string }
	| { readonly type: "head" }
	| { readonly type: "merge-to-head" };

export interface CreateWorktreeOptions {
	/** Host repo root — all git operations anchor here. */
	readonly cwd: string;
	readonly branchStrategy: BranchStrategy;
	readonly signal?: AbortSignal;
	/**
	 * Called when a merge-to-head dispose() fails (e.g. --ff-only conflict).
	 * Receives the temp branch name so the caller can surface a warning.
	 */
	readonly onMergeFailure?: (tempBranch: string, error: unknown) => void;
}

export interface Worktree {
	readonly worktreePath: string;
	readonly branch: string;
	dispose(): Promise<void>;
	[Symbol.asyncDispose](): Promise<void>;
}

/** Replace characters that are invalid or problematic in file paths. */
function sanitizeBranch(branch: string): string {
	return branch.replace(/[^a-zA-Z0-9._/-]/g, "-").replace(/\//g, "-");
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function currentBranch(cwd: string): string {
	try {
		return git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
	} catch {
		return "HEAD";
	}
}

/**
 * Creates a git worktree as an independent worktree.
 * Returns a Worktree handle with dispose() and [Symbol.asyncDispose]().
 */
export function createWorktree(
	opts: CreateWorktreeOptions,
): Promise<Worktree> {
	const { cwd, branchStrategy, signal, onMergeFailure } = opts;

	if (signal?.aborted) {
		const abortReason: unknown = signal.reason;
		return Promise.reject(abortReason instanceof Error ? abortReason : new Error("AbortError: aborted"));
	}

	// ── head: no worktree, just point at cwd ────────────────────────────────
	if (branchStrategy.type === "head") {
		const branch = currentBranch(cwd);
		const headWorktree: Worktree = {
			worktreePath: cwd,
			branch,
			dispose(): Promise<void> {
				return Promise.resolve();
			},
			[Symbol.asyncDispose](): Promise<void> {
				return Promise.resolve();
			},
		};
		return Promise.resolve(headWorktree);
	}

	// ── branch: create a named worktree ─────────────────────────────────────
	if (branchStrategy.type === "branch") {
		const { branch } = branchStrategy;
		const sanitized = sanitizeBranch(branch);
		const worktreesDir = join(cwd, ".pi-workflows", "worktrees");
		mkdirSync(worktreesDir, { recursive: true });
		const worktreePath = join(worktreesDir, sanitized);

		try {
			// Remove any stale worktree at this path.
			if (existsSync(worktreePath)) {
				try {
					git(cwd, "worktree", "remove", worktreePath, "--force");
				} catch {
					/* already gone */
				}
			}

			git(cwd, "worktree", "add", worktreePath, "-b", branch);
		} catch (err) {
			// Clean up the empty directories we just created so they don't
			// linger on disk when git worktree add fails (e.g. not a git repo).
			try { rmdirSync(worktreesDir); } catch { /* not empty */ }
			try { rmdirSync(join(cwd, ".pi-workflows")); } catch { /* not empty */ }
			return Promise.reject(err instanceof Error ? err : new Error(String(err)));
		}

		const branchWorktree: Worktree = {
			worktreePath,
			branch,
			dispose(): Promise<void> {
				try {
					git(cwd, "worktree", "remove", worktreePath, "--force");
				} catch {
					/* best-effort */
				}
				try {
					git(cwd, "branch", "-d", branch);
				} catch {
					/* ignore — might have commits the caller wants to keep */
				}
				return Promise.resolve();
			},
			[Symbol.asyncDispose](): Promise<void> {
				return branchWorktree.dispose();
			},
		};
		return Promise.resolve(branchWorktree);
	}

	// ── merge-to-head: create a temp branch, merge back on dispose ───────────
	// branchStrategy.type === "merge-to-head"
	const tempBranch = `pi-sw/merge-${Date.now().toString(36)}`;
	const sanitized = sanitizeBranch(tempBranch);
	const worktreesDir = join(cwd, ".pi-workflows", "worktrees");
	mkdirSync(worktreesDir, { recursive: true });
	const worktreePath = join(worktreesDir, sanitized);

	try {
		git(cwd, "worktree", "add", worktreePath, "-b", tempBranch);
	} catch (err) {
		try { rmdirSync(worktreesDir); } catch { /* not empty */ }
		try { rmdirSync(join(cwd, ".pi-workflows")); } catch { /* not empty */ }
		return Promise.reject(err instanceof Error ? err : new Error(String(err)));
	}

	const mergeWorktree: Worktree = {
		worktreePath,
		branch: tempBranch,
		dispose(): Promise<void> {
			// Remove the worktree first (so the branch is free to merge).
			try {
				git(cwd, "worktree", "remove", worktreePath, "--force");
			} catch {
				/* best-effort */
			}
			// Fast-forward merge to original HEAD branch.
			let mergeOk = false;
			try {
				git(cwd, "merge", "--ff-only", tempBranch);
				mergeOk = true;
			} catch (mergeErr) {
				// --ff-only failed (diverged, conflicts, no commits, etc.).
				// Surface via callback so the caller can emit a warning; leave the
				// temp branch in place so the user can recover the work.
				onMergeFailure?.(tempBranch, mergeErr);
			}
			// Clean up temp branch only on successful merge.
			if (mergeOk) {
				try {
					git(cwd, "branch", "-d", tempBranch);
				} catch {
					/* ignore */
				}
			}
			return Promise.resolve();
		},
		[Symbol.asyncDispose](): Promise<void> {
			return mergeWorktree.dispose();
		},
	};
	return Promise.resolve(mergeWorktree);
}

// Re-export type alias used by WorkflowContext.
export type WorktreeBranchStrategy = BranchStrategy;
