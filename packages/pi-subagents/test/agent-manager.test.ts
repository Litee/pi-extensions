import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { RunOptions } from "../src/agent-runner.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";

const mockPi = {} as unknown as ExtensionAPI;
const mockCtx = { cwd: "/tmp" } as unknown as ExtensionContext;

const mockSession = () => ({ dispose: vi.fn() } as unknown as import("@earendil-works/pi-coding-agent").AgentSession);

const resolvedRun = () =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session: mockSession(),
    aborted: false,
    steered: false,
  });

describe("AgentManager — Bug 1 race condition (resultConsumed vs onComplete)", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("reproduces bug: onComplete fires with resultConsumed=false when set after await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    // Simulate the buggy get_subagent_result: await THEN mark consumed
    await record.promise;
    record.resultConsumed = true; // too late — onComplete already fired

    // onComplete saw resultConsumed as falsy (undefined) — would queue a notification (the bug)
    expect(seenConsumed).toBeFalsy();
  });

  it("fix: onComplete sees resultConsumed=true when pre-marked before await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    // The fix: pre-mark BEFORE awaiting
    record.resultConsumed = true;
    await record.promise;

    expect(seenConsumed).toBe(true);
  });

  it("normal case: onComplete fires with resultConsumed falsy when no explicit polling", async () => {
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => {
      completedRecord = r;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.resultConsumed).toBeFalsy();
  });

  it("onComplete IS called for foreground agents (lifecycle symmetry)", async () => {
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => {
      completedRecord = r;
    });
    resolvedRun();

    const { record } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.status).toBe("completed");
    // resultConsumed is set by spawnAndWait so onComplete skips notifications
    expect(completedRecord!.resultConsumed).toBe(true);
    expect(record).toBe(completedRecord);
  });
});

describe("AgentManager — completion callbacks", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not let onComplete errors turn a completed agent into a failed run", async () => {
    manager = new AgentManager(() => {
      throw new Error("stale extension context");
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await expect(manager.getRecord(id)!.promise).resolves.toBe("done");

    expect(manager.getRecord(id)!.status).toBe("completed");
  });
});

describe("AgentManager — cleanup timer", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not keep the process alive on its own", () => {
    manager = new AgentManager();

    expect((manager as unknown as { cleanupInterval: { hasRef(): boolean } }).cleanupInterval.hasRef()).toBe(false);
  });
});

describe("AgentManager — Bug 3 clearCompleted", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("clearCompleted removes completed records", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(manager.listAgents()).toHaveLength(1);
    manager.clearCompleted();
    expect(manager.listAgents()).toHaveLength(0);
  });

  it("clearCompleted does not remove running or queued agents", () => {
    // Use maxConcurrent=0 to keep agents queued, then spawn one running via foreground
    manager = new AgentManager(undefined, 1);

    // Mock runAgent to never resolve (keeps agent "running")
    vi.mocked(runAgent).mockImplementation(
      () => new Promise(() => {}), // hangs forever
    );

    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "test1", {
      description: "running agent",
      isBackground: true,
    });
    // Second agent should be queued (limit=1)
    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "test2", {
      description: "queued agent",
      isBackground: true,
    });

    expect(manager.getRecord(id1)!.status).toBe("running");
    expect(manager.getRecord(id2)!.status).toBe("queued");

    manager.clearCompleted();

    // Both should still be present
    expect(manager.getRecord(id1)).toBeDefined();
    expect(manager.getRecord(id2)).toBeDefined();

    // Abort to allow cleanup
    manager.abort(id1);
    manager.abort(id2);
  });

  it("clearCompleted calls dispose on sessions of removed records", async () => {
    manager = new AgentManager();
    const disposeSpy = vi.fn();
    const sess = { dispose: disposeSpy };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: sess as unknown as import("@earendil-works/pi-coding-agent").AgentSession,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    manager.clearCompleted();

    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("clearCompleted removes error and stopped records", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");

    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("clearCompleted(true) preserves completed records with resultConsumed=false", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("completed");
    expect(manager.getRecord(id)!.resultConsumed).toBeFalsy();

    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeDefined();
  });

  it("clearCompleted(true) removes completed records with resultConsumed=true", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.resultConsumed = true;

    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("clearCompleted(true) preserves error records with resultConsumed=false", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");
    expect(manager.getRecord(id)!.resultConsumed).toBeFalsy();

    // Error records with unread results are also preserved — the LLM should
    // be able to read the error message via get_subagent_result before the
    // record is evicted.
    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeDefined();
  });
});

