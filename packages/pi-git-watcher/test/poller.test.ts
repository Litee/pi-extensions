import { describe, expect, it, vi } from "vitest";

import type { GitClient } from "../src/git-client.js";
import type { GitBaseline, GitWatch, TargetCondition } from "../src/types.js";
import { arrayDiff, buildTimeoutEvent, detectChanges, snapshotRepo } from "../src/poller.js";

const SHA1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function makeClient(overrides: Partial<GitClient> = {}): GitClient {
  return {
    isGitRepo: vi.fn().mockResolvedValue(true),
    resolveBranch: vi.fn().mockResolvedValue(SHA1),
    listLocalBranches: vi.fn().mockResolvedValue(["main"]),
    listLocalTags: vi.fn().mockResolvedValue([]),
    getCommitSubject: vi.fn().mockResolvedValue("feat: initial"),
    ...overrides,
  };
}

function makeWatch(targets: TargetCondition[], baseline?: GitBaseline): GitWatch {
  return {
    watchId: "test01",
    repoPath: "/repo/myproject",
    branch: "main",
    targets,
    timeoutAt: undefined,
    addedAt: 1000,
    lastPolledAt: undefined,
    baseline: baseline ?? undefined,
    terminal: false,
    consecutiveErrors: 0,
  };
}

// ---------------------------------------------------------------------------
// snapshotRepo
// ---------------------------------------------------------------------------

