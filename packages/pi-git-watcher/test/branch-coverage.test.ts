/**
 * Targeted branch-coverage tests for pi-git-watcher.
 *
 * These tests exist solely to exercise branches that the main test files leave
 * uncovered.  They are intentionally minimal — each test hits exactly one
 * previously-dark branch.
 *
 * Uncovered branches addressed here:
 *
 * git-client.ts
 *   • opts?.timeoutMs  — "opts is defined" branch of optional-chain
 *   • ?? 5_000         — "left side is not nullish" branch of nullish-coalesce
 *   • listLocalTags catch callback (line 164)
 *   • classifyGitError: spawnErr.code === "EACCES" path (right-hand side of ||)
 *
 * poller.ts
 *   • arraysEqual inner loop: a[i] !== b[i] → return false  (line 264)
 *     (triggered by same-length branches arrays with a renamed element)
 *
 * watcher.ts
 *   • classifyError case "generic" (line 361)
 *   • browseOptions callbacks: visible, run, onRefresh, onPurge, getPollIntervalMs
 *     (lines 547-559)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecFileException } from "node:child_process";

// ---------------------------------------------------------------------------
// git-client.ts — uncovered branches
// ---------------------------------------------------------------------------

vi.mock("node:child_process");
import { execFile as execFileCb } from "node:child_process";
import { createGitClient, GitClientError } from "../src/git-client.js";

type ExecCb = (err: ExecFileException | null, stdout: string, stderr: string) => void;
const mockExecFile = vi.mocked(execFileCb);

function mockOk(stdout: string): void {
  mockExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as ExecCb)(null, stdout, "");
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

beforeEach(() => vi.clearAllMocks());

describe("createGitClient — explicit timeoutMs option", () => {
  // Covers: opts?.timeoutMs "opts is defined" branch + "left not nullish" ?? branch
  it("accepts { timeoutMs } and uses it (branch: opts defined, ?? left not nullish)", async () => {
    mockOk("true\n");
    const client = createGitClient({ timeoutMs: 1_000 });
    expect(await client.isGitRepo("/repo")).toBe(true);
  });

  it("accepts { timeoutMs: undefined } falling back to 5000", async () => {
    mockOk("true\n");
    const client = createGitClient({});
    expect(await client.isGitRepo("/repo")).toBe(true);
  });
});

describe("runGit — stderr callback arg is null/undefined (lines 24 & 27)", () => {
  // Line 24 arm 1: String(stderr ?? "") in the ERROR path — stderr arg is nullish
  it("covers stderr??'' right-side in error path when callback passes undefined stderr", async () => {
    const err = Object.assign(new Error("fail") as ExecFileException, { code: 1 });
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        // Pass undefined as stderr → triggers the `?? ""` right-side branch on line 24
        (cb as ExecCb)(err, "", undefined as unknown as string);
        return undefined as never;
      },
    );
    const client = createGitClient();
    // listLocalBranches will throw GitClientError (generic) — we just need it to run
    await expect(client.listLocalBranches("/repo")).rejects.toBeInstanceOf(GitClientError);
  });

  // Line 27 arm 1: String(stderr ?? "") in the SUCCESS path — stderr arg is nullish
  it("covers stderr??'' right-side in success path when callback passes undefined stderr", async () => {
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        // Pass undefined as stderr → triggers the `?? ""` right-side branch on line 27
        (cb as ExecCb)(null, "true\n", undefined as unknown as string);
        return undefined as never;
      },
    );
    const client = createGitClient();
    expect(await client.isGitRepo("/repo")).toBe(true);
  });
});

describe("classifyGitError — err.stderr missing (line 77 arm 1) and err.message missing (line 78 arm 1)", () => {
  // Line 77 arm 1: err.stderr?.toLowerCase() returns undefined → ?? "" uses right side
  // Achieved by making execFileCb THROW synchronously so the callback never fires,
  // meaning runGit never sets typedErr.stderr; the promise rejects with an error
  // that has no .stderr property.
  it("covers err.stderr?.toLowerCase()??'' right-side when error has no .stderr", async () => {
    mockExecFile.mockImplementation(() => {
      throw new Error("sync spawn failure"); // throws before calling callback
    });
    const client = createGitClient();
    // The thrown Error has .message but no .stderr → line 77 arm 1 is hit
    await expect(client.listLocalBranches("/repo")).rejects.toBeInstanceOf(GitClientError);
  });

  // Line 78 arm 1: (err as Error).message is undefined → ?? "" uses right side
  // Achieved by calling the callback with a non-Error object that has no .message.
  it("covers err.message??'' right-side when error object has no .message property", async () => {
    // Craft an error object without a .message property
    const errNoMsg = Object.create(null) as ExecFileException;
    (errNoMsg as Record<string, unknown>)["code"] = 1;
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as ExecCb)(errNoMsg, "", "some stderr");
        return undefined as never;
      },
    );
    const client = createGitClient();
    // err.message is undefined → undefined ?? "" → right side taken (arm 1 on line 78)
    await expect(client.listLocalBranches("/repo")).rejects.toBeInstanceOf(GitClientError);
  });
});

describe("listLocalTags — error path (line 164 catch)", () => {
  // Covers: the .catch() callback body inside listLocalTags
  it("throws GitClientError kind 'not_a_repo' when git fails in listLocalTags", async () => {
    mockFail("fatal: not a git repository");
    const client = createGitClient();
    await expect(client.listLocalTags("/repo")).rejects.toMatchObject({
      kind: "not_a_repo",
    });
  });

  it("throws GitClientError kind 'index_locked' for index.lock in listLocalTags", async () => {
    mockFail("fatal: Unable to create '/repo/.git/index.lock'");
    const client = createGitClient();
    await expect(client.listLocalTags("/repo")).rejects.toMatchObject({
      kind: "index_locked",
    });
  });
});

describe("classifyGitError — EACCES code path (right side of || branch)", () => {
  // Covers: spawnErr.code === "EACCES" evaluated (combined does NOT include "permission denied")
  it("throws GitClientError kind 'permission_denied' when error code is EACCES", async () => {
    // Deliberately use a message without "permission denied" so the || right-side fires
    const err = Object.assign(new Error("Access failure") as ExecFileException, {
      code: "EACCES",
      stderr: "access failure on repository",
    });
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as ExecCb)(err, "", "access failure on repository");
        return undefined as never;
      },
    );
    const client = createGitClient();
    await expect(client.listLocalBranches("/repo")).rejects.toMatchObject({
      kind: "permission_denied",
    });
  });
});

// ---------------------------------------------------------------------------
// poller.ts — arraysEqual inner loop return-false branch (line 264)
// ---------------------------------------------------------------------------

import type { GitBaseline, GitWatch } from "../src/types.js";
import type { GitClient } from "../src/git-client.js";
import { detectChanges } from "../src/poller.js";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function makeClient(overrides: Partial<GitClient> = {}): GitClient {
  return {
    isGitRepo: vi.fn().mockResolvedValue(true),
    resolveBranch: vi.fn().mockResolvedValue(SHA_A),
    listLocalBranches: vi.fn().mockResolvedValue(["main"]),
    listLocalTags: vi.fn().mockResolvedValue([]),
    getCommitSubject: vi.fn().mockResolvedValue("feat: initial"),
    ...overrides,
  };
}

function makeWatch(baseline?: GitBaseline): GitWatch {
  return {
    watchId: "test-cov",
    repoPath: "/repo/proj",
    branch: "main",
    targets: ["new_commit"],
    timeoutAt: undefined,
    addedAt: 1000,
    lastPolledAt: undefined,
    baseline: baseline ?? undefined,
    terminal: false,
    consecutiveErrors: 0,
  };
}

describe("arraysEqual — same-length arrays with differing elements (line 264 branch)", () => {
  // Covers: the `if (a[i] !== b[i]) return false` true-branch inside arraysEqual.
  // Requires: same headSha (so the first || in observedChange is false) AND
  //           same array length but at least one element differs.
  it("observedChange=true when two branches are renamed (same count, different names)", async () => {
    // prev: ["feature", "main"]  snap: ["develop", "main"]  — length 2 = length 2, but [0] differs
    const client = makeClient({
      resolveBranch: vi.fn().mockResolvedValue(SHA_A), // headSha unchanged
      listLocalBranches: vi.fn().mockResolvedValue(["develop", "main"]),
      listLocalTags: vi.fn().mockResolvedValue([]),
    });
    const baseline: GitBaseline = {
      headSha: SHA_A,
      branches: ["feature", "main"],
      tags: [],
    };
    const watch = makeWatch(baseline);
    const result = await detectChanges(client, watch, 5000);
    // No branch_created/deleted events (not in targets), but observedChange must be true
    expect(result.observedChange).toBe(true);
    expect(result.events).toHaveLength(0);
  });

  it("observedChange=true when tags have same count but different names", async () => {
    // Exercises the !arraysEqual(prev.tags, snap.tags) path when headSha + branches are same
    const client = makeClient({
      resolveBranch: vi.fn().mockResolvedValue(SHA_A),
      listLocalBranches: vi.fn().mockResolvedValue(["main"]),
      listLocalTags: vi.fn().mockResolvedValue(["v1.1.0"]),
    });
    const baseline: GitBaseline = {
      headSha: SHA_A,
      branches: ["main"],
      tags: ["v1.0.0"], // same length (1), different name
    };
    const watch = makeWatch(baseline);
    const result = await detectChanges(client, watch, 5000);
    expect(result.observedChange).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// watcher.ts — uncovered branches
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
  readFileSync: vi.fn().mockImplementation(() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GitWatcher } from "../src/watcher.js";

function makePi(): ExtensionAPI {
  return {
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    getActiveTools: vi.fn(() => [] as string[]),
    setActiveTools: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    on: vi.fn(),
    events: { on: vi.fn().mockReturnValue(() => {}), emit: vi.fn() },
  } as unknown as ExtensionAPI;
}

function makeGitClient(overrides: Partial<GitClient> = {}): GitClient {
  return {
    isGitRepo: vi.fn().mockResolvedValue(true),
    resolveBranch: vi.fn().mockResolvedValue("abc1234".repeat(6).slice(0, 40)),
    listLocalBranches: vi.fn().mockResolvedValue(["main"]),
    listLocalTags: vi.fn().mockResolvedValue([]),
    getCommitSubject: vi.fn().mockResolvedValue("feat: initial"),
    ...overrides,
  };
}

function makeWatcher(clientOverrides: Partial<GitClient> = {}): GitWatcher {
  const pi = makePi();
  const client = makeGitClient(clientOverrides);
  return new GitWatcher({ pi, client });
}

type ClassifyFn = (err: unknown) => { kind: string; userMessage: string; shouldBackoff: boolean };

describe("GitWatcher.classifyError — case 'generic' (line 361)", () => {
  // Covers: the switch case "generic" branch in classifyError
  it("classifies GitClientError(kind='generic') → kind='generic', userMessage='git poll failed'", () => {
    const watcher = makeWatcher();
    const classify = (
      watcher as unknown as { classifyError: ClassifyFn }
    ).classifyError.bind(watcher);

    const result = classify(new GitClientError("generic", "something failed"));
    expect(result.kind).toBe("generic");
    expect(result.userMessage).toBe("git poll failed");
    expect(result.shouldBackoff).toBe(false);
  });
});

describe("GitWatcher.browseOptions — callback bodies (lines 547-559)", () => {
  type RowAction = {
    id: string;
    visible: (w: GitWatch) => boolean;
    run: (watch: GitWatch) => Promise<void>;
  };
  type BrowseOpts = {
    searchable: boolean;
    rowActions: RowAction[];
    onRefresh: () => void | Promise<void>;
    onPurge: () => void | Promise<void>;
    getPollIntervalMs: (w: GitWatch) => number;
  };

  function getBrowseOpts(watcher: GitWatcher): BrowseOpts {
    return (
      watcher as unknown as { browseOptions(): BrowseOpts }
    ).browseOptions();
  }

  function sampleWatch(terminal = false): GitWatch {
    return {
      watchId: "w1",
      repoPath: "/repo/proj",
      branch: "main",
      targets: ["new_commit"],
      timeoutAt: undefined,
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal,
      consecutiveErrors: 0,
    };
  }

  it("visible(w) returns true for active watch (branch: !terminal = true)", () => {
    const watcher = makeWatcher();
    const opts = getBrowseOpts(watcher);
    const removeAction = opts.rowActions.find((a) => a.id === "remove")!;
    expect(removeAction.visible(sampleWatch(false))).toBe(true);
  });

  it("visible(w) returns false for terminal watch (branch: !terminal = false)", () => {
    const watcher = makeWatcher();
    const opts = getBrowseOpts(watcher);
    const removeAction = opts.rowActions.find((a) => a.id === "remove")!;
    expect(removeAction.visible(sampleWatch(true))).toBe(false);
  });

  it("run(watch) calls executeTool remove (browseOptions run callback body)", async () => {
    vi.useFakeTimers();
    const watcher = makeWatcher();
    // First add a watch so there is something to remove
    const addResult = await watcher["executeTool"]({
      action: "add",
      repoPath: "/repo",
      branch: "main",
      targets: ["new_commit"],
    });
    const watchId = addResult.details["watchId"] as string;
    expect(watcher["watches"].size).toBe(1);

    const opts = getBrowseOpts(watcher);
    const removeAction = opts.rowActions.find((a) => a.id === "remove")!;
    const watch = watcher["watches"].get(watchId)!;

    // This invokes the run callback body
    await removeAction.run(watch);
    expect(watcher["watches"].size).toBe(0);
    watcher.stopPolling();
    vi.useRealTimers();
  });

  it("getPollIntervalMs(w) returns scheduler intervalMs (callback body)", () => {
    const watcher = makeWatcher();
    const opts = getBrowseOpts(watcher);
    const watch = sampleWatch();
    // This invokes getPollIntervalMs callback — should return a number
    const ms = opts.getPollIntervalMs(watch);
    expect(typeof ms).toBe("number");
    expect(ms).toBeGreaterThan(0);
  });

  it("onRefresh() invokes pollOnce with no watches (callback body)", async () => {
    vi.useFakeTimers();
    const watcher = makeWatcher();
    const opts = getBrowseOpts(watcher);
    // No watches — pollOnce is a no-op; just verify it doesn't throw
    await expect(opts.onRefresh()).resolves.not.toThrow();
    vi.useRealTimers();
  });

  it("onPurge() invokes executePurge (callback body — removes terminal watches)", async () => {
    vi.useFakeTimers();
    const watcher = makeWatcher();

    // Manually plant a terminal watch
    watcher["watches"].set("dead1", {
      watchId: "dead1",
      repoPath: "/repo",
      branch: "main",
      targets: ["new_commit"],
      timeoutAt: undefined,
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: true,
      consecutiveErrors: 0,
    });
    expect(watcher["watches"].size).toBe(1);

    const opts = getBrowseOpts(watcher);
    await opts.onPurge();

    expect(watcher["watches"].size).toBe(0);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// watcher.ts — normaliseWatch extra branch: non-string in targets array
// (typeof t !== "string" short-circuit of &&)
// ---------------------------------------------------------------------------
describe("GitWatcher.normaliseWatch — non-string target element", () => {
  it("silently drops numeric targets (typeof t !== 'string' short-circuit)", () => {
    const watcher = makeWatcher();
    // A mixed array with a valid string and a number — number should be dropped
    const result = watcher.normaliseWatch({
      watchId: "a",
      repoPath: "/r",
      branch: "main",
      targets: [42, "new_commit"],
      addedAt: 1,
    });
    // The number 42 is silently dropped; "new_commit" survives
    expect(result?.targets).toEqual(["new_commit"]);
  });
});

// ---------------------------------------------------------------------------
// watcher.ts — remaining branch coverage (lines 183, 249, 267, 268, 292, 296, 323)
// ---------------------------------------------------------------------------

describe("GitWatcher.view.compressColumns — path already fits (line 183 arm 0)", () => {
  // Branch 23 arm 0: compressed === c.text → return c unchanged (no spread)
  it("returns the same column reference when path is short enough", () => {
    const watcher = makeWatcher();
    const shortCol = { name: "repo", text: "/short [main]" };
    const cols = [
      shortCol,
      { name: "head", text: "abc1234", width: 9 },
      { name: "targets", text: "new_commit", width: 14 },
      { name: "status", text: "WATCHING", width: 10 },
      { name: "timeout", text: "-", width: 10 },
    ];
    // With totalWidth=200, repoWidth = 200-43-8 = 149 — path fits easily
    const result = watcher.view.compressColumns!(cols, 200);
    const repoCol = result.find((c) => c.name === "repo")!;
    // Same reference means compressed === c.text branch (arm 0) was taken
    expect(repoCol).toBe(shortCol);
  });
});

describe("GitWatcher.detectChanges — timeout with no baseline in map (line 249 arm 1)", () => {
  // Branch 27 arm 1: baselines.get(...) returns undefined → use ?? fallback {headSha:undefined,...}
  it("returns empty fallback baseline when timeout fires with no seeded baseline", async () => {
    const watcher = makeWatcher();
    const watch: GitWatch = {
      watchId: "w-timeout",
      repoPath: "/repo",
      branch: "main",
      targets: ["new_commit"],
      timeoutAt: Date.now() - 10_000, // definitely in the past
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
    };
    watcher["watches"].set("w-timeout", watch);
    // Deliberately do NOT seed baselines map → arm 1 (fallback) fires
    const result = await watcher.detectChanges(watch);
    expect(result.events[0]!.eventType).toBe("timeout");
    expect(result.newBaseline).toEqual({ headSha: undefined, branches: [], tags: [] });
  });
});

describe("GitWatcher.normaliseWatch — missing/invalid field guards (lines 267, 268, 292, 296)", () => {
  const base = { watchId: "a", repoPath: "/r", branch: "main", targets: ["new_commit"], addedAt: 1 };

  // Branch 31 arm 0: typeof r['repoPath'] !== 'string' → return null
  it("returns null when repoPath is not a string", () => {
    const watcher = makeWatcher();
    expect(watcher.normaliseWatch({ ...base, repoPath: 123 })).toBeNull();
  });

  // Branch 32 arm 0: typeof r['branch'] !== 'string' → return null
  it("returns null when branch is not a string", () => {
    const watcher = makeWatcher();
    expect(watcher.normaliseWatch({ ...base, branch: true })).toBeNull();
  });

  // Branch 40 arm 1: timeoutAt is Infinity (not finite) → stored as undefined
  it("stores timeoutAt as undefined when value is Infinity", () => {
    const watcher = makeWatcher();
    const result = watcher.normaliseWatch({ ...base, timeoutAt: Infinity });
    expect(result?.timeoutAt).toBeUndefined();
  });

  // Branch 40 arm 1 (alt): timeoutAt is a non-number string → stored as undefined
  it("stores timeoutAt as undefined when value is a string", () => {
    const watcher = makeWatcher();
    const result = watcher.normaliseWatch({ ...base, timeoutAt: "soon" });
    expect(result?.timeoutAt).toBeUndefined();
  });

  // Branch 40 arm 1 (addedAt): typeof addedAt is not 'number' → && short-circuits → 0 fallback
  it("falls back to addedAt=0 when addedAt is not a number", () => {
    const watcher = makeWatcher();
    const result = watcher.normaliseWatch({ ...base, addedAt: "bad" });
    expect(result?.addedAt).toBe(0);
  });

  // Branch 42 arm 0: typeof r['lastPolledAt'] === 'number' → returns that value
  it("preserves lastPolledAt when it is a number", () => {
    const watcher = makeWatcher();
    const result = watcher.normaliseWatch({ ...base, lastPolledAt: 99_000 });
    expect(result?.lastPolledAt).toBe(99_000);
  });
});

describe("GitWatcher.normaliseBaseline — tags is not an array (line 323 arm 0)", () => {
  // Branch 51 arm 0: !Array.isArray(rawTags) → return undefined
  it("returns null when tags is not an array", () => {
    const watcher = makeWatcher();
    expect(
      watcher.normaliseBaseline({ headSha: "abc", branches: ["main"], tags: "bad" }),
    ).toBeNull();
  });

  it("returns null when tags is a number", () => {
    const watcher = makeWatcher();
    expect(
      watcher.normaliseBaseline({ headSha: "abc", branches: ["main"], tags: 0 }),
    ).toBeNull();
  });
});