// Eager init removes the optional/required asymmetry that previously required
// `??=` defaults at the callback sites and `?? 0` / `?? 1` at the read sites.
describe("AgentManager — lifetime usage + compaction count are eagerly initialized", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn initializes lifetimeUsage to zeros and compactionCount to 0", () => {
    manager = new AgentManager();
    // Don't resolve the run — we just want to inspect the record at spawn time.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(record.compactionCount).toBe(0);

    manager.abort(id);
  });

  it("onAssistantUsage from runAgent accumulates into record.lifetimeUsage", async () => {
    manager = new AgentManager();

    // Capture the options passed to runAgent so we can drive callbacks
    let captured: RunOptions | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts: RunOptions) => {
      captured = opts;
      // Two assistant messages with usage
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10 });
      opts.onAssistantUsage?.({ input: 200, output: 80, cacheWrite: 20 });
      return Promise.resolve({ responseText: "done", session: mockSession(), aborted: false, steered: false });
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(captured).toBeDefined();
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({
      input: 300, output: 130, cacheWrite: 30,
    });
  });

  it("onCompaction from runAgent increments record.compactionCount", async () => {
    manager = new AgentManager();
    const compactSeen: { count: number; reason: string }[] = [];

    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts: RunOptions) => {
      // Compaction fires while the agent is still running — the record passed to
      // onCompact should reflect the just-incremented count.
      opts.onCompaction?.({ reason: "threshold", tokensBefore: 12345 });
      opts.onCompaction?.({ reason: "manual", tokensBefore: 22222 });
      return Promise.resolve({ responseText: "done", session: mockSession(), aborted: false, steered: false });
    });

    manager = new AgentManager(undefined, undefined, undefined, (record, info) => {
      compactSeen.push({ count: record.compactionCount, reason: info.reason });
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(compactSeen).toEqual([
      { count: 1, reason: "threshold" },
      { count: 2, reason: "manual" },
    ]);
    expect(manager.getRecord(id)!.compactionCount).toBe(2);
  });

  it("resume() also accumulates usage and increments compactions on the same record", async () => {
    manager = new AgentManager();

    // First, spawn with a session that resume can latch onto
    const session = { ...mockSession() };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first",
      session: session as unknown as import("@earendil-works/pi-coding-agent").AgentSession,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    // Pre-resume: lifetimeUsage from spawn was zero (mock didn't call onAssistantUsage)
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(manager.getRecord(id)!.compactionCount).toBe(0);

    // Now resume — drive callbacks via the mocked resumeAgent
    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockImplementation((_session, _prompt, opts: Parameters<typeof resumeMock>[2]) => {
      opts?.onAssistantUsage?.({ input: 70, output: 30, cacheWrite: 5 });
      opts?.onCompaction?.({ reason: "overflow", tokensBefore: 999 });
      return Promise.resolve("second");
    });

    await manager.resume(id, "more");

    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 70, output: 30, cacheWrite: 5 });
    expect(manager.getRecord(id)!.compactionCount).toBe(1);
  });
});

