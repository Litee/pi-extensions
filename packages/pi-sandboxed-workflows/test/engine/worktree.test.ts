/**
 * Tests for createWorktree — slim git-worktree wrapper.
 *
 * Uses a real temp git repo so git commands run against actual state.
 * Verifies:
 *   - type:"branch" creates the worktree and dispose removes it.
 *   - type:"head" returns a no-op handle pointing at cwd.
 *   - type:"merge-to-head" creates a temp branch; dispose merges and cleans up.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "path";
import { existsSync } from "node:fs";
import { createWorktree } from "../../src/engine/worktree.js";

// git worktree operations (git init, worktree add, worktree remove, merge)
// can take several seconds on loaded CI / developer machines. The default
// 5 000 ms vitest timeout is too tight for this file; raise it file-wide.
vi.setConfig({ testTimeout: 30_000 });

// ── Test repo setup ───────────────────────────────────────────────────────────

let repoDir: string;

beforeAll(() => {
	repoDir = mkdtempSync(join(tmpdir(), "pi-sw-worktree-test-"));
	const g = (...args: string[]) =>
		execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });

	g("init");
	g("config", "user.email", "test@example.com");
	g("config", "user.name", "Test");
	// Create initial commit so we have a HEAD.
	writeFileSync(join(repoDir, "README.md"), "# Test repo\n");
	g("add", "README.md");
	g("commit", "-m", "initial commit");
});

afterAll(() => {
	try {
		rmSync(repoDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

// ── type:"branch" ─────────────────────────────────────────────────────────────

describe("createWorktree — type:'branch'", () => {
	it("creates a worktree at .pi-workflows/worktrees/<branch>", async () => {
		const wt = await createWorktree({
			cwd: repoDir,
			branchStrategy: { type: "branch", branch: "test/feature-1" },
		});

		expect(wt.branch).toBe("test/feature-1");
		expect(existsSync(wt.worktreePath)).toBe(true);
		// Path is inside .pi-workflows/worktrees/
		expect(wt.worktreePath).toContain(".pi-workflows");
		expect(wt.worktreePath).toContain("worktrees");

		await wt.dispose();
	});

	it("dispose removes the worktree directory", async () => {
		const wt = await createWorktree({
			cwd: repoDir,
			branchStrategy: { type: "branch", branch: "test/feature-2" },
		});

		const { worktreePath } = wt;
		expect(existsSync(worktreePath)).toBe(true);

		await wt.dispose();
		expect(existsSync(worktreePath)).toBe(false);
	});

	it("supports await using via [Symbol.asyncDispose]", async () => {
		let worktreePath: string;
		{
			await using wt = await createWorktree({
				cwd: repoDir,
				branchStrategy: { type: "branch", branch: "test/feature-3" },
			});
			worktreePath = wt.worktreePath;
			expect(existsSync(worktreePath)).toBe(true);
		}
		// After the block, dispose has been called.
		expect(existsSync(worktreePath!)).toBe(false);
	});
});

// ── type:"head" ───────────────────────────────────────────────────────────────

describe("createWorktree — type:'head'", () => {
	it("returns worktreePath === cwd", async () => {
		const wt = await createWorktree({
			cwd: repoDir,
			branchStrategy: { type: "head" },
		});
		expect(wt.worktreePath).toBe(repoDir);
	});

	it("dispose is a no-op (cwd still exists after dispose)", async () => {
		const wt = await createWorktree({
			cwd: repoDir,
			branchStrategy: { type: "head" },
		});
		await wt.dispose();
		expect(existsSync(repoDir)).toBe(true);
	});
});

// ── type:"merge-to-head" ──────────────────────────────────────────────────────

describe("createWorktree — type:'merge-to-head'", () => {
	it("creates a worktree on a pi-sw/merge-* temp branch", async () => {
		const wt = await createWorktree({
			cwd: repoDir,
			branchStrategy: { type: "merge-to-head" },
		});

		expect(wt.branch).toMatch(/^pi-sw\/merge-/);
		expect(existsSync(wt.worktreePath)).toBe(true);

		await wt.dispose();
	});

	it("dispose removes the worktree", async () => {
		const wt = await createWorktree({
			cwd: repoDir,
			branchStrategy: { type: "merge-to-head" },
		});
		const { worktreePath } = wt;
		await wt.dispose();
		expect(existsSync(worktreePath)).toBe(false);
	});
});

// ── Abort ─────────────────────────────────────────────────────────────────────

describe("createWorktree — abort signal", () => {
	it("throws when signal is already aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		await expect(
			createWorktree({
				cwd: repoDir,
				branchStrategy: { type: "branch", branch: "never" },
				signal: ac.signal,
			}),
		).rejects.toThrow();
	});
});

// ── Regression: orphaned directory on git failure (Bug 10) ─────────────────

describe("createWorktree — no orphan on failure (regression: Bug 10)", () => {
	// Strategy: pre-create .pi-workflows/worktrees as a read-only directory.
	// mkdirSync({ recursive: true }) succeeds (dir already exists).
	// git worktree add fails because it can't create inside a 500 dir.
	// Cleanup code must then remove .pi-workflows entirely.
	function setupReadonlyWorktreesDir(cwd: string): string {
		const piDir = join(cwd, ".pi-workflows");
		const wDir = join(piDir, "worktrees");
		mkdirSync(wDir, { recursive: true });
		chmodSync(wDir, 0o500); // read + exec, no write → git can't create inside
		return piDir;
	}

	it("leaves no .pi-workflows/worktrees directory behind when git worktree add fails", async () => {
		const piDir = setupReadonlyWorktreesDir(repoDir);
		const wDir = join(repoDir, ".pi-workflows", "worktrees");
		try {
			await expect(
				createWorktree({
					cwd: repoDir,
					branchStrategy: { type: "branch", branch: "test/cleanup" },
				}),
			).rejects.toThrow();
			expect(existsSync(piDir)).toBe(false);
		} finally {
			// Restore write permission so rmSync can clean up if test failed.
			try { chmodSync(wDir, 0o755); } catch { /* already gone */ }
			rmSync(piDir, { recursive: true, force: true });
		}
	});

	it("leaves no .pi-workflows directory behind when merge-to-head git worktree add fails", async () => {
		const piDir = setupReadonlyWorktreesDir(repoDir);
		const wDir = join(repoDir, ".pi-workflows", "worktrees");
		try {
			await expect(
				createWorktree({
					cwd: repoDir,
					branchStrategy: { type: "merge-to-head" },
				}),
			).rejects.toThrow();
			expect(existsSync(piDir)).toBe(false);
		} finally {
			try { chmodSync(wDir, 0o755); } catch { /* already gone */ }
			rmSync(piDir, { recursive: true, force: true });
		}
	});
});
// ── Bug 8: merge failure emits warning, keeps temp branch ─────────────────────

