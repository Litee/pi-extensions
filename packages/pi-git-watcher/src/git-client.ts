/**
 * GitClient — injectable git client for pi-git-watcher.
 *
 * Uses `node:child_process.execFile` (no shell) with a 5 000 ms default
 * timeout. All git commands operate with `-C <repoPath>` so no cwd changes
 * are needed.
 */

import { execFile as execFileCb } from "node:child_process";

// ---------------------------------------------------------------------------
// Private helper — avoids capturing the real execFileCb at module load time,
// which would prevent vi.mock('node:child_process') from intercepting calls.
// ---------------------------------------------------------------------------

function runGit(
  args: string[],
  opts: { timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCb("git", args, { ...opts, encoding: "utf-8" }, (err, stdout, stderr) => {
      if (err) {
        const typedErr: Error & { stderr?: string } = err;
        typedErr.stderr = String(stderr ?? "");
        reject(typedErr);
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr ?? "") });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface GitClient {
  isGitRepo(repoPath: string): Promise<boolean>;
  resolveBranch(repoPath: string, branch: string): Promise<string | undefined>;
  listLocalBranches(repoPath: string): Promise<string[]>;
  listLocalTags(repoPath: string): Promise<string[]>;
  getCommitSubject(repoPath: string, sha: string): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class GitClientError extends Error {
  constructor(
    public readonly kind:
      | "not_a_repo"
      | "git_not_installed"
      | "permission_denied"
      | "index_locked"
      | "generic",
    message: string,
  ) {
    super(message);
    this.name = "GitClientError";
  }
}

// ---------------------------------------------------------------------------
// Error classification helper
// ---------------------------------------------------------------------------

function classifyGitError(err: unknown): GitClientError {
  // spawn ENOENT means the git binary was not found
  const spawnErr = err as NodeJS.ErrnoException;
  if (spawnErr.code === "ENOENT" && (spawnErr as { syscall?: string }).syscall === "spawn git") {
    return new GitClientError("git_not_installed", "git CLI not found in PATH");
  }

  // execFile errors carry stderr on the error object
  const stderr: string =
    (err as { stderr?: string }).stderr?.toLowerCase() ?? "";
  const message: string = (err as Error).message ?? "";
  const combined = stderr + " " + message.toLowerCase();

  if (combined.includes("not a git repository")) {
    return new GitClientError("not_a_repo", "not a git repository");
  }
  if (combined.includes("index.lock")) {
    return new GitClientError(
      "index_locked",
      "git index locked — another process is writing",
    );
  }
  if (
    combined.includes("permission denied") ||
    spawnErr.code === "EACCES"
  ) {
    return new GitClientError(
      "permission_denied",
      "permission denied reading the repository",
    );
  }
  return new GitClientError("generic", `git error: ${message}`);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGitClient(opts?: { timeoutMs?: number }): GitClient {
  const timeoutMs = opts?.timeoutMs ?? 5_000;

  return {
    async isGitRepo(repoPath: string): Promise<boolean> {
      try {
        const result = await runGit(
          ["-C", repoPath, "rev-parse", "--is-inside-work-tree"],
          { timeout: timeoutMs },
        );
        return result.stdout.trim() === "true";
      } catch {
        return false;
      }
    },

    async resolveBranch(
      repoPath: string,
      branch: string,
    ): Promise<string | undefined> {
      try {
        const result = await runGit(
          [
            "-C",
            repoPath,
            "rev-parse",
            "--verify",
            "--quiet",
            `refs/heads/${branch}^{commit}`,
          ],
          { timeout: timeoutMs },
        );
        const sha = result.stdout.trim();
        return sha || undefined;
      } catch {
        return undefined;
      }
    },

    async listLocalBranches(repoPath: string): Promise<string[]> {
      const result = await runGit(
        ["-C", repoPath, "for-each-ref", "--format=%(refname:short)", "refs/heads/"],
        { timeout: timeoutMs },
      ).catch((err) => {
        throw classifyGitError(err);
      });
      return result.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .sort();
    },

    async listLocalTags(repoPath: string): Promise<string[]> {
      const result = await runGit(
        ["-C", repoPath, "for-each-ref", "--format=%(refname:short)", "refs/tags/"],
        { timeout: timeoutMs },
      ).catch((err) => {
        throw classifyGitError(err);
      });
      return result.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
        .sort();
    },

    async getCommitSubject(
      repoPath: string,
      sha: string,
    ): Promise<string | undefined> {
      try {
        const result = await runGit(
          ["-C", repoPath, "log", "-1", "--pretty=%s", "--", sha],
          { timeout: timeoutMs },
        );
        const subject = result.stdout.trim();
        return subject ? subject.slice(0, 80) : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