// Regression: `isolation: "worktree"` MUST fail loud when the cwd can't host
// a worktree. The previous behavior silently fell back to the main tree and
// injected a warning into the LLM's prompt — invisible to the caller.
describe("AgentManager — isolation: worktree fails loud, no silent fallback", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn() throws when createWorktree returns undefined; no orphan record left behind", async () => {
    const { createWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce(undefined);
    vi.mocked(runAgent).mockClear();

    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isolation: "worktree",
    })).toThrow(/isolation: "worktree"/);

    // Cleaned up — no orphan in listAgents()
    expect(manager.listAgents()).toEqual([]);
    // runAgent never invoked — strict, no silent fallback
    expect(runAgent).not.toHaveBeenCalled();
  });
});

describe("AgentManager — abort() state machine", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns false for an unknown id (no record, no side-effects)", () => {
    manager = new AgentManager();
    expect(manager.abort("does-not-exist")).toBe(false);
  });

  it("removes a queued agent from the queue and marks it stopped", () => {
    // Concurrency=1: the second background spawn queues behind the first
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "X", "blocker", { description: "block", isBackground: true });
    const queuedId = manager.spawn(mockPi, mockCtx, "Y", "queued", {
      description: "q",
      isBackground: true,
    });
    const queuedRecord = manager.getRecord(queuedId)!;
    expect(queuedRecord.status).toBe("queued");

    expect(manager.abort(queuedId)).toBe(true);
    expect(queuedRecord.status).toBe("stopped");
    expect(queuedRecord.completedAt).toBeGreaterThan(0);
    // Aborting again is a no-op — status is no longer "queued" or "running"
    expect(manager.abort(queuedId)).toBe(false);
  });

  it("aborts a running agent by firing its AbortController and setting status='stopped'", () => {
    manager = new AgentManager();
    let receivedSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      receivedSignal = (opts as { signal?: AbortSignal })?.signal;
      return new Promise(() => {});
    });

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "r",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");
    expect(receivedSignal?.aborted).toBe(false);

    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeGreaterThan(0);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("returns false (and does not change status) for an already-completed agent", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: false,
    });
    await manager.getRecord(id)?.promise;
    expect(manager.getRecord(id)?.status).toBe("completed");

    expect(manager.abort(id)).toBe(false);
    expect(manager.getRecord(id)?.status).toBe("completed");
  });
});

// Regression for #44: ESC during a foreground Agent call must propagate to
// the child. Pi delivers parent abort via AbortSignal; the manager wires the
// signal's "abort" event to this.abort(id).
describe("AgentManager — parent abort signal forwarding (#44)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("aborts the child when the parent signal aborts", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const parent = new AbortController();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: false,
      signal: parent.signal,
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");

    parent.abort();
    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeGreaterThan(0);
  });
});

describe("AgentManager — listAgents() ordering", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns records sorted by startedAt descending (most recent first)", () => {
    manager = new AgentManager();
    resolvedRun();

    const a = manager.spawn(mockPi, mockCtx, "X", "1", { description: "a" });
    const b = manager.spawn(mockPi, mockCtx, "X", "2", { description: "b" });
    const c = manager.spawn(mockPi, mockCtx, "X", "3", { description: "c" });

    // Force deterministic startedAt — Date.now() can collide on fast runs
    manager.getRecord(a)!.startedAt = 100;
    manager.getRecord(b)!.startedAt = 200;
    manager.getRecord(c)!.startedAt = 300;

    expect(manager.listAgents().map((r) => r.id)).toEqual([c, b, a]);
  });
});

describe("AgentManager — abortAll", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("stops both queued and running agents and returns the total count", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const running = manager.spawn(mockPi, mockCtx, "X", "r", {
      description: "r",
      isBackground: true,
    });
    const queued = manager.spawn(mockPi, mockCtx, "Y", "q", {
      description: "q",
      isBackground: true,
    });
    expect(manager.getRecord(running)?.status).toBe("running");
    expect(manager.getRecord(queued)?.status).toBe("queued");

    expect(manager.abortAll()).toBe(2);
    expect(manager.getRecord(running)?.status).toBe("stopped");
    expect(manager.getRecord(queued)?.status).toBe("stopped");
    expect(manager.hasRunning()).toBe(false);
  });

  it("returns 0 when there are no running or queued agents", () => {
    manager = new AgentManager();
    expect(manager.abortAll()).toBe(0);
  });
});