describe("createWorktree — merge-to-head failure (regression: Bug #8)", () => {
	it("calls onMergeFailure and keeps temp branch when --ff-only fails", async () => {
		// Use a completely isolated git repo so no git operations here
		// can contaminate the shared repoDir or the actual worktree.
		const isolatedRepo = mkdtempSync(join(tmpdir(), "pi-sw-merge-test-"));
		try {
			// Bootstrap: init + initial commit so the repo has a HEAD.
			execFileSync("git", ["init", isolatedRepo], { stdio: "ignore" });
			execFileSync("git", ["-C", isolatedRepo, "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" });

			const mergeFailures: string[] = [];
			const wt = await createWorktree({
				cwd: isolatedRepo,
				branchStrategy: { type: "merge-to-head" },
				onMergeFailure: (branch) => { mergeFailures.push(branch); },
			});
			const tempBranch = wt.branch;

			// Add a commit in the worktree so tempBranch advances.
			execFileSync("git", ["-C", wt.worktreePath, "commit", "--allow-empty", "-m", "wt commit"], { stdio: "ignore" });
			// Diverge main by creating a new branch and committing on it.
			// Use a detached branch so we don’t need ‘checkout -’ to undo.
			const divergeBranch = `test/diverge-${Date.now().toString(36)}`;
			execFileSync("git", ["-C", isolatedRepo, "checkout", "-b", divergeBranch], { stdio: "ignore" });
			execFileSync("git", ["-C", isolatedRepo, "commit", "--allow-empty", "-m", "main diverge"], { stdio: "ignore" });

			await wt.dispose();

			// onMergeFailure must have been called with the temp branch name.
			expect(mergeFailures).toContain(tempBranch);
			// Temp branch must still exist so the user can recover.
			const branches = execFileSync("git", ["-C", isolatedRepo, "branch", "--list", tempBranch], { encoding: "utf8" });
			expect(branches.trim()).toContain(tempBranch);
		} finally {
			// Entire isolated repo is disposable — no shared state to restore.
			rmSync(isolatedRepo, { recursive: true, force: true });
		}
	});
});
