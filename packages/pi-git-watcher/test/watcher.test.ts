/**
 * Unit tests for GitWatcher (extends BaseWatcher).
 * Uses bracket-notation access for protected/private fields (same pattern as
 * the FsWatcher test in pi-file-system-watcher).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GitClient } from "../src/git-client.js";
import { GitClientError } from "../src/git-client.js";
import { GitWatcher } from "../src/watcher.js";
import { MAX_TIMEOUT_SECONDS } from "../src/toolAction.js";
import type { GitEvent, GitWatch } from "../src/types.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => ({
  readFileSync: vi.fn().mockImplementation(() => {
    throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
  }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeClient(overrides: Partial<GitClient> = {}): GitClient {
  return {
    isGitRepo: vi.fn().mockResolvedValue(true),
    resolveBranch: vi.fn().mockResolvedValue("abc1234".repeat(6).slice(0, 40)),
    listLocalBranches: vi.fn().mockResolvedValue(["main"]),
    listLocalTags: vi.fn().mockResolvedValue([]),
    getCommitSubject: vi.fn().mockResolvedValue("feat: initial"),
    ...overrides,
  };
}

function makeWatcher(clientOverrides: Partial<GitClient> = {}, nowMs?: number): {
  watcher: GitWatcher;
  pi: ReturnType<typeof makePi>;
  client: GitClient;
} {
  const pi = makePi();
  const client = makeClient(clientOverrides);
  const now = nowMs !== undefined ? () => nowMs : Date.now;
  const watcher = new GitWatcher({ pi, client, now });
  return { watcher, pi, client };
}

beforeEach(() => {
  vi.mocked(readFileSync).mockImplementation(() => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// addWatch — success
// ---------------------------------------------------------------------------

describe("GitWatcher.addWatch — success", () => {
  it("adds with targets=['new_commit'] — watches map has one entry", async () => {
    const { watcher } = makeWatcher();
    const result = await watcher["executeTool"]({
      action: "add",
      repoPath: "/repo",
      branch: "main",
      targets: ["new_commit"],
    });
    expect(result.details["ok"]).toBe(true);
    expect(watcher["watches"].size).toBe(1);
  });

  it("resolves relative repoPath to absolute", async () => {
    const { watcher } = makeWatcher();
    const result = await watcher["executeTool"]({
      action: "add",
      repoPath: ".",
      branch: "main",
      targets: ["new_commit"],
    });
    expect(result.details["ok"]).toBe(true);
    const watchId = result.details["watchId"] as string;
    const stored = watcher["watches"].get(watchId);
    expect(stored?.repoPath).toMatch(/^\//);
  });

  it("sets this.enabled = true after add", async () => {
    const { watcher } = makeWatcher();
    expect((watcher as unknown as { enabled: boolean }).enabled).toBe(false);
    await watcher["executeTool"]({
      action: "add",
      repoPath: "/repo",
      branch: "main",
      targets: ["new_commit"],
    });
    expect((watcher as unknown as { enabled: boolean }).enabled).toBe(true);
  });

  it("applies timeoutSeconds → stored as timeoutAt = addedAt + timeoutSeconds*1000", async () => {
    const { watcher } = makeWatcher({}, 10_000);
    const result = await watcher["executeTool"]({
      action: "add",
      repoPath: "/repo",
      branch: "main",
      targets: ["new_commit"],
      timeoutSeconds: 60,
    });
    expect(result.details["ok"]).toBe(true);
    const watchId = result.details["watchId"] as string;
    expect(watcher["watches"].get(watchId)?.timeoutAt).toBe(10_000 + 60_000);
  });

  it("caps timeoutSeconds to MAX_TIMEOUT_SECONDS", async () => {
    const { watcher } = makeWatcher({}, 10_000);
    const result = await watcher["executeTool"]({
      action: "add",
      repoPath: "/repo",
      branch: "main",
      targets: ["new_commit"],
      timeoutSeconds: MAX_TIMEOUT_SECONDS + 3600,
    });
    expect(result.details["ok"]).toBe(true);
    const watchId = result.details["watchId"] as string;
    expect(watcher["watches"].get(watchId)?.timeoutAt).toBe(
      10_000 + MAX_TIMEOUT_SECONDS * 1000,
    );
    expect((result.content[0] as { text: string }).text).toMatch(/capped/);
  });
});

// ---------------------------------------------------------------------------
// addWatch — rejections
// ---------------------------------------------------------------------------

describe("GitWatcher.addWatch — rejections", () => {
  it("missing repoPath → error message", async () => {
    const { watcher } = makeWatcher();
    const result = await watcher["executeTool"]({
      action: "add",
      branch: "main",
      targets: ["new_commit"],
    });
    expect(result.details["ok"]).toBe(false);
    expect((result.content[0] as { text: string }).text).toMatch(/repoPath/);
  });

  it("missing branch → error message", async () => {
    const { watcher } = makeWatcher();
    const result = await watcher["executeTool"]({
      action: "add",
      repoPath: "/repo",
      targets: ["new_commit"],
    });
    expect(result.details["ok"]).toBe(false);
    expect((result.content[0] as { text: string }).text).toMatch(/branch/);
  });

  it("empty targets array → error message", async () => {
    const { watcher } = makeWatcher();
    const result = await watcher["executeTool"]({
      action: "add",
      repoPath: "/repo",
      branch: "main",
      targets: [],
    });
    expect(result.details["ok"]).toBe(false);
    expect((result.content[0] as { text: string }).text).toMatch(/targets/);
  });

  it("invalid target string → error message", async () => {
    const { watcher } = makeWatcher();
    const result = await watcher["executeTool"]({
      action: "add",
      repoPath: "/repo",
      branch: "main",
      targets: ["invalid_target"],
    });
    expect(result.details["ok"]).toBe(false);
    expect((result.content[0] as { text: string }).text).toMatch(/Invalid target/);
  });

  it("isGitRepo returns false → error containing 'not a git repository'", async () => {
    const { watcher } = makeWatcher({
      isGitRepo: vi.fn().mockResolvedValue(false),
    });
    const result = await watcher["executeTool"]({
      action: "add",
      repoPath: "/not-a-repo",
      branch: "main",
      targets: ["new_commit"],
    });
    expect(result.details["ok"]).toBe(false);
    expect((result.content[0] as { text: string }).text).toMatch(/not a git repository/i);
  });

  it("new_commit + branch not found → error containing 'does not exist'", async () => {
    const { watcher } = makeWatcher({
      resolveBranch: vi.fn().mockResolvedValue(undefined),
    });
    const result = await watcher["executeTool"]({
      action: "add",
      repoPath: "/repo",
      branch: "nonexistent",
      targets: ["new_commit"],
    });
    expect(result.details["ok"]).toBe(false);
    expect((result.content[0] as { text: string }).text).toMatch(/does not exist/);
  });
});

// ---------------------------------------------------------------------------
// addWatch — soft fail on snapshot error
// ---------------------------------------------------------------------------

describe("GitWatcher.addWatch — soft fail on snapshot error", () => {
  it("resolveBranch throws during seed → watch still added, baseline undefined", async () => {
    const resolveBranch = vi.fn()
      .mockResolvedValueOnce("abc1234abc1234abc1234abc1234abc1234abc1234")
      .mockRejectedValueOnce(new Error("git error"));
    const { watcher } = makeWatcher({ resolveBranch });
    const result = await watcher["executeTool"]({
      action: "add",
      repoPath: "/repo",
      branch: "main",
      targets: ["new_commit"],
    });
    expect(result.details["ok"]).toBe(true);
    const watchId = result.details["watchId"] as string;
    expect(watcher["watches"].get(watchId)?.baseline).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toMatch(/seeding failed/);
  });
});

// ---------------------------------------------------------------------------
// removeWatch
// ---------------------------------------------------------------------------

describe("GitWatcher.removeWatch", () => {
  it("removes the watch and returns success", async () => {
    const { watcher } = makeWatcher();
    const addResult = await watcher["executeTool"]({
      action: "add",
      repoPath: "/repo",
      branch: "main",
      targets: ["new_commit"],
    });
    const watchId = addResult.details["watchId"] as string;
    expect(watcher["watches"].size).toBe(1);

    const removeResult = await watcher["executeTool"]({ action: "remove", watchId });
    expect(removeResult.details["ok"]).toBe(true);
    expect(watcher["watches"].size).toBe(0);
  });

  it("returns error for unknown watchId", async () => {
    const { watcher } = makeWatcher();
    const result = await watcher["executeTool"]({ action: "remove", watchId: "no-such-id" });
    expect((result.content[0] as { text: string }).text).toMatch(/No watch found/);
  });
});

// ---------------------------------------------------------------------------
// detectChanges — timeout path
// ---------------------------------------------------------------------------

describe("GitWatcher.detectChanges — timeout", () => {
  it("creates timeout event when timeoutAt is in the past", async () => {
    const { watcher } = makeWatcher({}, 9_999);
    const addResult = await watcher["executeTool"]({
      action: "add",
      repoPath: "/repo",
      branch: "main",
      targets: ["new_commit"],
      timeoutSeconds: 1,
    });
    const watchId = addResult.details["watchId"] as string;
    const watch = watcher["watches"].get(watchId)!;
    watch.timeoutAt = 5_000;

    const result = await watcher.detectChanges(watch);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.eventType).toBe("timeout");
    expect(result.events[0]!.isTerminal).toBe(true);
    expect(result.observedChange).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// containsTerminalStateEvent
// ---------------------------------------------------------------------------

describe("GitWatcher.containsTerminalStateEvent", () => {
  it("returns false for non-terminal events", () => {
    const { watcher } = makeWatcher();
    const containsTerminal = (
      watcher as unknown as { containsTerminalStateEvent(e: GitEvent[]): boolean }
    ).containsTerminalStateEvent.bind(watcher);
    expect(containsTerminal([{ eventType: "new_commit", isTerminal: false } as GitEvent])).toBe(false);
  });

  it("returns true for timeout event", () => {
    const { watcher } = makeWatcher();
    const containsTerminal = (
      watcher as unknown as { containsTerminalStateEvent(e: GitEvent[]): boolean }
    ).containsTerminalStateEvent.bind(watcher);
    expect(containsTerminal([{ eventType: "timeout", isTerminal: true } as GitEvent])).toBe(true);
  });

  it("returns false for empty array", () => {
    const { watcher } = makeWatcher();
    const containsTerminal = (
      watcher as unknown as { containsTerminalStateEvent(e: GitEvent[]): boolean }
    ).containsTerminalStateEvent.bind(watcher);
    expect(containsTerminal([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

type ClassifyFn = (err: unknown) => { kind: string; userMessage: string; shouldBackoff: boolean };

describe("GitWatcher.classifyError", () => {
  it("classifies not_a_repo", () => {
    const { watcher } = makeWatcher();
    const classify = (watcher as unknown as { classifyError: ClassifyFn }).classifyError.bind(watcher);
    expect(classify(new GitClientError("not_a_repo", "x")).userMessage).toBe("not a git repository");
  });

  it("classifies git_not_installed", () => {
    const { watcher } = makeWatcher();
    const classify = (watcher as unknown as { classifyError: ClassifyFn }).classifyError.bind(watcher);
    expect(classify(new GitClientError("git_not_installed", "x")).userMessage).toContain("git CLI");
  });

  it("classifies permission_denied as auth kind", () => {
    const { watcher } = makeWatcher();
    const classify = (watcher as unknown as { classifyError: ClassifyFn }).classifyError.bind(watcher);
    expect(classify(new GitClientError("permission_denied", "x")).kind).toBe("auth");
  });

  it("classifies index_locked with shouldBackoff=true", () => {
    const { watcher } = makeWatcher();
    const classify = (watcher as unknown as { classifyError: ClassifyFn }).classifyError.bind(watcher);
    expect(classify(new GitClientError("index_locked", "x")).shouldBackoff).toBe(true);
  });

  it("classifies unknown errors as generic", () => {
    const { watcher } = makeWatcher();
    const classify = (watcher as unknown as { classifyError: ClassifyFn }).classifyError.bind(watcher);
    expect(classify(new Error("unknown")).userMessage).toBe("git poll failed");
  });

  it("classifies null gracefully", () => {
    const { watcher } = makeWatcher();
    const classify = (watcher as unknown as { classifyError: ClassifyFn }).classifyError.bind(watcher);
    const result = classify(null);
    expect(result.kind).toBe("generic");
  });
});

// ---------------------------------------------------------------------------
// normaliseWatch
// ---------------------------------------------------------------------------

describe("GitWatcher.normaliseWatch", () => {
  const valid = {
    watchId: "a",
    repoPath: "/r",
    branch: "main",
    targets: ["new_commit"],
    timeoutAt: undefined,
    addedAt: 1,
    lastPolledAt: undefined,
    baseline: undefined,
    terminal: false,
    consecutiveErrors: 0,
  };

  it("round-trips a valid watch", () => {
    const { watcher } = makeWatcher();
    expect(watcher.normaliseWatch(valid)).toMatchObject({
      watchId: "a",
      repoPath: "/r",
      branch: "main",
      targets: ["new_commit"],
    });
  });

  it("returns null for null input", () => {
    const { watcher } = makeWatcher();
    expect(watcher.normaliseWatch(null)).toBeNull();
  });

  it("returns null when watchId is missing", () => {
    const { watcher } = makeWatcher();
    expect(watcher.normaliseWatch({ ...valid, watchId: undefined })).toBeNull();
  });

  it("returns null when all targets are invalid → empty → null", () => {
    const { watcher } = makeWatcher();
    expect(watcher.normaliseWatch({ ...valid, targets: ["invalid"] })).toBeNull();
  });

  it("drops invalid targets from mixed array", () => {
    const { watcher } = makeWatcher();
    const result = watcher.normaliseWatch({ ...valid, targets: ["new_commit", "INVALID"] });
    expect(result?.targets).toEqual(["new_commit"]);
  });

  it("returns null for empty targets array", () => {
    const { watcher } = makeWatcher();
    expect(watcher.normaliseWatch({ ...valid, targets: [] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normaliseBaseline
// ---------------------------------------------------------------------------

describe("GitWatcher.normaliseBaseline", () => {
  it("round-trips a valid baseline", () => {
    const { watcher } = makeWatcher();
    const valid = { headSha: "abc", branches: ["main"], tags: [] };
    expect(watcher.normaliseBaseline(valid)).toEqual(valid);
  });

  it("returns null for null", () => {
    const { watcher } = makeWatcher();
    expect(watcher.normaliseBaseline(null)).toBeNull();
  });

  it("headSha as number → headSha becomes undefined (still valid baseline)", () => {
    const { watcher } = makeWatcher();
    const result = watcher.normaliseBaseline({ headSha: 123, branches: [], tags: [] });
    expect(result).not.toBeNull();
    expect(result?.headSha).toBeUndefined();
  });

  it("accepts baseline with headSha=undefined", () => {
    const { watcher } = makeWatcher();
    const result = watcher.normaliseBaseline({ headSha: undefined, branches: [], tags: [] });
    expect(result).not.toBeNull();
    expect(result?.headSha).toBeUndefined();
  });

  it("returns null when branches is missing", () => {
    const { watcher } = makeWatcher();
    expect(watcher.normaliseBaseline({ headSha: "abc", tags: [] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

describe("GitWatcher.view", () => {
  it("noun is 'repository'", () => {
    const { watcher } = makeWatcher();
    expect(watcher.view.noun).toBe("repository");
  });

  it("renderItemRowText includes branch and targets", () => {
    const { watcher } = makeWatcher();
    const watch: GitWatch = {
      watchId: "a",
      repoPath: "/repo/myproject",
      branch: "main",
      targets: ["new_commit"],
      timeoutAt: undefined,
      addedAt: Date.now(),
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
    };
    const rowText = watcher.view.renderItemRowText(watch);
    expect(rowText).toContain("main");
    expect(rowText).toContain("new_commit");
  });

  it("renderItemRowText shows DONE for terminal watch", () => {
    const { watcher } = makeWatcher();
    const watch: GitWatch = {
      watchId: "a",
      repoPath: "/repo/myproject",
      branch: "main",
      targets: ["new_commit"],
      timeoutAt: undefined,
      addedAt: Date.now(),
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: true,
      consecutiveErrors: 0,
    };
    expect(watcher.view.renderItemRowText(watch)).toContain("DONE");
  });

  it("renderEventRow returns event.formatted", () => {
    const { watcher } = makeWatcher();
    const event: GitEvent = {
      watchId: "a",
      repoPath: "/r",
      branch: "main",
      eventType: "new_commit",
      sha: "abc1234",
      isTerminal: false,
      summary: "new commit",
      formatted: "• new commit ✓",
      timestamp: 1000,
    };
    expect(watcher.view.renderEventRow(event)).toBe("• new commit ✓");
  });

  it("isRowDimmed returns true for terminal watch", () => {
    const { watcher } = makeWatcher();
    const watch: GitWatch = {
      watchId: "a",
      repoPath: "/r",
      branch: "main",
      targets: ["new_commit"],
      timeoutAt: undefined,
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: true,
      consecutiveErrors: 0,
    };
    expect(watcher.view.isRowDimmed!(watch)).toBe(true);
  });

  it("isRowDimmed returns false for active watch", () => {
    const { watcher } = makeWatcher();
    const watch: GitWatch = {
      watchId: "a",
      repoPath: "/r",
      branch: "main",
      targets: ["new_commit"],
      timeoutAt: undefined,
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
    };
    expect(watcher.view.isRowDimmed!(watch)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-watch schedulers
// ---------------------------------------------------------------------------

describe("GitWatcher per-watch schedulers", () => {
  it("schedulerFor returns same instance on second call", () => {
    const { watcher } = makeWatcher();
    const sf = (watcher as unknown as { schedulerFor(k: string): unknown }).schedulerFor.bind(watcher);
    const s1 = sf("key1");
    const s2 = sf("key1");
    expect(s1).toBe(s2);
    expect(s1).not.toBe(sf("key2"));
  });

  it("addWatch starts a per-watch scheduler when not paused", async () => {
    vi.useFakeTimers();
    const { watcher } = makeWatcher();
    const result = await watcher["executeTool"]({
      action: "add",
      repoPath: "/repo",
      branch: "main",
      targets: ["new_commit"],
    });
    const watchId = result.details["watchId"] as string;
    const schedulers = (
      watcher as unknown as { _watchSchedulers: Map<string, { isRunning: boolean }> }
    )._watchSchedulers;
    expect(schedulers.get(watchId)?.isRunning).toBe(true);
    watcher.stopPolling();
    vi.useRealTimers();
  });

  it("stopPolling stops all per-watch schedulers", async () => {
    vi.useFakeTimers();
    const { watcher } = makeWatcher();
    await watcher["executeTool"]({
      action: "add",
      repoPath: "/repo/a",
      branch: "main",
      targets: ["new_commit"],
    });
    await watcher["executeTool"]({
      action: "add",
      repoPath: "/repo/b",
      branch: "main",
      targets: ["branch_created"],
    });
    watcher.stopPolling();
    const schedulers = (
      watcher as unknown as { _watchSchedulers: Map<string, { isRunning: boolean }> }
    )._watchSchedulers;
    for (const s of schedulers.values()) {
      expect(s.isRunning).toBe(false);
    }
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Constructor — defaultDisplayMode
// ---------------------------------------------------------------------------

describe("GitWatcher constructor defaultDisplayMode", () => {
  it("sets defaultDisplayMode from config when provided", () => {
    vi.mocked(readFileSync).mockReturnValueOnce(JSON.stringify({ defaultDisplayMode: "statusline" }));
    const { watcher } = makeWatcher();
    expect((watcher as unknown as { defaultDisplayMode: string | undefined }).defaultDisplayMode).toBe("statusline");
  });

  it("does not set defaultDisplayMode when config has no value", () => {
    // readFileSync throws ENOENT by default — loadWatcherConfig() returns {}
    const { watcher } = makeWatcher();
    expect((watcher as unknown as { defaultDisplayMode: string | undefined }).defaultDisplayMode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

describe("GitWatcher identity", () => {
  it("extensionName is 'pi-git-watcher'", () => {
    const { watcher } = makeWatcher();
    expect(watcher.extensionName).toBe("pi-git-watcher");
  });

  it("toolName is 'git_watcher'", () => {
    const { watcher } = makeWatcher();
    expect(watcher.toolName).toBe("git_watcher");
  });

  it("statusLabel is 'git'", () => {
    const { watcher } = makeWatcher();
    expect((watcher as unknown as { statusLabel: string }).statusLabel).toBe("git");
  });
});

// ---------------------------------------------------------------------------
// browseOptions
// ---------------------------------------------------------------------------

describe("GitWatcher.browseOptions", () => {
  it("searchable is false", () => {
    const { watcher } = makeWatcher();
    const opts = (watcher as unknown as {
      browseOptions(): { searchable?: boolean; rowActions?: Array<{ id: string }> };
    }).browseOptions();
    expect(opts["searchable"]).toBe(false);
  });

  it("has remove rowAction", () => {
    const { watcher } = makeWatcher();
    const opts = (watcher as unknown as {
      browseOptions(): { searchable?: boolean; rowActions?: Array<{ id: string }> };
    }).browseOptions();
    expect(opts.rowActions?.some((a) => a.id === "remove")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Additional branch coverage tests
// ---------------------------------------------------------------------------

describe("GitWatcher.addWatch — branch validation edge cases", () => {
  it("rejects branch with spaces", async () => {
    const { watcher } = makeWatcher();
    const result = await watcher["executeTool"]({
      action: "add",
      repoPath: "/repo",
      branch: "my branch",
      targets: ["new_commit"],
    });
    expect(result.details["ok"]).toBe(false);
    expect((result.content[0] as { text: string }).text).toMatch(/spaces/);
  });

  it("rejects branch with double dots", async () => {
    const { watcher } = makeWatcher();
    const result = await watcher["executeTool"]({
      action: "add",
      repoPath: "/repo",
      branch: "feat..broken",
      targets: ["new_commit"],
    });
    expect(result.details["ok"]).toBe(false);
    expect((result.content[0] as { text: string }).text).toMatch(/\.\./);
  });

  it("rejects non-finite timeoutSeconds", async () => {
    const { watcher } = makeWatcher();
    const result = await watcher["executeTool"]({
      action: "add",
      repoPath: "/repo",
      branch: "main",
      targets: ["new_commit"],
      timeoutSeconds: Infinity,
    });
    expect(result.details["ok"]).toBe(false);
    expect((result.content[0] as { text: string }).text).toMatch(/timeoutSeconds/);
  });

  it("rejects zero timeoutSeconds", async () => {
    const { watcher } = makeWatcher();
    const result = await watcher["executeTool"]({
      action: "add",
      repoPath: "/repo",
      branch: "main",
      targets: ["new_commit"],
      timeoutSeconds: 0,
    });
    expect(result.details["ok"]).toBe(false);
    expect((result.content[0] as { text: string }).text).toMatch(/timeoutSeconds/);
  });
});

describe("GitWatcher view rendering", () => {
  it("renderItemRowTUI returns columns with repo first", () => {
    const { watcher } = makeWatcher();
    const watch: GitWatch = {
      watchId: "a",
      repoPath: "/repo/myproject",
      branch: "main",
      targets: ["new_commit"],
      timeoutAt: undefined,
      addedAt: Date.now(),
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
    };
    const cols = watcher.view.renderItemRowTUI(watch, {
      theme: {} as never,
      width: 80,
    });
    expect(cols.length).toBeGreaterThan(0);
    expect(cols[0]?.name).toBe("repo");
    expect(cols[0]?.text).toContain("main");
  });

  it("renderItemDetail includes expected fields", () => {
    const { watcher } = makeWatcher();
    const watch: GitWatch = {
      watchId: "w1",
      repoPath: "/repo/myproject",
      branch: "main",
      targets: ["new_commit"],
      timeoutAt: undefined,
      addedAt: Date.now(),
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
    };
    const fields = watcher.view.renderItemDetail(watch, {
      theme: {} as never,
      width: 80,
    });
    expect(fields.find((f) => f.label === "repoPath")?.value).toBe("/repo/myproject");
    expect(fields.find((f) => f.label === "branch")?.value).toBe("main");
    expect(fields.find((f) => f.label === "terminal")?.value).toBe("no");
    expect(fields.find((f) => f.label === "polled")?.value).toBe("never");
  });

  it("compressColumns compresses long repo paths", () => {
    const { watcher } = makeWatcher();
    const longPath = "/very/deeply/nested/directory/structure/with/a/long/filename";
    const cols = [
      { name: "repo", text: `${longPath} [main]` },
      { name: "head", text: "abc1234", width: 9 },
      { name: "targets", text: "new_commit", width: 14 },
      { name: "status", text: "WATCHING", width: 10 },
      { name: "timeout", text: "-", width: 10 },
    ];
    const result = watcher.view.compressColumns!(cols, 80);
    const repoCol = result.find((c) => c.name === "repo")!;
    // Should be truncated
    expect(repoCol.text.length).toBeLessThanOrEqual(37); // 80 - 9 - 14 - 10 - 10 - 4*2 separators
  });

  it("itemSortKey returns repoPath + branch", () => {
    const { watcher } = makeWatcher();
    const watch: GitWatch = {
      watchId: "a",
      repoPath: "/repo/myproject",
      branch: "main",
      targets: ["new_commit"],
      timeoutAt: undefined,
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
    };
    expect(watcher.view.itemSortKey(watch)).toBe("/repo/myproject#main");
  });

  it("itemGroup returns repoPath", () => {
    const { watcher } = makeWatcher();
    const watch: GitWatch = {
      watchId: "a",
      repoPath: "/repo/myproject",
      branch: "main",
      targets: ["new_commit"],
      timeoutAt: undefined,
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
    };
    expect(watcher.view.itemGroup!(watch)).toBe("/repo/myproject");
  });
});

describe("GitWatcher startPolling", () => {
  it("starts only non-terminal watches", () => {
    vi.useFakeTimers();
    const { watcher } = makeWatcher();
    (watcher as unknown as { paused: boolean }).paused = true;
    watcher["watches"].set("w1", {
      watchId: "w1",
      repoPath: "/repo",
      branch: "main",
      targets: ["new_commit"],
      timeoutAt: undefined,
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
    });
    watcher["watches"].set("w2", {
      watchId: "w2",
      repoPath: "/repo",
      branch: "develop",
      targets: ["new_commit"],
      timeoutAt: undefined,
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: true,
      consecutiveErrors: 0,
    });
    (watcher as unknown as { paused: boolean }).paused = false;
    watcher.startPolling();
    const schedulers = (watcher as unknown as { _watchSchedulers: Map<string, { isRunning: boolean }> })._watchSchedulers;
    expect(schedulers.get("w1")?.isRunning).toBe(true);
    expect(schedulers.get("w2")).toBeUndefined();
    watcher.stopPolling();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// formatTimeLeft / compressPath direct tests
// ---------------------------------------------------------------------------
import { formatTimeLeft, compressPath } from "../src/watcher.js";

describe("formatTimeLeft", () => {
  it("returns '-' when no timeoutAt", () => {
    expect(formatTimeLeft(undefined, 0)).toBe("-");
  });
  it("returns 'expired' when past", () => {
    expect(formatTimeLeft(1000, 2000)).toBe("expired");
  });
  it("returns Xs left for seconds", () => {
    expect(formatTimeLeft(31_000, 1_000)).toBe("30s left");
  });
  it("returns Xm left for minutes", () => {
    expect(formatTimeLeft(121_000, 1_000)).toBe("2m left");
  });
  it("returns Xh left for hours", () => {
    expect(formatTimeLeft(3_601_000, 1_000)).toBe("1h left");
  });
});

describe("compressPath", () => {
  it("returns path unchanged when it fits", () => {
    expect(compressPath("/tmp/foo.json", 50)).toBe("/tmp/foo.json");
  });
  it("truncates from the left with ellipsis", () => {
    const long = "/very/deep/path/to/file.json";
    const result = compressPath(long, 15);
    expect(result.startsWith("…")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(15);
  });
  it("returns ellipsis when maxWidth is 1", () => {
    expect(compressPath("/a/b", 1)).toBe("…");
  });
  it("returns ellipsis when maxWidth is 0", () => {
    expect(compressPath("/a/b", 0)).toBe("…");
  });
});