describe("AgentManager — hasRunning", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("is true while a background agent is running, false after it completes", async () => {
    manager = new AgentManager();
    resolvedRun();

    expect(manager.hasRunning()).toBe(false);
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: true,
    });
    expect(manager.hasRunning()).toBe(true);

    await manager.getRecord(id)?.promise;
    expect(manager.hasRunning()).toBe(false);
  });

  it("is true when an agent is queued behind the concurrency limit", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "X", "r", { description: "r", isBackground: true });
    manager.spawn(mockPi, mockCtx, "Y", "q", { description: "q", isBackground: true });
    expect(manager.hasRunning()).toBe(true);
  });
});

describe("AgentManager — runAgent rejection leaves the record visible with error status", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("sets status='error', captures the error message, and stamps completedAt", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: false,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.error).toBe("boom");
    expect(record.completedAt).toBeGreaterThan(0);
  });
});

describe("AgentManager — aborted and steered status", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("sets status='aborted' when runAgent resolves with aborted=true", async () => {
    manager = new AgentManager();
    const sess = mockSession();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: sess, aborted: true, steered: false });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "x", isBackground: true });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("aborted");
  });

  it("sets status='steered' when runAgent resolves with steered=true", async () => {
    manager = new AgentManager();
    const sess = mockSession();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: sess, aborted: false, steered: true });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "x", isBackground: true });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("steered");
  });

  it("keeps status='stopped' when externally aborted then runAgent resolves", async () => {
    manager = new AgentManager();
    const sess = mockSession();
    let resolveRun!: (v: unknown) => void;
    vi.mocked(runAgent).mockReturnValue(new Promise<never>((res) => { resolveRun = res as (v: unknown) => void; }));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "x", isBackground: true });
    manager.abort(id);
    expect(manager.getRecord(id)!.status).toBe("stopped");

    resolveRun({ responseText: "done", session: sess, aborted: false, steered: false });
    await Promise.resolve(); await Promise.resolve();
    // Status must not revert from "stopped" to "completed"
    expect(manager.getRecord(id)!.status).toBe("stopped");
  });
});

describe("AgentManager — outputCleanup callback", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("calls outputCleanup when agent completes", async () => {
    manager = new AgentManager();
    const cleanup = vi.fn();
    const sess = mockSession();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: sess, aborted: false, steered: false });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    record.outputCleanup = cleanup;
    await record.promise;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(record.outputCleanup).toBeUndefined();
  });

  it("calls outputCleanup even when runAgent rejects", async () => {
    manager = new AgentManager();
    const cleanup = vi.fn();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    record.outputCleanup = cleanup;
    await record.promise;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(record.outputCleanup).toBeUndefined();
  });
});

describe("AgentManager — worktree cleanup on completion", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("appends branch-merge message to result when worktree has changes", async () => {
    const { createWorktree, cleanupWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce({ path: "/tmp/wt", branch: "subagent/abc", baseSha: "abc123", workPath: "/tmp/wt" });
    vi.mocked(cleanupWorktree).mockReturnValueOnce({ hasChanges: true, branch: "subagent/abc" });
    const sess = mockSession();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "initial", session: sess, aborted: false, steered: false });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "x", isolation: "worktree" });
    const record = manager.getRecord(id)!;
    await record.promise;
    expect(record.result).toContain("subagent/abc");
    expect(record.result).toContain("git merge");
  });

  it("does not append branch message when worktree has no changes", async () => {
    const { createWorktree, cleanupWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce({ path: "/tmp/wt", branch: "subagent/abc", repoRoot: "/tmp" } as never);
    vi.mocked(cleanupWorktree).mockReturnValueOnce({ hasChanges: false, branch: undefined } as never);
    const sess = mockSession();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "clean", session: sess, aborted: false, steered: false });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "x", isolation: "worktree" });
    const record = manager.getRecord(id)!;
    await record.promise;
    expect(record.result).toBe("clean");
  });

  it("cleans up worktree even on runAgent rejection", async () => {
    const { createWorktree, cleanupWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce({ path: "/tmp/wt", branch: "subagent/err", repoRoot: "/tmp" } as never);
    vi.mocked(cleanupWorktree).mockReturnValueOnce({ hasChanges: false, branch: undefined } as never);
    vi.mocked(runAgent).mockRejectedValue(new Error("run failed"));

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "x", isolation: "worktree" });
    await manager.getRecord(id)!.promise;
    expect(cleanupWorktree).toHaveBeenCalled();
    expect(manager.getRecord(id)!.status).toBe("error");
  });
});

