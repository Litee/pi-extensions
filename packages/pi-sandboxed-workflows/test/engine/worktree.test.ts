/**
 * Tests for createWorktree — slim git-worktree wrapper.
 *
 * Uses a real temp git repo so git commands run against actual state.
 * Verifies:
 *   - type:"branch" creates the worktree and dispose removes it.
 *   - type:"head" returns a no-op handle pointing at cwd.
 *   - type:"merge-to-head" creates a temp branch; dispose merges and cleans up.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "path";
import { existsSync } from "node:fs";
import { createWorktree } from "../../src/engine/worktree.js";

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
