import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectEnv } from "../src/env.js";

/**
 * Mock of pi.exec() that uses execFileSync (argv, no shell) — matching the
 * real pi.exec behaviour. The previous execSync shell-interpolation variant
 * diverged from production and broke on args containing spaces or metacharacters.
 */
function mockPi(): ExtensionAPI {
  return {
    exec: (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
      try {
        const stdout = execFileSync(command, args, {
          cwd: options?.cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: options?.timeout,
        });
        return Promise.resolve({ stdout, stderr: "", code: 0, killed: false });
      } catch (err: unknown) {
        const e = err as { stderr?: string; status?: number };
        return Promise.resolve({ stdout: "", stderr: e.stderr ?? "", code: e.status ?? 1, killed: false });
      }
    },
  } as unknown as ExtensionAPI;
}

describe("detectEnv", () => {
  let savedGitDir: string | undefined;
  let savedGitWorkTree: string | undefined;
  let savedGitIndexFile: string | undefined;
  let savedGitConfigGlobal: string | undefined;
  let savedGitConfigNoSystem: string | undefined;

  beforeEach(() => {
    // Clear git env vars injected by husky and suppress global/system config
    // so gpgsign, hooksPath, init.defaultBranch etc. cannot affect subprocesses.
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
  });

  afterEach(() => {
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
  });

  it("detects git repo in current project", async () => {
    const env = await detectEnv(mockPi(), import.meta.dirname);
    expect(env.isGitRepo).toBe(true);
    expect(env.platform).toBe(process.platform);
  });

  it("returns branch name when on a branch", async () => {
    // Create a temp repo on a known branch to test branch detection
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-env-branch-"));
    try {
      const g = (...args: string[]) =>
        execFileSync("git", ["-C", tmpDir, ...args], { stdio: "pipe" });
      g("init");
      g("config", "--local", "user.email", "test@test.com");
      g("config", "--local", "user.name", "Test User");
      g("checkout", "-b", "test-branch");
      g("commit", "--allow-empty", "-m", "init");
      const env = await detectEnv(mockPi(), tmpDir);
      expect(env.isGitRepo).toBe(true);
      expect(env.branch).toBe("test-branch");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30000);

  it("detects non-git directory", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-env-test-"));
    try {
      const env = await detectEnv(mockPi(), tmpDir);
      expect(env.isGitRepo).toBe(false);
      expect(env.branch).toBe("");
      expect(env.platform).toBe(process.platform);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