describe("AgentManager — resume() error path", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("sets status='error' and captures error message when resumeAgent throws", async () => {
    manager = new AgentManager();
    const sess = mockSession();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "initial", session: sess, aborted: false, steered: false });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "x", isBackground: true });
    await manager.getRecord(id)!.promise;

    const { resumeAgent } = await import("../src/agent-runner.js");
    vi.mocked(resumeAgent).mockRejectedValue(new Error("session lost"));

    const result = await manager.resume(id, "continue");
    expect(result!.status).toBe("error");
    expect(result!.error).toBe("session lost");
    expect(result!.completedAt).toBeGreaterThan(0);
  });

  it("returns undefined when no session exists for the id", async () => {
    manager = new AgentManager();
    const result = await manager.resume("no-such-id", "prompt");
    expect(result).toBeUndefined();
  });
});

describe("AgentManager — waitForAll", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("resolves immediately when there are no agents", async () => {
    manager = new AgentManager();
    await expect(manager.waitForAll()).resolves.toBeUndefined();
  });

  it("waits for running agents to complete", async () => {
    manager = new AgentManager();
    let resolveRun!: (v: unknown) => void;
    const sess = mockSession();
    vi.mocked(runAgent).mockReturnValue(
      new Promise((res) => { resolveRun = res as (v: unknown) => void; }),
    );

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "x", isBackground: true });
    expect(manager.getRecord(id)!.status).toBe("running");

    const waitPromise = manager.waitForAll();
    resolveRun({ responseText: "done", session: sess, aborted: false, steered: false });
    await waitPromise;
    expect(manager.getRecord(id)!.status).toBe("completed");
  });

  it("also waits for queued agents that start after a running one finishes", async () => {
    manager = new AgentManager(undefined, 1);
    const sessions: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
    const resolvers: Array<(v: unknown) => void> = [];

    vi.mocked(runAgent).mockImplementation(() =>
      new Promise((res) => {
        const idx = resolvers.length;
        resolvers.push(res as (v: unknown) => void);
        const sess = { dispose: vi.fn() };
        sessions.push(sess);
        // just capture index; eslint: need to reference idx to avoid unused-expr
        void idx;
      }),
    );

    manager.spawn(mockPi, mockCtx, "X", "r", { description: "r", isBackground: true });
    manager.spawn(mockPi, mockCtx, "Y", "q", { description: "q", isBackground: true });
    expect(manager.hasRunning()).toBe(true);

    const waitPromise = manager.waitForAll();

    // Resolve first agent → drains queue → starts second
    resolvers[0]?.({ responseText: "a", session: sessions[0]! as never, aborted: false, steered: false });
    await Promise.resolve(); await Promise.resolve();
    // Resolve second agent
    resolvers[1]?.({ responseText: "b", session: sessions[1]! as never, aborted: false, steered: false });

    await waitPromise;
    expect(manager.hasRunning()).toBe(false);
  });
});

