/**
 * schedule.test.ts — SubagentScheduler engine.
 *
 * Tests:
 *   - Static format parsers (cron / relative / interval / detection)
 *   - Job lifecycle (add / update / remove / cleanup)
 *   - Fire path (interval, one-shot) with mocked AgentManager + fake timers
 *   - Past-timestamp rejection
 *   - One-shot auto-disable
 *   - Concurrency-bypass option flows through to manager.spawn
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../src/agent-manager.js";
import { SubagentScheduler } from "../src/schedule.js";
import { ScheduleStore } from "../src/schedule-store.js";

function makeMockManager() {
  const spawnFn = vi.fn(() => "agent-" + Math.random().toString(36).slice(2, 10));
  return {
    spawn: spawnFn,
    getRecord: vi.fn(() => ({ promise: Promise.resolve("done") })),
  } as unknown as AgentManager;
}

function makeMockPi() {
  return {
    events: { emit: vi.fn() },
  } as unknown as ExtensionAPI;
}

function makeMockCtx() {
  return {
    cwd: "/tmp",
    modelRegistry: { find: vi.fn(), getAll: () => [], getAvailable: () => [] },
    sessionManager: { getSessionId: () => "sess-1" },
  } as unknown as ExtensionContext;
}

describe("SubagentScheduler — static format parsers", () => {
  it("parseRelativeTime accepts +Ns/Nm/Nh/Nd and rejects bare numbers", () => {
    const before = Date.now();
    const iso = SubagentScheduler.parseRelativeTime("+10s");
    expect(iso).not.toBeNull();
    const t = new Date(iso!).getTime();
    expect(t - before).toBeGreaterThanOrEqual(9_000);
    expect(t - before).toBeLessThanOrEqual(11_000);

    expect(SubagentScheduler.parseRelativeTime("+5m")).not.toBeNull();
    expect(SubagentScheduler.parseRelativeTime("+1h")).not.toBeNull();
    expect(SubagentScheduler.parseRelativeTime("+2d")).not.toBeNull();

    // Bare digits / wrong unit / no plus → null
    expect(SubagentScheduler.parseRelativeTime("10s")).toBeNull();
    expect(SubagentScheduler.parseRelativeTime("+5x")).toBeNull();
    expect(SubagentScheduler.parseRelativeTime("hello")).toBeNull();
  });

  it("parseInterval converts unit-suffixed strings to milliseconds", () => {
    expect(SubagentScheduler.parseInterval("10s")).toBe(10_000);
    expect(SubagentScheduler.parseInterval("5m")).toBe(300_000);
    expect(SubagentScheduler.parseInterval("1h")).toBe(3_600_000);
    expect(SubagentScheduler.parseInterval("2d")).toBe(172_800_000);

    expect(SubagentScheduler.parseInterval("+5m")).toBeNull();   // relative isn't an interval
    expect(SubagentScheduler.parseInterval("5x")).toBeNull();
    expect(SubagentScheduler.parseInterval("five-minutes")).toBeNull();
  });

  it("validateCronExpression rejects non-6-field expressions", () => {
    expect(SubagentScheduler.validateCronExpression("* * * * *").valid).toBe(false);  // 5 fields
    expect(SubagentScheduler.validateCronExpression("0 0 9 * * 1").valid).toBe(true);
    expect(SubagentScheduler.validateCronExpression("0 0 9 * * *").valid).toBe(true);
    expect(SubagentScheduler.validateCronExpression("not-a-cron").valid).toBe(false);
  });

  it("detectSchedule tags type and normalizes input", () => {
    expect(SubagentScheduler.detectSchedule("+10m").type).toBe("once");
    expect(SubagentScheduler.detectSchedule("5m").type).toBe("interval");
    expect(SubagentScheduler.detectSchedule("5m").intervalMs).toBe(300_000);
    expect(SubagentScheduler.detectSchedule("0 0 9 * * 1").type).toBe("cron");

    const iso = "2099-01-01T00:00:00.000Z";
    const r = SubagentScheduler.detectSchedule(iso);
    expect(r.type).toBe("once");
    expect(r.normalized).toBe(iso);

    expect(() => SubagentScheduler.detectSchedule("garbage")).toThrow(/Invalid schedule/);
  });
});

describe("SubagentScheduler — lifecycle", () => {
  let tmp: string;
  let store: ScheduleStore;
  let scheduler: SubagentScheduler;
  let manager: AgentManager;
  let pi: ExtensionAPI;
  let emitSpy: ReturnType<typeof vi.fn>;
  let ctx: ExtensionContext;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "scheduler-test-"));
    store = new ScheduleStore(join(tmp, "s.json"));
    scheduler = new SubagentScheduler();
    manager = makeMockManager();
    pi = makeMockPi();
    emitSpy = (pi as unknown as { events: { emit: ReturnType<typeof vi.fn> } }).events.emit;
    ctx = makeMockCtx();
    scheduler.start(pi, ctx, manager, store);
  });

  afterEach(() => {
    scheduler.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("isActive() reports start/stop state", () => {
    expect(scheduler.isActive()).toBe(true);
    scheduler.stop();
    expect(scheduler.isActive()).toBe(false);
  });

  it("addJob persists, arms, and emits added event", () => {
    const job = scheduler.addJob({
      name: "j1",
      description: "test",
      schedule: "1h",
      subagent_type: "general-purpose",
      prompt: "hi",
    });
    expect(job.scheduleType).toBe("interval");
    expect(scheduler.list()).toHaveLength(1);
    expect(emitSpy).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({ type: "added" }));
  });

  it("addJob rejects duplicate names", () => {
    scheduler.addJob({ name: "j1", description: "x", schedule: "1h", subagent_type: "general-purpose", prompt: "p" });
    expect(() => scheduler.addJob({
      name: "j1", description: "y", schedule: "2h", subagent_type: "general-purpose", prompt: "p2",
    })).toThrow(/already exists/);
  });

  it("removeJob clears the job and emits removed", () => {
    const job = scheduler.addJob({ name: "j1", description: "x", schedule: "1h", subagent_type: "general-purpose", prompt: "p" });
    expect(scheduler.removeJob(job.id)).toBe(true);
    expect(scheduler.list()).toEqual([]);
    expect(emitSpy).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({ type: "removed", jobId: job.id }));
  });

  it("updateJob({enabled: false}) unschedules but keeps the record", () => {
    const job = scheduler.addJob({ name: "j1", description: "x", schedule: "1h", subagent_type: "general-purpose", prompt: "p" });
    scheduler.updateJob(job.id, { enabled: false });
    expect(scheduler.list()[0]!.enabled).toBe(false);
    expect(scheduler.getNextRun(job.id)).toBeUndefined();
  });

  // Regression: getNextRun on a freshly-created interval used to return undefined
  // (the lastRun-based branch needs lastRun, which is undefined before first fire),
  // surfacing as "Next run: (unknown)" in the agent's create-response.
  it("getNextRun returns an approximate future time for a fresh interval (no lastRun yet)", () => {
    const before = Date.now();
    const job = scheduler.addJob({
      name: "fresh-interval", description: "x", schedule: "1h",
      subagent_type: "general-purpose", prompt: "p",
    });
    const next = scheduler.getNextRun(job.id);
    expect(next).toBeDefined();
    const t = new Date(next!).getTime();
    // Should be ~now + 1h, with a small tolerance for the time spent in the call
    expect(t - before).toBeGreaterThanOrEqual(3_600_000 - 1_000);
    expect(t - before).toBeLessThanOrEqual(3_600_000 + 1_000);
  });

  // Once a fire happens and `lastRun` is set, getNextRun should pivot to it.
  it("getNextRun uses lastRun when present for interval jobs", () => {
    const job = scheduler.addJob({
      name: "ran-once", description: "x", schedule: "1h",
      subagent_type: "general-purpose", prompt: "p",
    });
    const lastRun = new Date(Date.now() - 30 * 60_000).toISOString(); // 30m ago
    scheduler.updateJob(job.id, { lastRun });
    const next = scheduler.getNextRun(job.id);
    expect(next).toBe(new Date(new Date(lastRun).getTime() + 3_600_000).toISOString());
  });

  it("rejects past one-shot timestamps upfront — no record created", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(() => scheduler.addJob({
      name: "past", description: "x", schedule: past, subagent_type: "general-purpose", prompt: "p",
    })).toThrow(/in the past/);
    // No dead-on-arrival record left behind
    expect(scheduler.list()).toEqual([]);
  });

  // The safety net in scheduleJob's past-branch only fires on store reload —
  // a once-job persisted with a future ISO whose time has now passed (process
  // restart after the trigger window). detectSchedule rejects past timestamps
  // at create time, so this is the only remaining production path.
  it("disables a previously-enabled one-shot reloaded from disk past its time", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    // Direct store insert bypasses addJob's upfront validation, mimicking a
    // record that was valid when written but is now stale on reload.
    store.add({
      id: "reload-test",
      name: "reload",
      description: "reload",
      schedule: past,
      scheduleType: "once",
      subagent_type: "general-purpose",
      prompt: "x",
      enabled: true,
      createdAt: past,
      runCount: 0,
    });
    // Re-arm: stop drops timers, start re-reads store.list() and calls scheduleJob
    // for every enabled job → the past-branch fires for our seeded record.
    scheduler.stop();
    scheduler.start(pi, ctx, manager, store);

    const reloaded = scheduler.list().find(j => j.id === "reload-test");
    expect(reloaded?.enabled).toBe(false);
    expect(reloaded?.lastStatus).toBe("error");
    expect(emitSpy).toHaveBeenCalledWith("subagents:scheduled",
      expect.objectContaining({
        type: "error", jobId: "reload-test",
        error: expect.stringMatching(/in the past/) as unknown,
      }),
    );
  });
});

describe("SubagentScheduler — fire path", () => {
  let tmp: string;
  let store: ScheduleStore;
  let scheduler: SubagentScheduler;
  let manager: AgentManager;
  let spawnSpy: ReturnType<typeof vi.fn>;
  let getRecordSpy: ReturnType<typeof vi.fn>;
  let pi: ExtensionAPI;
  let emitSpy: ReturnType<typeof vi.fn>;
  let ctx: ExtensionContext;

  beforeEach(() => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), "scheduler-fire-"));
    store = new ScheduleStore(join(tmp, "s.json"));
    scheduler = new SubagentScheduler();
    manager = makeMockManager();
    spawnSpy = (manager as unknown as { spawn: ReturnType<typeof vi.fn> }).spawn;
    getRecordSpy = (manager as unknown as { getRecord: ReturnType<typeof vi.fn> }).getRecord;
    pi = makeMockPi();
    emitSpy = (pi as unknown as { events: { emit: ReturnType<typeof vi.fn> } }).events.emit;
    ctx = makeMockCtx();
    scheduler.start(pi, ctx, manager, store);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("interval jobs fire repeatedly via setInterval", () => {
    scheduler.addJob({
      name: "every-10s", description: "tick", schedule: "10s",
      subagent_type: "general-purpose", prompt: "tick",
    });

    expect(spawnSpy).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(10_000);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(20_000);
    expect(spawnSpy).toHaveBeenCalledTimes(3);
  });

  it("one-shot fires once and auto-disables", () => {
    const job = scheduler.addJob({
      name: "soon", description: "once", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "once",
    });

    vi.advanceTimersByTime(2_000);
    expect(spawnSpy).toHaveBeenCalledTimes(1);

    // The auto-disable update happens synchronously inside the timer callback
    expect(scheduler.list().find(j => j.id === job.id)?.enabled).toBe(false);

    // Subsequent ticks shouldn't fire again
    vi.advanceTimersByTime(60_000);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it("fire passes bypassQueue: true to manager.spawn", () => {
    scheduler.addJob({
      name: "every-1s", description: "x", schedule: "1s",
      subagent_type: "general-purpose", prompt: "x",
    });

    vi.advanceTimersByTime(1_000);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const optsArg = (spawnSpy.mock.calls as unknown[][])[0]![4] as { bypassQueue: boolean; isBackground: boolean };
    expect(optsArg.bypassQueue).toBe(true);
    expect(optsArg.isBackground).toBe(true);
  });

  it("disabled jobs do not fire", () => {
    const job = scheduler.addJob({
      name: "off", description: "x", schedule: "1s",
      subagent_type: "general-purpose", prompt: "x",
    });
    scheduler.updateJob(job.id, { enabled: false });
    vi.advanceTimersByTime(5_000);
    expect(spawnSpy).toHaveBeenCalledTimes(0);
  });

  it("emits fired event with agentId on successful spawn", () => {
    scheduler.addJob({
      name: "fire-once", description: "x", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "x",
    });
    vi.advanceTimersByTime(2_000);
    expect(emitSpy).toHaveBeenCalledWith("subagents:scheduled",
      expect.objectContaining({
        type: "fired", name: "fire-once",
        agentId: expect.stringMatching(/^agent-/) as unknown,
      }),
    );
  });

  it("records lastStatus error and emits when manager.spawn throws", () => {
    spawnSpy.mockImplementationOnce(() => { throw new Error("no slots"); });
    const job = scheduler.addJob({
      name: "boom", description: "x", schedule: "+1s",
      subagent_type: "general-purpose", prompt: "x",
    });
    vi.advanceTimersByTime(2_000);

    // Update is synchronous in the spawn-throw path
    expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
    expect(emitSpy).toHaveBeenCalledWith("subagents:scheduled", expect.objectContaining({
      type: "error", jobId: job.id, error: "no slots",
    }));
  });

  // ── Status reflection from record.status (regression for bug #1) ────
  // The real AgentManager's promise *always* resolves (its .catch returns ""),
  // so the schedule's success/error must be inferred from `record.status`,
  // not from promise resolution. These two tests model that contract.
  describe("infers success vs error from record.status, not promise resolution", () => {
    type FakeRecord = { status: string; promise: Promise<string>; resolve: () => void };

    function installFaithfulMock(): Map<string, FakeRecord> {
      const records = new Map<string, FakeRecord>();
      spawnSpy.mockImplementation(() => {
        const id = "agent-" + Math.random().toString(36).slice(2, 10);
        let resolve!: () => void;
        const promise = new Promise<string>(r => { resolve = () => r(""); });
        records.set(id, { status: "running", promise, resolve });
        return id;
      });
      getRecordSpy.mockImplementation((id: string) => records.get(id));
      return records;
    }

    it("records lastStatus 'error' when the agent terminates with status='error'", async () => {
      const records = installFaithfulMock();
      const job = scheduler.addJob({
        name: "fail-job", description: "x", schedule: "+1s",
        subagent_type: "general-purpose", prompt: "x",
      });

      vi.advanceTimersByTime(2_000);
      expect(spawnSpy).toHaveBeenCalledTimes(1);

      // The agent ran and ended in error — same shape the real AgentManager produces.
      const r = [...records.values()][0]!;
      r.status = "error";
      r.resolve();

      // Flush microtasks so .then(finalize) runs.
      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("error");
    });

    it("records lastStatus 'success' when the agent terminates with status='completed'", async () => {
      const records = installFaithfulMock();
      const job = scheduler.addJob({
        name: "ok-job", description: "x", schedule: "+1s",
        subagent_type: "general-purpose", prompt: "x",
      });

      vi.advanceTimersByTime(2_000);
      const r = [...records.values()][0]!;
      r.status = "completed";
      r.resolve();

      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("success");
    });

    it("treats aborted and stopped as errors (terminal failure states)", async () => {
      const records = installFaithfulMock();
      const a = scheduler.addJob({
        name: "abort-job", description: "x", schedule: "+1s",
        subagent_type: "general-purpose", prompt: "x",
      });
      const b = scheduler.addJob({
        name: "stop-job", description: "x", schedule: "+2s",
        subagent_type: "general-purpose", prompt: "x",
      });

      vi.advanceTimersByTime(3_000);
      const recs = [...records.values()];
      recs[0]!.status = "aborted";
      recs[0]!.resolve();
      recs[1]!.status = "stopped";
      recs[1]!.resolve();

      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.list().find(j => j.id === a.id)?.lastStatus).toBe("error");
      expect(scheduler.list().find(j => j.id === b.id)?.lastStatus).toBe("error");
    });
  });

  it("finalize calls success when getRecord returns undefined (else branch — no promise)", () => {
    // getRecord returns undefined → record?.promise short-circuits → else branch fires finalize("success")
    getRecordSpy.mockReturnValue(undefined);
    const job = scheduler.addJob({
      name: "no-record-undefined",
      description: "x",
      schedule: "+1s",
      subagent_type: "general-purpose",
      prompt: "p",
    });
    vi.advanceTimersByTime(2_000);
    // finalize("success") is synchronous here
    expect(scheduler.list().find(j => j.id === job.id)?.lastStatus).toBe("success");
  });
});

describe("SubagentScheduler — stopped state", () => {
  it("throws on mutation when not started", () => {
    const scheduler = new SubagentScheduler();
    expect(() => scheduler.addJob({
      name: "x", description: "x", schedule: "1h", subagent_type: "general-purpose", prompt: "p",
    })).toThrow(/not started/);
  });

  it("list() returns empty array when not started", () => {
    const scheduler = new SubagentScheduler();
    expect(scheduler.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Additional branch coverage
// ---------------------------------------------------------------------------

describe("SubagentScheduler — removeJob and updateJob edge cases", () => {
  let tmp: string;
  let store: ScheduleStore;
  let scheduler: SubagentScheduler;
  let manager: AgentManager;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "schedule-branches-"));
    store = new ScheduleStore(join(tmp, "s.json"));
    scheduler = new SubagentScheduler();
    manager = makeMockManager();
    scheduler.start(makeMockPi(), makeMockCtx(), manager, store);
  });

  afterEach(() => {
    scheduler.stop();
    vi.restoreAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("removeJob unschedules a cron job (covers the if-cron branch in unscheduleJob)", () => {
    const job = scheduler.addJob({
      name: "cron-to-remove",
      description: "x",
      schedule: "0 0 9 * * 1",
      subagent_type: "general-purpose",
      prompt: "p",
    });
    expect(job.scheduleType).toBe("cron");
    expect(scheduler.removeJob(job.id)).toBe(true);
    expect(scheduler.list()).toHaveLength(0);
  });

  it("removeJob returns false when the id does not exist", () => {
    expect(scheduler.removeJob("no-such-id")).toBe(false);
  });

  it("updateJob returns undefined when the id does not exist", () => {
    expect(scheduler.updateJob("no-such-id", { enabled: false })).toBeUndefined();
  });

  it("addJob with cron expression creates a cron job", () => {
    const job = scheduler.addJob({
      name: "cron-job",
      description: "x",
      schedule: "0 0 9 * * 1", // every Monday 9am (6-field cron)
      subagent_type: "general-purpose",
      prompt: "p",
    });
    expect(job.scheduleType).toBe("cron");
  });

  it("getNextRun returns schedule for a 'once' job that has no cron", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const job = scheduler.addJob({
      name: "once-job",
      description: "x",
      schedule: future,
      subagent_type: "general-purpose",
      prompt: "p",
    });
    const next = scheduler.getNextRun(job.id);
    expect(next).toBe(future);
  });

  it("getNextRun returns undefined for a disabled job", () => {
    const job = scheduler.addJob({
      name: "disabled-job",
      description: "x",
      schedule: "1h",
      subagent_type: "general-purpose",
      prompt: "p",
    });
    scheduler.updateJob(job.id, { enabled: false });
    // No cron or interval for this job anymore (disabled)
    // getNextRun returns undefined for disabled jobs
    expect(scheduler.getNextRun(job.id)).toBeUndefined();
  });
});

describe("SubagentScheduler — executeJob model and spawn-catch coverage", () => {
  let tmp: string;
  let store: ScheduleStore;
  let scheduler: SubagentScheduler;
  let manager: AgentManager;
  let pi: ExtensionAPI;

  beforeEach(() => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), "schedule-exec-"));
    store = new ScheduleStore(join(tmp, "s.json"));
    scheduler = new SubagentScheduler();
    manager = makeMockManager();
    pi = makeMockPi();
    scheduler.start(pi, makeMockCtx(), manager, store);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("spawn error marks lastStatus=error and emits error event", async () => {
    const emitSpy = (pi as unknown as { events: { emit: ReturnType<typeof vi.fn> } }).events.emit;
    const spawnSpy = vi.spyOn(manager as unknown as { spawn: () => string }, "spawn").mockImplementation(() => {
      throw new Error("spawn failure");
    });

    scheduler.addJob({
      name: "fail-job",
      description: "x",
      schedule: "+1s",
      subagent_type: "general-purpose",
      prompt: "p",
    });

    vi.advanceTimersByTime(2000);
    await vi.advanceTimersByTimeAsync(0);

    const emitCalls = emitSpy.mock.calls as Array<[string, { type: string; error?: string }]>;
    const errorEvent = emitCalls.find(([ch, ev]) => ch === "subagents:scheduled" && ev.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.[1].error).toContain("spawn failure");
    spawnSpy.mockRestore();
  });
});

describe("SubagentScheduler — getNextRun with cron schedule", () => {
  let scheduler: SubagentScheduler;
  let store: ScheduleStore;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "schedule-cron-"));
    store = new ScheduleStore(join(tmp, "s.json"));
    scheduler = new SubagentScheduler();
    scheduler.start(makeMockPi(), makeMockCtx(), makeMockManager(), store);
  });

  afterEach(() => {
    scheduler.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("getNextRun returns Date for armed cron job", () => {
    const job = scheduler.addJob({
      name: "cron-get",
      description: "x",
      schedule: "0 0 9 * * 1",
      subagent_type: "general-purpose",
      prompt: "p",
    });
    const next = scheduler.getNextRun(job.id);
    // Should return an ISO string (Date)
    expect(typeof next).toBe("string");
    expect(new Date(next!).getTime()).toBeGreaterThan(Date.now());
  });

  it("getNextRun returns undefined for unknown job id", () => {
    expect(scheduler.getNextRun("no-such-id")).toBeUndefined();
  });
});

describe("SubagentScheduler — executeJob with model", () => {
  let scheduler: SubagentScheduler;
  let store: ScheduleStore;
  let manager: AgentManager;
  let pi: ExtensionAPI;
  let tmp: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmp = mkdtempSync(join(tmpdir(), "schedule-model-"));
    store = new ScheduleStore(join(tmp, "s.json"));
    manager = makeMockManager();
    pi = makeMockPi();
    scheduler = new SubagentScheduler();
    scheduler.start(pi, makeMockCtx(), manager, store);
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves model when job has a model field", async () => {
    // Restart the scheduler with a registry that can actually resolve "openai/gpt-4".
    // The default makeMockCtx() returns an empty getAvailable(), so model resolution
    // silently falls back to undefined — this ctx makes the resolution succeed.
    scheduler.stop();
    const fakeModel = { id: "gpt-4", provider: "openai" };
    const ctxWithModel = {
      cwd: "/tmp",
      modelRegistry: {
        find: vi.fn((provider: string, id: string) =>
          provider === "openai" && id === "gpt-4" ? fakeModel : undefined,
        ),
        getAll: () => [],
        getAvailable: () => [{ provider: "openai", id: "gpt-4", name: "GPT-4" }],
      },
      sessionManager: { getSessionId: () => "sess-1" },
    } as unknown as ExtensionContext;
    scheduler.start(pi, ctxWithModel, manager, store);

    const spawnSpy = vi.spyOn(manager as unknown as { spawn: () => string }, "spawn");

    scheduler.addJob({
      name: "model-job",
      description: "x",
      schedule: "+1s",
      subagent_type: "general-purpose",
      prompt: "p",
      model: "openai/gpt-4",
    });

    vi.advanceTimersByTime(2000);
    await vi.advanceTimersByTimeAsync(0);

    expect(spawnSpy).toHaveBeenCalled();
    // spawn(pi, ctx, type, prompt, options) — options.model must be the resolved model
    expect((spawnSpy.mock.calls[0] as unknown[])[4]).toMatchObject({ model: fakeModel });
  });
});

// ---------------------------------------------------------------------------
// Additional coverage: defensive branches accessed via private method cast
// ---------------------------------------------------------------------------

describe("SubagentScheduler — defensive branches (direct private access)", () => {
  it("emit() is a no-op when this.pi is undefined (falsy-pi branch, line 349)", () => {
    // Scheduler never started → this.pi is undefined → if (this.pi) takes the falsy branch
    const unstarted = new SubagentScheduler();
    type WithEmit = { emit: (e: unknown) => void };
    expect(() => (unstarted as unknown as WithEmit).emit({ type: "removed", jobId: "x" })).not.toThrow();
  });

  it("getNextRun falls through to undefined for an enabled cron job no longer in this.jobs (line 164)", () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "schedule-fallthrough-"));
    const store2 = new ScheduleStore(join(tmp2, "s.json"));
    const s = new SubagentScheduler();
    s.start(makeMockPi(), makeMockCtx(), makeMockManager(), store2);
    // Add a cron job (goes into this.jobs)
    const job = s.addJob({
      name: "cron-fallthrough",
      description: "x",
      schedule: "0 0 9 * * 1",
      subagent_type: "general-purpose",
      prompt: "p",
    });
    // Manually remove from the internal cron map (simulates a gap between armed and store states)
    type WithJobs = { jobs: Map<string, unknown> };
    (s as unknown as WithJobs).jobs.delete(job.id);
    // Job is still enabled in store, scheduleType is "cron" — no cron entry, no interval → returns undefined
    const next = s.getNextRun(job.id);
    expect(next).toBeUndefined();
    s.stop();
    rmSync(tmp2, { recursive: true, force: true });
  });
});
