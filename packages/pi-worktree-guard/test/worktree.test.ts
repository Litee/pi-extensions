import { describe, expect, it, vi } from "vitest";

import { detectMainWorktree, isInMainRepo } from "../src/worktree.js";

// ---------------------------------------------------------------------------
// detectMainWorktree
// ---------------------------------------------------------------------------

const SAMPLE_PORCELAIN = [
	"worktree /repo/main",
	"HEAD abc123",
	"branch refs/heads/main",
	"",
	"worktree /repo/main/.worktrees/my-branch",
	"HEAD def456",
	"branch refs/heads/my-branch",
	"",
].join("\n");

describe("detectMainWorktree", () => {
	it("returns the first worktree path from valid porcelain output", async () => {
		const exec = vi.fn().mockResolvedValue({ code: 0, stdout: SAMPLE_PORCELAIN });
		const result = await detectMainWorktree(exec, "/repo/main");
		expect(result).toBe("/repo/main");
	});

	it("returns undefined when exec returns a non-zero exit code", async () => {
		const exec = vi.fn().mockResolvedValue({ code: 128, stdout: "" });
		const result = await detectMainWorktree(exec, "/some/dir");
		expect(result).toBeUndefined();
	});

	it("returns undefined when exec throws", async () => {
		const exec = vi.fn().mockRejectedValue(new Error("git not found"));
		const result = await detectMainWorktree(exec, "/some/dir");
		expect(result).toBeUndefined();
	});

	it("returns undefined when stdout contains no worktree line", async () => {
		const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "HEAD abc123\nbranch refs/heads/main\n" });
		const result = await detectMainWorktree(exec, "/some/dir");
		expect(result).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// isInMainRepo
// ---------------------------------------------------------------------------

describe("isInMainRepo", () => {
	const mainRoot = "/repo/main";
	const cwd = "/repo/main";

	it("returns true for a file directly in the main repo root", () => {
		expect(isInMainRepo("/repo/main/README.md", cwd, mainRoot)).toBe(true);
	});

	it("returns true for a file in a subdirectory of the main repo", () => {
		expect(isInMainRepo("/repo/main/src/index.ts", cwd, mainRoot)).toBe(true);
	});

	it("returns false for a file inside .worktrees/", () => {
		expect(
			isInMainRepo("/repo/main/.worktrees/my-branch/src/foo.ts", cwd, mainRoot),
		).toBe(false);
	});

	it("returns false for a file outside the repo entirely", () => {
		expect(isInMainRepo("/home/user/notes.txt", cwd, mainRoot)).toBe(false);
	});

	it("resolves a relative path against cwd and returns true when in main repo", () => {
		expect(isInMainRepo("src/index.ts", "/repo/main", mainRoot)).toBe(true);
	});

	it("resolves a relative path against cwd and returns false when in worktree", () => {
		expect(
			isInMainRepo(
				"packages/foo/src/bar.ts",
				"/repo/main/.worktrees/my-branch",
				mainRoot,
			),
		).toBe(false);
	});

	it("returns true when the path equals the mainRoot directory itself", () => {
		expect(isInMainRepo("/repo/main", cwd, mainRoot)).toBe(true);
	});

	it("returns false when path shares a prefix but is not under mainRoot", () => {
		// /repo/main-other is not under /repo/main
		expect(isInMainRepo("/repo/main-other/file.ts", cwd, mainRoot)).toBe(false);
	});
});
