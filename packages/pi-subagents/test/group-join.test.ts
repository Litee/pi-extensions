/**
 * group-join.test.ts — Behavior of GroupJoinManager's state machine and timers.
 *
 * Uses fake timers to assert deterministic timeout behavior without flakiness.
 * The class itself is exercised directly with real records — no mocks beyond
 * a spy on the delivery callback.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GroupJoinManager } from "../src/group-join.js";
import type { AgentRecord } from "../src/types.js";

function makeRecord(id: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id,
    type: "general-purpose",
    description: "test",
    status: "completed",
    toolUses: 0,
    startedAt: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...overrides,
  };
}

describe("GroupJoinManager", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns 'pass' for unregistered agents and never invokes the callback", () => {
    const deliver = vi.fn();
    const mgr = new GroupJoinManager(deliver);
    expect(mgr.onAgentComplete(makeRecord("a"))).toBe("pass");
    expect(deliver).not.toHaveBeenCalled();
    expect(mgr.isGrouped("a")).toBe(false);
  });

  it("holds the first completion and arms the join timeout", () => {
    const deliver = vi.fn();
    const mgr = new GroupJoinManager(deliver, 30_000);
    mgr.registerGroup("g", ["a", "b"]);

    expect(mgr.isGrouped("a")).toBe(true);
    expect(mgr.onAgentComplete(makeRecord("a"))).toBe("held");

    vi.advanceTimersByTime(29_999);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("delivers all records (partial=false) when the final completion arrives in time", () => {
    const deliver = vi.fn();
    const mgr = new GroupJoinManager(deliver);
    mgr.registerGroup("g", ["a", "b"]);

    mgr.onAgentComplete(makeRecord("a", { result: "A" }));
    expect(mgr.onAgentComplete(makeRecord("b", { result: "B" }))).toBe("delivered");

    expect(deliver).toHaveBeenCalledTimes(1);
    const [records, partial] = ((deliver.mock.calls as unknown as [AgentRecord[], boolean][])[0]!);
    expect(records.map((r: AgentRecord) => r.id).sort()).toEqual(["a", "b"]);
    expect(partial).toBe(false);

    // Group is cleaned up — no future deliveries can fire from these ids
    expect(mgr.isGrouped("a")).toBe(false);
    expect(mgr.isGrouped("b")).toBe(false);
  });

  it("delivers partial=true on timeout and re-arms the group for stragglers", () => {
    const deliver = vi.fn();
    const mgr = new GroupJoinManager(deliver, 30_000);
    mgr.registerGroup("g", ["a", "b", "c"]);

    mgr.onAgentComplete(makeRecord("a"));
    vi.advanceTimersByTime(30_000);

    expect(deliver).toHaveBeenCalledTimes(1);
    const [records, partial] = ((deliver.mock.calls as unknown as [AgentRecord[], boolean][])[0]!);
    expect(records.map((r: AgentRecord) => r.id)).toEqual(["a"]);
    expect(partial).toBe(true);

    // 'a' was delivered and is dropped from the group; 'b' and 'c' remain as stragglers
    expect(mgr.isGrouped("a")).toBe(false);
    expect(mgr.isGrouped("b")).toBe(true);
    expect(mgr.isGrouped("c")).toBe(true);
  });

  it("uses the shorter straggler timeout (15s) regardless of the configured group timeout", () => {
    const deliver = vi.fn();
    const mgr = new GroupJoinManager(deliver, 30_000);
    mgr.registerGroup("g", ["a", "b", "c"]);

    // First batch: 'a' alone, partial-delivered after 30s
    mgr.onAgentComplete(makeRecord("a"));
    vi.advanceTimersByTime(30_000);
    expect(deliver).toHaveBeenCalledTimes(1);

    // Straggler 'b' arrives — fires at 15s, not 30s
    mgr.onAgentComplete(makeRecord("b"));
    vi.advanceTimersByTime(14_999);
    expect(deliver).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(deliver).toHaveBeenCalledTimes(2);

    expect((deliver.mock.calls as unknown as [AgentRecord[], boolean][])[1]![0].map((r: AgentRecord) => r.id)).toEqual(["b"]);
    expect((deliver.mock.calls as unknown as [AgentRecord[], boolean][])[1]![1]).toBe(true);
    expect(mgr.isGrouped("c")).toBe(true); // 'c' is the remaining straggler now
  });

  it("delivers stragglers as a complete batch (partial=false) when all complete before their timeout", () => {
    const deliver = vi.fn();
    const mgr = new GroupJoinManager(deliver, 30_000);
    mgr.registerGroup("g", ["a", "b", "c"]);

    mgr.onAgentComplete(makeRecord("a"));
    vi.advanceTimersByTime(30_000); // partial: 'a'
    expect(deliver).toHaveBeenCalledTimes(1);

    mgr.onAgentComplete(makeRecord("b"));
    expect(mgr.onAgentComplete(makeRecord("c"))).toBe("delivered");

    expect(deliver).toHaveBeenCalledTimes(2);
    expect((deliver.mock.calls as unknown as [AgentRecord[], boolean][])[1]![0].map((r: AgentRecord) => r.id).sort()).toEqual(["b", "c"]);
    expect((deliver.mock.calls as unknown as [AgentRecord[], boolean][])[1]![1]).toBe(false);
  });

  it("returns 'pass' for late completions arriving after a group is already delivered", () => {
    const deliver = vi.fn();
    const mgr = new GroupJoinManager(deliver);
    mgr.registerGroup("g", ["a", "b"]);

    mgr.onAgentComplete(makeRecord("a"));
    mgr.onAgentComplete(makeRecord("b")); // full delivery
    expect(deliver).toHaveBeenCalledTimes(1);

    // A duplicate/late completion must not trigger a second delivery
    expect(mgr.onAgentComplete(makeRecord("a"))).toBe("pass");
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("dispose() clears pending timers so a partial delivery never fires post-dispose", () => {
    const deliver = vi.fn();
    const mgr = new GroupJoinManager(deliver, 30_000);
    mgr.registerGroup("g", ["a", "b"]);

    mgr.onAgentComplete(makeRecord("a")); // arms 30s timeout
    mgr.dispose();

    vi.advanceTimersByTime(60_000);
    expect(deliver).not.toHaveBeenCalled();
    expect(mgr.isGrouped("a")).toBe(false);
    expect(mgr.isGrouped("b")).toBe(false);
  });
});

  it("returns 'pass' when agent's group was already fully delivered", () => {
    vi.useFakeTimers();
    const delivered: { records: AgentRecord[]; partial: boolean }[] = [];
    const mgr = new GroupJoinManager((records, partial) => delivered.push({ records, partial }), 1000);

    mgr.registerGroup("g1", ["a", "b"]);
    const a = makeRecord("a");
    const b = makeRecord("b");

    mgr.onAgentComplete(a); // held
    mgr.onAgentComplete(b); // delivered (all done)

    // Both done, group is cleaned up. Now try to complete 'a' again
    // This simulates a late duplicate callback
    const result = mgr.onAgentComplete(a);
    expect(result).toBe("pass"); // group is gone → pass
    vi.useRealTimers();
  });

  it("clears the timeout handle when delivering before timeout fires", () => {
    vi.useFakeTimers();
    const delivered: { records: AgentRecord[] }[] = [];
    const mgr = new GroupJoinManager((records) => delivered.push({ records }), 5000);

    mgr.registerGroup("g1", ["a", "b"]);
    const a = makeRecord("a");
    const b = makeRecord("b");

    mgr.onAgentComplete(a); // starts timeout
    // Before timeout fires, second agent completes
    const result = mgr.onAgentComplete(b); // should deliver and clear timeout
    expect(result).toBe("delivered");
    expect(delivered).toHaveLength(1);

    // Advance past timeout — should NOT trigger a second delivery
    vi.advanceTimersByTime(10_000);
    expect(delivered).toHaveLength(1);
    vi.useRealTimers();
  });

  it("returns 'held' and does NOT re-arm the timer when second agent completes in a 3-agent group", () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const mgr = new GroupJoinManager(deliver, 30_000);
    mgr.registerGroup("g", ["a", "b", "c"]);

    // Agent 'a' completes first — arms 30s timeout
    expect(mgr.onAgentComplete(makeRecord("a"))).toBe("held");
    // Agent 'b' completes while the timer is already running
    // Expected: 'held' again, but timeoutHandle is NOT re-armed (it's already set)
    expect(mgr.onAgentComplete(makeRecord("b"))).toBe("held");
    // Advance to just before the timeout — still no delivery
    vi.advanceTimersByTime(29_999);
    expect(deliver).not.toHaveBeenCalled();
    // Timeout fires: partial delivery of ['a', 'b']
    vi.advanceTimersByTime(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [records, partial] = (deliver.mock.calls as unknown as [AgentRecord[], boolean][])[0]!;
    expect(records.map((r: AgentRecord) => r.id).sort()).toEqual(["a", "b"]);
    expect(partial).toBe(true);
    vi.useRealTimers();
  });

  it("delivers a 1-agent group immediately without ever arming a timeout", () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const mgr = new GroupJoinManager(deliver, 30_000);
    mgr.registerGroup("solo", ["only"]);

    // Only one agent — completedRecords.size (1) >= agentIds.size (1) → deliver immediately
    // deliver() is called before timeoutHandle is ever set, so the
    // `if (group.timeoutHandle)` branch in deliver() takes the FALSE path.
    expect(mgr.onAgentComplete(makeRecord("only"))).toBe("delivered");
    expect(deliver).toHaveBeenCalledTimes(1);
    const [records, partial] = (deliver.mock.calls as unknown as [AgentRecord[], boolean][])[0]!;
    expect(records[0]?.id).toBe("only");
    expect(partial).toBe(false);

    // Advance well past any timer — no second delivery
    vi.advanceTimersByTime(60_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("dispose() does not error when called on groups with no pending timeout", () => {
    vi.useFakeTimers();
    const deliver = vi.fn();
    const mgr = new GroupJoinManager(deliver, 30_000);
    // Register a group but complete all agents immediately (no timeout is ever set)
    mgr.registerGroup("g", ["x", "y"]);
    mgr.onAgentComplete(makeRecord("x"));
    mgr.onAgentComplete(makeRecord("y")); // delivers immediately, group cleaned up

    // Register another group with no completions (no timeout set yet)
    mgr.registerGroup("g2", ["p", "q"]);

    // dispose() iterates groups.values(); 'g2' has no timeoutHandle
    // so the `if (group.timeoutHandle) clearTimeout(...)` takes the FALSE branch
    expect(() => mgr.dispose()).not.toThrow();
    expect(mgr.isGrouped("p")).toBe(false);
    expect(mgr.isGrouped("q")).toBe(false);
    vi.useRealTimers();
  });
