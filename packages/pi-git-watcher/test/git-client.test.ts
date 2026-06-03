import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecFileException } from "node:child_process";

vi.mock("node:child_process");
import { execFile as execFileCb } from "node:child_process";
import { createGitClient, GitClientError } from "../src/git-client.js";

type ExecCb = (err: ExecFileException | null, stdout: string, stderr: string) => void;

const mockExecFile = vi.mocked(execFileCb);

function mockOk(stdout: string, stderr = ""): void {
  mockExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as ExecCb)(null, stdout, stderr);
      return undefined as never;
    },
  );
}

function mockFail(stderr: string, code: number | string = 1): void {
  const err = Object.assign(new Error("Command failed") as ExecFileException, { code, stderr });
  mockExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as ExecCb)(err, "", stderr);
      return undefined as never;
    },
  );
}

function mockEnoent(): void {
  const err = Object.assign(new Error("spawn git ENOENT") as ExecFileException, {
    code: "ENOENT",
    syscall: "spawn git",
  });
  mockExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as ExecCb)(err, "", "");
      return undefined as never;
    },
  );
}

beforeEach(() => vi.clearAllMocks());

describe("isGitRepo", () => {
  it("returns true when git says 'true'", async () => {
    mockOk("true\n");
    const client = createGitClient();
    expect(await client.isGitRepo("/some/path")).toBe(true);
  });

  it("returns false on non-zero exit (not a git repo)", async () => {
    mockFail("fatal: not a git repository");
    const client = createGitClient();
    expect(await client.isGitRepo("/some/path")).toBe(false);
  });

  it("returns false on ENOENT (git not installed)", async () => {
    mockEnoent();
    const client = createGitClient();
    expect(await client.isGitRepo("/some/path")).toBe(false);
  });

  it("returns false when stdout is not exactly 'true'", async () => {
    mockOk("false\n");
    const client = createGitClient();
    expect(await client.isGitRepo("/some/path")).toBe(false);
  });
});

describe("resolveBranch", () => {
  it("returns the SHA on success", async () => {
    const sha = "abc1234abc1234abc1234abc1234abc1234abc1234";
    mockOk(sha + "\n");
    const client = createGitClient();
    expect(await client.resolveBranch("/repo", "main")).toBe(sha);
  });

  it("returns undefined on non-zero exit (branch doesn't exist)", async () => {
    mockFail("");
    const client = createGitClient();
    expect(await client.resolveBranch("/repo", "nonexistent")).toBe(undefined);
  });

  it("returns undefined on empty stdout", async () => {
    mockOk("");
    const client = createGitClient();
    expect(await client.resolveBranch("/repo", "main")).toBe(undefined);
  });
});

describe("listLocalBranches", () => {
  it("parses and sorts branch names", async () => {
    mockOk("main\nfeature/foo\ndevelop\n");
    const client = createGitClient();
    const branches = await client.listLocalBranches("/repo");
    expect(branches).toEqual(["develop", "feature/foo", "main"]);
  });

  it("returns empty array when no branches", async () => {
    mockOk("");
    const client = createGitClient();
    const branches = await client.listLocalBranches("/repo");
    expect(branches).toEqual([]);
  });

  it("filters out empty lines", async () => {
    mockOk("main\n\n  \n");
    const client = createGitClient();
    const branches = await client.listLocalBranches("/repo");
    expect(branches).toEqual(["main"]);
  });

  it("throws GitClientError with kind 'not_a_repo' on git error", async () => {
    mockFail("fatal: not a git repository");
    const client = createGitClient();
    await expect(client.listLocalBranches("/repo")).rejects.toThrow(GitClientError);
    await expect(client.listLocalBranches("/repo")).rejects.toMatchObject({
      kind: "not_a_repo",
    });
  });

  it("throws GitClientError with kind 'git_not_installed' on ENOENT", async () => {
    mockEnoent();
    const client = createGitClient();
    await expect(client.listLocalBranches("/repo")).rejects.toMatchObject({
      kind: "git_not_installed",
    });
  });

  it("throws GitClientError with kind 'index_locked' when index.lock error", async () => {
    mockFail("fatal: Unable to create '/repo/.git/index.lock'");
    const client = createGitClient();
    await expect(client.listLocalBranches("/repo")).rejects.toMatchObject({
      kind: "index_locked",
    });
  });

  it("throws GitClientError with kind 'permission_denied' on permission error", async () => {
    mockFail("error: permission denied");
    const client = createGitClient();
    await expect(client.listLocalBranches("/repo")).rejects.toMatchObject({
      kind: "permission_denied",
    });
  });

  it("throws GitClientError with kind 'generic' for other errors", async () => {
    mockFail("unknown git error occurred");
    const client = createGitClient();
    await expect(client.listLocalBranches("/repo")).rejects.toMatchObject({
      kind: "generic",
    });
  });
});

describe("listLocalTags", () => {
  it("parses and sorts tag names", async () => {
    mockOk("v2.0.0\nv1.0.0\nv1.5.0\n");
    const client = createGitClient();
    const tags = await client.listLocalTags("/repo");
    expect(tags).toEqual(["v1.0.0", "v1.5.0", "v2.0.0"]);
  });

  it("returns empty array when no tags", async () => {
    mockOk("");
    const client = createGitClient();
    const tags = await client.listLocalTags("/repo");
    expect(tags).toEqual([]);
  });
});

describe("getCommitSubject", () => {
  it("returns trimmed subject string", async () => {
    mockOk("feat: add new feature\n");
    const client = createGitClient();
    expect(await client.getCommitSubject("/repo", "abc1234")).toBe(
      "feat: add new feature",
    );
  });

  it("truncates to 80 chars", async () => {
    const longSubject = "a".repeat(100);
    mockOk(longSubject + "\n");
    const client = createGitClient();
    const result = await client.getCommitSubject("/repo", "abc1234");
    expect(result).toHaveLength(80);
  });

  it("returns undefined on error (swallows)", async () => {
    mockFail("fatal: bad revision");
    const client = createGitClient();
    expect(await client.getCommitSubject("/repo", "bad")).toBe(undefined);
  });

  it("returns undefined on empty stdout", async () => {
    mockOk("");
    const client = createGitClient();
    expect(await client.getCommitSubject("/repo", "abc1234")).toBe(undefined);
  });
});

describe("GitClientError", () => {
  it("has name 'GitClientError'", () => {
    const err = new GitClientError("generic", "test");
    expect(err.name).toBe("GitClientError");
    expect(err.kind).toBe("generic");
    expect(err.message).toBe("test");
  });

  it("is instanceof Error", () => {
    expect(new GitClientError("not_a_repo", "x")).toBeInstanceOf(Error);
  });
});