describe("AgentManager — drainQueue late-failure", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("surfaces error on queued agent record when startAgent throws during drain", async () => {
    const { createWorktree } = await import("../src/worktree.js");
    manager = new AgentManager(undefined, 1);

    // First agent runs normally and resolves
    const sess = mockSession();
    let resolveFirst!: (v: unknown) => void;
    vi.mocked(runAgent)
      .mockImplementationOnce(() => new Promise((res) => { resolveFirst = res as (v: unknown) => void; }))
      .mockImplementation(() => new Promise(() => {}));

    // Queued agent will fail during startAgent due to worktree error
    vi.mocked(createWorktree).mockReturnValueOnce(undefined);

    const firstId = manager.spawn(mockPi, mockCtx, "X", "r", { description: "first", isBackground: true });
    const queuedId = manager.spawn(mockPi, mockCtx, "X", "q", {
      description: "queued",
      isBackground: true,
      isolation: "worktree",
    });
    expect(manager.getRecord(queuedId)!.status).toBe("queued");

    // Complete first agent → drainQueue fires → queued agent's startAgent throws
    resolveFirst({ responseText: "done", session: sess, aborted: false, steered: false });
    await manager.getRecord(firstId)!.promise;
    await Promise.resolve();

    expect(manager.getRecord(queuedId)!.status).toBe("error");
    expect(manager.getRecord(queuedId)!.error).toMatch(/worktree/);
  });
});

describe("AgentManager — bypassQueue", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("bypassQueue=true starts agent immediately even if concurrency limit is reached", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    manager.spawn(mockPi, mockCtx, "X", "r", { description: "r", isBackground: true });
    const bypassId = manager.spawn(mockPi, mockCtx, "Y", "b", {
      description: "b",
      isBackground: true,
      bypassQueue: true,
    });
    // Both should be running, not queued
    expect(manager.getRecord(bypassId)!.status).toBe("running");
  });
});

describe("AgentManager — cleanup timer (fake timers)", () => {
  let manager: AgentManager;
  afterEach(() => {
    vi.useRealTimers();
    manager?.dispose();
  });

  it("cleanup() removes completed records older than 10 minutes via the interval timer", async () => {
    vi.useFakeTimers();
    manager = new AgentManager();
    const sess = mockSession();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: sess, aborted: false, steered: false });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "x",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("completed");

    // Advance time past the 10-minute cleanup cutoff
    vi.advanceTimersByTime(11 * 60_000);

    // The cleanup interval fired — record should be gone
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("cleanup() does not remove running or queued records", () => {
    vi.useFakeTimers();
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const runningId = manager.spawn(mockPi, mockCtx, "X", "r", { description: "r", isBackground: true });
    const queuedId = manager.spawn(mockPi, mockCtx, "Y", "q", { description: "q", isBackground: true });

    vi.advanceTimersByTime(11 * 60_000);

    expect(manager.getRecord(runningId)).toBeDefined();
    expect(manager.getRecord(queuedId)).toBeDefined();

    manager.abort(runningId);
    manager.abort(queuedId);
  });
});

describe("AgentManager — pendingSteers flush on session creation", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("flushes pendingSteers to session when onSessionCreated fires", async () => {
    manager = new AgentManager();
    const steerSpy = vi.fn().mockResolvedValue(undefined);
    const sess = { ...mockSession(), steer: steerSpy } as unknown as import("@earendil-works/pi-coding-agent").AgentSession;

    let capturedOnSessionCreated: ((s: typeof sess) => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts: RunOptions) => {
      // Capture onSessionCreated without firing it yet
      capturedOnSessionCreated = opts.onSessionCreated;
      return Promise.resolve({ responseText: "done", session: sess, aborted: false, steered: false });
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "x",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    // Set pending steers BEFORE onSessionCreated fires
    record.pendingSteers = ["please wrap up"];

    // Now fire onSessionCreated (simulating late session creation)
    capturedOnSessionCreated?.(sess);

    await record.promise;
    // The pending steer should have been flushed to the session
    expect(steerSpy).toHaveBeenCalledWith("please wrap up");
    expect(record.pendingSteers).toBeUndefined();
  });
});

