import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupWorktree, createWorktree, pruneWorktrees } from "../src/worktree.js";

/**
 * Helper: create a temporary git repo with an initial commit.
 * Uses a clean git environment so global config (gpgsign, hooksPath, etc.)
 * cannot interfere — the caller's beforeEach has already cleared the env vars.
 */
function initGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-test-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "# Test repo");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("worktree", () => {
  let repoDir: string;
  // Track all worktree paths created during a test so afterEach can clean up
  // even if an expect() throws before the inline cleanup runs.
  const createdWorktreePaths: string[] = [];

  // --- Saved env vars ---
  let savedGitDir: string | undefined;
  let savedGitWorkTree: string | undefined;
  let savedGitIndexFile: string | undefined;
  let savedGitConfigGlobal: string | undefined;
  let savedGitConfigNoSystem: string | undefined;

  beforeEach(() => {
    // Clear git env vars injected by husky pre-commit hooks, and suppress
    // global/system git config so gpgsign, hooksPath, init.defaultBranch etc.
    // cannot affect subprocess behaviour.
    savedGitDir = process.env['GIT_DIR'];
    savedGitWorkTree = process.env['GIT_WORK_TREE'];
    savedGitIndexFile = process.env['GIT_INDEX_FILE'];
    savedGitConfigGlobal = process.env['GIT_CONFIG_GLOBAL'];
    savedGitConfigNoSystem = process.env['GIT_CONFIG_NOSYSTEM'];
    delete process.env['GIT_DIR'];
    delete process.env['GIT_WORK_TREE'];
    delete process.env['GIT_INDEX_FILE'];
    process.env['GIT_CONFIG_GLOBAL'] = "/dev/null";
    process.env['GIT_CONFIG_NOSYSTEM'] = "1";

    repoDir = initGitRepo();
    createdWorktreePaths.length = 0;
  }, 30000);

  afterEach(() => {
    // Restore env vars
    if (savedGitDir !== undefined) process.env['GIT_DIR'] = savedGitDir;
    else delete process.env['GIT_DIR'];
    if (savedGitWorkTree !== undefined) process.env['GIT_WORK_TREE'] = savedGitWorkTree;
    else delete process.env['GIT_WORK_TREE'];
    if (savedGitIndexFile !== undefined) process.env['GIT_INDEX_FILE'] = savedGitIndexFile;
    else delete process.env['GIT_INDEX_FILE'];
    if (savedGitConfigGlobal !== undefined) process.env['GIT_CONFIG_GLOBAL'] = savedGitConfigGlobal;
    else delete process.env['GIT_CONFIG_GLOBAL'];
    if (savedGitConfigNoSystem !== undefined) process.env['GIT_CONFIG_NOSYSTEM'] = savedGitConfigNoSystem;
    else delete process.env['GIT_CONFIG_NOSYSTEM'];

    // Clean up any worktree dirs that didn't get cleaned inline (e.g. test threw)
    for (const p of createdWorktreePaths) {
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    }
    createdWorktreePaths.length = 0;

    // Clean up any lingering worktrees first, then remove repo
    try { pruneWorktrees(repoDir); } catch { /* ignore */ }
    rmSync(repoDir, { recursive: true, force: true });
  }, 30000);

  describe("createWorktree", () => {
    it("creates a worktree in tmpdir", () => {
      const wt = createWorktree(repoDir, "test-id-1");
      expect(wt).toBeDefined();
      if (wt) createdWorktreePaths.push(wt.path);
      expect(existsSync(wt!.path)).toBe(true);
      expect(wt!.branch).toBe("pi-agent-test-id-1");

      // Verify it's a valid worktree with the repo's files
      expect(existsSync(join(wt!.path, "README.md"))).toBe(true);

      // Inline cleanup (belt-and-suspenders; afterEach covers failures)
      try { execFileSync("git", ["worktree", "remove", "--force", wt!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    }, 30000);

    it("returns undefined for non-git directory", () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        const wt = createWorktree(nonGit, "test-id-2");
        expect(wt).toBeUndefined();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });

    it("returns undefined for git repo with no commits", () => {
      const emptyRepo = mkdtempSync(join(tmpdir(), "pi-wt-empty-"));
      try {
        execFileSync("git", ["init"], { cwd: emptyRepo, stdio: "pipe" });
        const wt = createWorktree(emptyRepo, "no-commits");
        expect(wt).toBeUndefined();
      } finally {
        rmSync(emptyRepo, { recursive: true, force: true });
      }
    });

    it("uses unique paths for multiple worktrees", () => {
      const wt1 = createWorktree(repoDir, "multi-1");
      const wt2 = createWorktree(repoDir, "multi-2");
      if (wt1) createdWorktreePaths.push(wt1.path);
      if (wt2) createdWorktreePaths.push(wt2.path);
      expect(wt1).toBeDefined();
      expect(wt2).toBeDefined();
      expect(wt1!.path).not.toBe(wt2!.path);

      // Inline cleanup (belt-and-suspenders)
      try { execFileSync("git", ["worktree", "remove", "--force", wt1!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
      try { execFileSync("git", ["worktree", "remove", "--force", wt2!.path], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    }, 30000);
  });

  describe("cleanupWorktree", () => {
    it("removes worktree when no changes made", () => {
      const wt = createWorktree(repoDir, "clean-1")!;
      expect(wt).toBeDefined();
      if (wt) createdWorktreePaths.push(wt.path);

      const result = cleanupWorktree(repoDir, wt, "test cleanup");
      expect(result.hasChanges).toBe(false);
      expect(result.branch).toBeUndefined();
    }, 30000);

    it("commits changes and creates branch when changes exist", () => {
      const wt = createWorktree(repoDir, "dirty-1")!;
      expect(wt).toBeDefined();
      if (wt) createdWorktreePaths.push(wt.path);

      // Make a change in the worktree
      writeFileSync(join(wt.path, "new-file.txt"), "agent wrote this");

      const result = cleanupWorktree(repoDir, wt, "added new file");
      expect(result.hasChanges).toBe(true);
      expect(result.branch).toBeDefined();
      expect(result.branch).toContain("pi-agent-dirty-1");

      // Verify the branch exists in the main repo
      const branches = execFileSync("git", ["branch", "--list", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(branches).toContain(result.branch!);

      // Verify the commit message
      const log = execFileSync("git", ["log", "--oneline", "-1", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(log).toContain("pi-agent: added new file");

      // Inline cleanup (belt-and-suspenders)
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    }, 30000);

    it("does not force-overwrite existing branch", () => {
      // Create first worktree, make changes, cleanup → creates branch
      const wt1 = createWorktree(repoDir, "conflict-1")!;
      if (wt1) createdWorktreePaths.push(wt1.path);
      writeFileSync(join(wt1.path, "file1.txt"), "first run");
      const result1 = cleanupWorktree(repoDir, wt1, "first");
      expect(result1.branch).toBe("pi-agent-conflict-1");

      // Create second worktree with same agent ID, make changes
      const wt2 = createWorktree(repoDir, "conflict-1")!;
      if (wt2) createdWorktreePaths.push(wt2.path);
      writeFileSync(join(wt2.path, "file2.txt"), "second run");
      const result2 = cleanupWorktree(repoDir, wt2, "second");

      // Should use a different branch name (timestamp suffix)
      expect(result2.hasChanges).toBe(true);
      expect(result2.branch).toBeDefined();
      expect(result2.branch).not.toBe("pi-agent-conflict-1");
      expect(result2.branch).toContain("pi-agent-conflict-1-");

      // Both branches should exist
      const branches = execFileSync("git", ["branch", "--list", "pi-agent-conflict-1*"], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      expect(branches).toContain("pi-agent-conflict-1");
      expect(branches).toContain(result2.branch!);

      // Inline cleanup (belt-and-suspenders)
      try { execFileSync("git", ["branch", "-D", result1.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
      try { execFileSync("git", ["branch", "-D", result2.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    }, 30000);

    it("handles already-deleted worktree gracefully", () => {
      const wt = createWorktree(repoDir, "gone-1")!;
      if (wt) createdWorktreePaths.push(wt.path);
      // Manually delete the worktree directory
      rmSync(wt.path, { recursive: true, force: true });

      const result = cleanupWorktree(repoDir, wt, "already gone");
      expect(result.hasChanges).toBe(false);
    }, 30000);

    it("truncates commit message at 200 chars", () => {
      const wt = createWorktree(repoDir, "long-msg")!;
      if (wt) createdWorktreePaths.push(wt.path);
      writeFileSync(join(wt.path, "change.txt"), "something");
      const longDesc = "x".repeat(300);
      const result = cleanupWorktree(repoDir, wt, longDesc);
      expect(result.hasChanges).toBe(true);

      const log = execFileSync("git", ["log", "--oneline", "-1", result.branch!], {
        cwd: repoDir, stdio: "pipe",
      }).toString().trim();
      // "pi-agent: " prefix (10 chars) + 200 chars of x = 210 total max
      expect(log.length).toBeLessThanOrEqual(220); // some slack for hash prefix

      // Inline cleanup (belt-and-suspenders)
      try { execFileSync("git", ["branch", "-D", result.branch!], { cwd: repoDir, stdio: "pipe" }); } catch { /* ignore */ }
    }, 30000);
  });

  describe("createWorktree — subdir (workPath)", () => {
    it("sets workPath to a subdirectory of the worktree when cwd is inside a monorepo package", () => {
      // Create a subdirectory inside the repo and use that as cwd
      const pkgDir = join(repoDir, "packages", "my-pkg");
      mkdirSync(pkgDir, { recursive: true });

      const wt = createWorktree(pkgDir, "subdir-1");
      if (wt) createdWorktreePaths.push(wt.path);

      expect(wt).toBeDefined();
      // workPath must point inside the worktree at the same relative path
      expect(wt!.workPath).toBe(join(wt!.path, "packages", "my-pkg"));
      // workPath must differ from path (it's a subdir, not the root)
      expect(wt!.workPath).not.toBe(wt!.path);

      // Inline cleanup
      try {
        execFileSync("git", ["worktree", "remove", "--force", wt!.path], { cwd: repoDir, stdio: "pipe" });
      } catch { /* ignore */ }
    }, 30000);
  });

  describe("pruneWorktrees", () => {
    it("does not throw on a clean repo", () => {
      expect(() => pruneWorktrees(repoDir)).not.toThrow();
    });

    it("does not throw on non-git directory", () => {
      const nonGit = mkdtempSync(join(tmpdir(), "pi-wt-nongit-"));
      try {
        expect(() => pruneWorktrees(nonGit)).not.toThrow();
      } finally {
        rmSync(nonGit, { recursive: true, force: true });
      }
    });
  });

  describe("cleanupWorktree — error recovery", () => {
    it("returns hasChanges:false when git commands fail inside the worktree", () => {
      // Create a real worktree so existsSync(worktree.path) returns true,
      // then corrupt the .git pointer so every git command inside the
      // worktree throws. This exercises the outer catch block (lines 162-163).
      const wt = createWorktree(repoDir, "error-recovery-1")!;
      if (wt) createdWorktreePaths.push(wt.path);
      expect(wt).toBeDefined();

      // Each worktree contains a `.git` text file that points back to the
      // main repo. Overwriting it with a broken path makes all git subcommands
      // run inside the worktree fail (git status, etc.).
      const gitFile = join(wt.path, ".git");
      writeFileSync(gitFile, "gitdir: /nonexistent/path/.git", "utf8");

      // cleanupWorktree must NOT throw and must report no changes.
      const result = cleanupWorktree(repoDir, wt, "error recovery test");
      expect(result.hasChanges).toBe(false);
    }, 30000);
  });
});