describe("snapshotRepo", () => {
  it("calls resolveBranch with watch.branch (not HEAD)", async () => {
    const resolveBranchMock = vi.fn().mockResolvedValue(SHA1);
    const client = makeClient({ resolveBranch: resolveBranchMock });
    const watch = makeWatch(["new_commit"]);
    await snapshotRepo(client, watch);
    expect(resolveBranchMock).toHaveBeenCalledWith("/repo/myproject", "main");
  });

  it("returns GitBaseline with headSha, branches, tags", async () => {
    const client = makeClient({
      resolveBranch: vi.fn().mockResolvedValue(SHA1),
      listLocalBranches: vi.fn().mockResolvedValue(["develop", "main"]),
      listLocalTags: vi.fn().mockResolvedValue(["v1.0.0"]),
    });
    const watch = makeWatch(["new_commit"]);
    const baseline = await snapshotRepo(client, watch);
    expect(baseline.headSha).toBe(SHA1);
    expect(baseline.branches).toEqual(["develop", "main"]);
    expect(baseline.tags).toEqual(["v1.0.0"]);
  });

  it("headSha is undefined when resolveBranch returns undefined", async () => {
    const client = makeClient({
      resolveBranch: vi.fn().mockResolvedValue(undefined),
    });
    const watch = makeWatch(["new_commit"]);
    const baseline = await snapshotRepo(client, watch);
    expect(baseline.headSha).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// detectChanges — first poll (no baseline)
// ---------------------------------------------------------------------------

describe("detectChanges — first poll", () => {
  it("returns events=[], observedChange=false, newBaseline set from snapshot", async () => {
    const client = makeClient({
      resolveBranch: vi.fn().mockResolvedValue(SHA1),
      listLocalBranches: vi.fn().mockResolvedValue(["main"]),
      listLocalTags: vi.fn().mockResolvedValue([]),
    });
    const watch = makeWatch(["new_commit"]); // no baseline
    const result = await detectChanges(client, watch, 5000);
    expect(result.events).toHaveLength(0);
    expect(result.observedChange).toBe(false);
    expect(result.newBaseline.headSha).toBe(SHA1);
    expect(result.newBaseline.branches).toEqual(["main"]);
  });
});

// ---------------------------------------------------------------------------
// detectChanges — new_commit
// ---------------------------------------------------------------------------

describe("detectChanges — new_commit", () => {
  it("prev.headSha !== now.headSha → event with eventType='new_commit'", async () => {
    const client = makeClient({
      resolveBranch: vi.fn().mockResolvedValue(SHA2),
    });
    const baseline: GitBaseline = { headSha: SHA1, branches: ["main"], tags: [] };
    const watch = makeWatch(["new_commit"], baseline);
    const result = await detectChanges(client, watch, 5000);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.eventType).toBe("new_commit");
    expect(result.events[0]!.sha).toBe(SHA2);
    expect(result.events[0]!.isTerminal).toBe(false);
  });

  it("same SHA → no events", async () => {
    const client = makeClient({
      resolveBranch: vi.fn().mockResolvedValue(SHA1),
    });
    const baseline: GitBaseline = { headSha: SHA1, branches: ["main"], tags: [] };
    const watch = makeWatch(["new_commit"], baseline);
    const result = await detectChanges(client, watch, 5000);
    expect(result.events).toHaveLength(0);
  });

  it("prev.headSha undefined (branch just appeared) → no new_commit event", async () => {
    const client = makeClient({
      resolveBranch: vi.fn().mockResolvedValue(SHA2),
    });
    const baseline: GitBaseline = { headSha: undefined, branches: ["main"], tags: [] };
    const watch = makeWatch(["new_commit"], baseline);
    const result = await detectChanges(client, watch, 5000);
    const commitEvents = result.events.filter((e) => e.eventType === "new_commit");
    expect(commitEvents).toHaveLength(0);
  });

  it("getCommitSubject failure → commitSubject undefined, event still emitted", async () => {
    const client = makeClient({
      resolveBranch: vi.fn().mockResolvedValue(SHA2),
      getCommitSubject: vi.fn().mockRejectedValue(new Error("git error")),
    });
    const baseline: GitBaseline = { headSha: SHA1, branches: ["main"], tags: [] };
    const watch = makeWatch(["new_commit"], baseline);
    const result = await detectChanges(client, watch, 5000);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.eventType).toBe("new_commit");
    expect(result.events[0]!.commitSubject).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// detectChanges — branch_created
// ---------------------------------------------------------------------------

describe("detectChanges — branch_created", () => {
  it("new branch in now.branches → event with eventType='branch_created'", async () => {
    const client = makeClient({
      listLocalBranches: vi.fn().mockResolvedValue(["feature/foo", "main"]),
    });
    const baseline: GitBaseline = { headSha: SHA1, branches: ["main"], tags: [] };
    const watch = makeWatch(["branch_created"], baseline);
    const result = await detectChanges(client, watch, 5000);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.eventType).toBe("branch_created");
    expect(result.events[0]!.affectedBranch).toBe("feature/foo");
  });

  it("multiple new branches → multiple events", async () => {
    const client = makeClient({
      listLocalBranches: vi.fn().mockResolvedValue(["develop", "feature/bar", "main"]),
    });
    const baseline: GitBaseline = { headSha: SHA1, branches: ["main"], tags: [] };
    const watch = makeWatch(["branch_created"], baseline);
    const result = await detectChanges(client, watch, 5000);
    const created = result.events.filter((e) => e.eventType === "branch_created");
    expect(created).toHaveLength(2);
    expect(created.map((e) => e.affectedBranch).sort()).toEqual(["develop", "feature/bar"]);
  });
});

// ---------------------------------------------------------------------------
// detectChanges — branch_deleted
// ---------------------------------------------------------------------------

describe("detectChanges — branch_deleted", () => {
  it("branch gone from now.branches → event with eventType='branch_deleted'", async () => {
    const client = makeClient({
      listLocalBranches: vi.fn().mockResolvedValue(["main"]),
    });
    const baseline: GitBaseline = {
      headSha: SHA1,
      branches: ["feature/old", "main"],
      tags: [],
    };
    const watch = makeWatch(["branch_deleted"], baseline);
    const result = await detectChanges(client, watch, 5000);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.eventType).toBe("branch_deleted");
    expect(result.events[0]!.affectedBranch).toBe("feature/old");
  });
});

// ---------------------------------------------------------------------------
// detectChanges — tag_created
// ---------------------------------------------------------------------------

describe("detectChanges — tag_created", () => {
  it("new tag → event with eventType='tag_created', tagName set", async () => {
    const client = makeClient({
      listLocalTags: vi.fn().mockResolvedValue(["v1.1.0"]),
    });
    const baseline: GitBaseline = { headSha: SHA1, branches: ["main"], tags: [] };
    const watch = makeWatch(["tag_created"], baseline);
    const result = await detectChanges(client, watch, 5000);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.eventType).toBe("tag_created");
    expect(result.events[0]!.tagName).toBe("v1.1.0");
  });
});

// ---------------------------------------------------------------------------
// detectChanges — multi-target
// ---------------------------------------------------------------------------

describe("detectChanges — multi-target", () => {
  it("SHA changed + new branch + new tag → 3 events", async () => {
    const client = makeClient({
      resolveBranch: vi.fn().mockResolvedValue(SHA2),
      listLocalBranches: vi.fn().mockResolvedValue(["feature/new", "main"]),
      listLocalTags: vi.fn().mockResolvedValue(["v1.0.0"]),
      getCommitSubject: vi.fn().mockResolvedValue("chore: bump"),
    });
    const baseline: GitBaseline = { headSha: SHA1, branches: ["main"], tags: [] };
    const watch = makeWatch(["new_commit", "branch_created", "tag_created"], baseline);
    const result = await detectChanges(client, watch, 5000);
    expect(result.events).toHaveLength(3);
    const types = result.events.map((e) => e.eventType).sort();
    expect(types).toEqual(["branch_created", "new_commit", "tag_created"]);
  });
});

// ---------------------------------------------------------------------------
// detectChanges — untargeted delta
// ---------------------------------------------------------------------------

describe("detectChanges — untargeted delta", () => {
  it("new tag appears but targets=['new_commit'] → events=[], observedChange=true", async () => {
    const client = makeClient({
      resolveBranch: vi.fn().mockResolvedValue(SHA1), // SHA unchanged
      listLocalBranches: vi.fn().mockResolvedValue(["main"]),
      listLocalTags: vi.fn().mockResolvedValue(["v2.0.0"]), // new tag
    });
    const baseline: GitBaseline = { headSha: SHA1, branches: ["main"], tags: [] };
    const watch = makeWatch(["new_commit"], baseline);
    const result = await detectChanges(client, watch, 5000);
    expect(result.events).toHaveLength(0);
    expect(result.observedChange).toBe(true); // tag change resets backoff
  });
});

// ---------------------------------------------------------------------------
// buildTimeoutEvent
// ---------------------------------------------------------------------------

describe("buildTimeoutEvent", () => {
  it("isTerminal=true, eventType='timeout', formatted ends with '✗'", () => {
    const watch = makeWatch(["new_commit"]);
    const ev = buildTimeoutEvent(watch, 9999);
    expect(ev.isTerminal).toBe(true);
    expect(ev.eventType).toBe("timeout");
    expect(ev.formatted.endsWith("✗")).toBe(true);
    expect(ev.formatted.startsWith("•")).toBe(true);
    expect(ev.timestamp).toBe(9999);
  });
});

// ---------------------------------------------------------------------------
// arrayDiff
// ---------------------------------------------------------------------------

describe("arrayDiff", () => {
  it("arrayDiff([], []) → []", () => {
    expect(arrayDiff([], [])).toEqual([]);
  });

  it("arrayDiff(['a'], ['a']) → []", () => {
    expect(arrayDiff(["a"], ["a"])).toEqual([]);
  });

  it("arrayDiff([], ['a','b']) → ['a','b']", () => {
    expect(arrayDiff([], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("arrayDiff(['a','b'], []) → []", () => {
    expect(arrayDiff(["a", "b"], [])).toEqual([]);
  });

  it("arrayDiff(['a','c'], ['b','c']) → ['b']", () => {
    expect(arrayDiff(["a", "c"], ["b", "c"])).toEqual(["b"]);
  });

  it("returns elements in b not in a", () => {
    expect(arrayDiff(["a", "b", "c"], ["b", "c", "d"])).toEqual(["d"]);
  });
});