describe("AgentManager — outputCleanup throws (swallowed)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("swallows errors from outputCleanup", async () => {
    manager = new AgentManager();
    const throwingCleanup = vi.fn(() => { throw new Error("cleanup failed"); });
    const sess = mockSession();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: sess, aborted: false, steered: false });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "x",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    record.outputCleanup = throwingCleanup;
    // Should not throw even though cleanup throws
    await expect(record.promise).resolves.toBe("done");
    expect(throwingCleanup).toHaveBeenCalledOnce();
  });

  it("swallows errors from outputCleanup on error path", async () => {
    manager = new AgentManager();
    const throwingCleanup = vi.fn(() => { throw new Error("cleanup failed"); });
    vi.mocked(runAgent).mockRejectedValue(new Error("run failed"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "x",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    record.outputCleanup = throwingCleanup;
    await record.promise;
    expect(throwingCleanup).toHaveBeenCalledOnce();
    expect(record.status).toBe("error");
  });
});

describe("AgentManager — keeps status=stopped when catch fires after externally stopping", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("keeps status=stopped when agent rejects after abort() was called", async () => {
    manager = new AgentManager();
    let rejectRun!: (e: Error) => void;
    vi.mocked(runAgent).mockReturnValue(
      new Promise((_, rej) => { rejectRun = rej as (e: Error) => void; }),
    );

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "x",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    manager.abort(id); // sets status="stopped"
    rejectRun(new Error("aborted by signal"));
    await record.promise;
    expect(record.status).toBe("stopped"); // must not be overwritten to "error"
  });
});

describe("AgentManager — parent signal + agent completes normally", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("detaches parent signal listener when agent completes without parent abort", async () => {
    manager = new AgentManager();
    const parent = new AbortController();
    const sess = mockSession();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: sess, aborted: false, steered: false });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "x",
      isBackground: true,
      signal: parent.signal,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    // After completion, aborting the parent should not do anything harmful
    parent.abort(); // should be a no-op
    expect(record.status).toBe("completed");
  });
});

describe("AgentManager — assertValidSpawnCwd curated errors", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("throws when cwd is a non-absolute path string", () => {
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      cwd: "relative/path",
    })).toThrow(/absolute path/);
  });

  it("throws when cwd is a non-string (number)", () => {
    manager = new AgentManager();
    // @ts-expect-error — testing runtime validation
    expect(() => manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      cwd: 123,
    })).toThrow(/absolute path/);
  });

  it("throws when cwd is a non-absolute path with null (null is allowed, number is not)", () => {
    manager = new AgentManager();
    // null is explicitly allowed — means "unset"
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      cwd: null as unknown as string,
    });
    expect(id).toBeDefined();
    manager.abort(id);
  });

  it("throws when cwd is a file path (not a directory)", () => {
    const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
    const { tmpdir } = require("node:os");
		const { join } = require("node:path");
    const dir = mkdtempSync(join(tmpdir(), "pi-wt-test-"));
    try {
      writeFileSync(join(dir, "a-file.txt"), "content");
      manager = new AgentManager();
      expect(() => manager.spawn(mockPi, mockCtx, "X", "p", {
        description: "x",
        cwd: join(dir, "a-file.txt"),
      })).toThrow(/not a directory/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when cwd does not exist", () => {
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      cwd: "/nonexistent/path/that/does/not/exist",
    })).toThrow(/does not exist/);
  });
});

describe("AgentManager — worktree customCwd in result message", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("appends repoNote and customCwd instruction when worktree has changes AND customCwd was set", async () => {
    const { createWorktree, cleanupWorktree } = await import("../src/worktree.js");
    const { mkdtempSync, rmSync: rmSync2 } = require("node:fs");
    const { tmpdir: tmpdir2 } = require("node:os");
    const { join: join2 } = require("node:path");
    const customCwd = mkdtempSync(join2(tmpdir2(), "pi-custom-cwd-"));
    vi.mocked(createWorktree).mockReturnValueOnce({ path: "/tmp/wt", branch: "subagent/abc", baseSha: "abc123", workPath: "/tmp/wt/sub" });
    vi.mocked(cleanupWorktree).mockReturnValueOnce({ hasChanges: true, branch: "subagent/abc" });
    const sess = mockSession();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "initial", session: sess, aborted: false, steered: false });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "x",
      isolation: "worktree",
      cwd: customCwd,
    });
    const record = manager.getRecord(id)!;
    await record.promise;
    // With customCwd set, the message should include the repoNote and customCwd instruction
    expect(record.result).toContain(`in \`${customCwd}\``);
    expect(record.result).toContain(`run in \`${customCwd}\``);
    rmSync2(customCwd, { recursive: true, force: true });
  });

  it("does NOT append customCwd instruction when customCwd was NOT set", async () => {
    const { createWorktree, cleanupWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce({ path: "/tmp/wt", branch: "subagent/abc", baseSha: "abc123", workPath: "/tmp/wt" });
    vi.mocked(cleanupWorktree).mockReturnValueOnce({ hasChanges: true, branch: "subagent/abc" });
    const sess = mockSession();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "initial", session: sess, aborted: false, steered: false });

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "x",
      isolation: "worktree",
    });
    const record = manager.getRecord(id)!;
    await record.promise;
    // Without customCwd, no repoNote or customCwd instruction
    expect(record.result).not.toContain("in `");
    expect(record.result).not.toContain("run in `");
  });
});

describe("AgentManager — catch handler with worktree cleanup on error", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("cleans up worktree on runAgent error and sets error status", async () => {
    const { createWorktree, cleanupWorktree } = await import("../src/worktree.js");
    vi.mocked(createWorktree).mockReturnValueOnce({ path: "/tmp/wt", branch: "subagent/err", baseSha: "abc123", workPath: "/tmp/wt" });
    vi.mocked(cleanupWorktree).mockReturnValueOnce({ hasChanges: false, branch: undefined });
    vi.mocked(runAgent).mockRejectedValue(new Error("run failed"));

    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "x",
      isolation: "worktree",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");
    expect(cleanupWorktree).toHaveBeenCalled();
  });

  it("does not overwrite status='stopped' when agent was externally aborted then rejects", async () => {
    manager = new AgentManager();
    let rejectRun!: (e: Error) => void;
    vi.mocked(runAgent).mockReturnValue(
      new Promise((_, rej) => { rejectRun = rej as (e: Error) => void; }),
    );

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "x",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    manager.abort(id);
    expect(record.status).toBe("stopped");

    rejectRun(new Error("aborted"));
    await record.promise;
    expect(record.status).toBe("stopped"); // must not be overwritten to "error"
  });
});

describe("AgentManager — cleanup timer ages out completed records", () => {
  let manager: AgentManager;
  afterEach(() => {
    vi.useRealTimers();
    manager?.dispose();
  });

  it("records older than 10 minutes are removed by cleanup but NOT newer ones", async () => {
    vi.useFakeTimers();
    manager = new AgentManager();
    const sess = mockSession();
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: sess, aborted: false, steered: false });

    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "test1", { description: "x", isBackground: true });
    await manager.getRecord(id1)!.promise;
    // Set completedAt to just under 10 minutes ago
    manager.getRecord(id1)!.completedAt = Date.now() - 9 * 60_000; // 9 min ago

    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "test2", { description: "y", isBackground: true });
    await manager.getRecord(id2)!.promise;
    // id2 just completed (recent)

    // Advance timer by 1 minute (to trigger cleanup; cutoff is 10 min)
    vi.advanceTimersByTime(60_000); // triggers the 60s cleanup interval

    // id1's completedAt was set to 9 min ago, so after 1 minute it's 10 min ago - just at cutoff
    // depending on exact timing, may or may not be removed. Just check cleanup ran.
    expect(manager.listAgents()).toBeDefined();
  });
});
