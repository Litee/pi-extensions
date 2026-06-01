/**
 * Unit tests for FsWatcher (extends BaseWatcher).
 *
 * Uses a stub FsClient. BaseWatcher lifecycle is exercised via
 * executeTool + pollOnce rather than full register() integration.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RowColumn } from "pi-watcher-core/base-watcher-types";
import { POLL_ERROR_THRESHOLD } from "pi-watcher-core/base-watcher";
import { compressPath, FsWatcher, formatTimeLeft } from "../src/watcher.js";
import type { FsClient } from "../src/fs-client.js";
import type { FsBaseline } from "../src/types.js";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../src/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
  saveConfig: vi.fn(() => true),
}));
import * as configModule from "../src/config.js";
import { loadConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePi() {
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
  };
}

function makeClient(
  resp: FsBaseline | Error = { exists: false },
): FsClient {
  const snapshot = vi.fn();
  if (resp instanceof Error) snapshot.mockRejectedValue(resp);
  else snapshot.mockResolvedValue(resp);
  return { snapshot };
}

function makeWatcher(
  resp: FsBaseline | Error = { exists: false },
  nowMs?: number,
) {
  const pi = makePi();
  const client = makeClient(resp);
  const now = nowMs !== undefined ? () => nowMs : Date.now;
  const watcher = new FsWatcher({ pi: pi as never, client, now });
  return { watcher, pi, client };
}

// ---------------------------------------------------------------------------
// addWatch
// ---------------------------------------------------------------------------

describe("FsWatcher.addWatch", () => {
  it("adds a watch with valid params and seeds baseline", async () => {
    const { watcher } = makeWatcher({ exists: false });
    const result = await watcher.executeTool({
      action: "add",
      path: "/tmp/output.json",
      target: "exists",
    });
    expect(result.details["ok"]).toBe(true);
    const watchId = result.details["watchId"] as string;
    expect(typeof watchId).toBe("string");
    expect(watcher["watches"].has(watchId)).toBe(true);
    expect(watcher["baselines"].has(watchId)).toBe(true);
    expect(watcher["baselines"].get(watchId)).toEqual({ exists: false });
  });

  it("returns error when path is missing", async () => {
    const { watcher } = makeWatcher();
    const result = await watcher.executeTool({
      action: "add",
      target: "exists",
    });
    expect(result.details["ok"]).toBe(false);
    expect((result.content[0] as { text: string }).text).toMatch(
      /requires a 'path'/,
    );
  });

  it("returns error when target is missing", async () => {
    const { watcher } = makeWatcher();
    const result = await watcher.executeTool({
      action: "add",
      path: "/tmp/foo",
    });
    expect(result.details["ok"]).toBe(false);
    expect((result.content[0] as { text: string }).text).toMatch(
      /target to be/,
    );
  });

  it("returns error when target is invalid", async () => {
    const { watcher } = makeWatcher();
    const result = await watcher.executeTool({
      action: "add",
      path: "/tmp/foo",
      target: "updated",
    });
    expect(result.details["ok"]).toBe(false);
    expect((result.content[0] as { text: string }).text).toMatch(
      /target to be/,
    );
  });

  it("returns error for target='changed' when path is absent at add time", async () => {
    const { watcher } = makeWatcher({ exists: false });
    const result = await watcher.executeTool({
      action: "add",
      path: "/tmp/foo",
      target: "changed",
    });
    expect(result.details["ok"]).toBe(false);
    expect((result.content[0] as { text: string }).text).toMatch(
      /requires the path to exist at add time/,
    );
    expect(watcher["watches"].size).toBe(0);
  });

  it("accepts target='changed' when path is present", async () => {
    const { watcher } = makeWatcher({
      exists: true,
      mtimeNs: 1000n,
      size: 42,
    });
    const result = await watcher.executeTool({
      action: "add",
      path: "/tmp/foo",
      target: "changed",
    });
    expect(result.details["ok"]).toBe(true);
    const watchId = result.details["watchId"] as string;
    expect(watcher["watches"].get(watchId)?.target).toBe("changed");
  });

  it("soft-fails on seed error — watch still added with undefined baseline", async () => {
    const err = new Error("EACCES: permission denied");
    const { watcher } = makeWatcher(err);
    const result = await watcher.executeTool({
      action: "add",
      path: "/root/secret",
      target: "exists",
    });
    expect(result.details["ok"]).toBe(true);
    const watchId = result.details["watchId"] as string;
    expect(watcher["watches"].get(watchId)?.baseline).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toMatch(
      /seeding failed/,
    );
  });

  it("applies timeoutSeconds correctly", async () => {
    const { watcher } = makeWatcher({ exists: false }, 10_000);
    const result = await watcher.executeTool({
      action: "add",
      path: "/tmp/foo",
      target: "exists",
      timeoutSeconds: 60,
    });
    expect(result.details["ok"]).toBe(true);
    const watchId = result.details["watchId"] as string;
    expect(watcher["watches"].get(watchId)?.timeoutAt).toBe(10_000 + 60_000);
  });

  it("caps timeoutSeconds at MAX_TIMEOUT_SECONDS (24 h)", async () => {
    const { watcher } = makeWatcher({ exists: false }, 10_000);
    const MAX = 24 * 60 * 60;
    const result = await watcher.executeTool({
      action: "add",
      path: "/tmp/foo",
      target: "exists",
      timeoutSeconds: MAX + 3600,
    });
    expect(result.details["ok"]).toBe(true);
    const watchId = result.details["watchId"] as string;
    expect(watcher["watches"].get(watchId)?.timeoutAt).toBe(
      10_000 + MAX * 1000,
    );
    expect((result.content[0] as { text: string }).text).toMatch(/capped/);
  });

  it("rejects negative timeoutSeconds", async () => {
    const { watcher } = makeWatcher();
    const result = await watcher.executeTool({
      action: "add",
      path: "/tmp/foo",
      target: "exists",
      timeoutSeconds: -5,
    });
    expect(result.details["ok"]).toBe(false);
    expect((result.content[0] as { text: string }).text).toMatch(
      /timeoutSeconds/,
    );
  });
});

// ---------------------------------------------------------------------------
// removeWatch
// ---------------------------------------------------------------------------

describe("FsWatcher.removeWatch", () => {
  it("returns path-bearing message with remaining count", async () => {
    const { watcher } = makeWatcher({ exists: false });
    const r1 = await watcher.executeTool({
      action: "add",
      path: "/tmp/a",
      target: "exists",
    });
    await watcher.executeTool({
      action: "add",
      path: "/tmp/b",
      target: "exists",
    });
    const watchId = r1.details["watchId"] as string;
    const result = await watcher.executeTool({ action: "remove", watchId });
    expect((result.content[0] as { text: string }).text).toMatch(
      /\/tmp\/a/,
    );
    expect((result.content[0] as { text: string }).text).toMatch(
      /1 watch\(es\) remaining/,
    );
  });

  it("returns error for unknown watchId", async () => {
    const { watcher } = makeWatcher();
    const result = await watcher.executeTool({
      action: "remove",
      watchId: "no-such-id",
    });
    expect((result.content[0] as { text: string }).text).toMatch(
      /No watch found/,
    );
  });

  it("cleans up watch and baseline entries", async () => {
    const { watcher } = makeWatcher({ exists: false });
    const r = await watcher.executeTool({
      action: "add",
      path: "/tmp/c",
      target: "exists",
    });
    const watchId = r.details["watchId"] as string;
    expect(watcher["watches"].has(watchId)).toBe(true);
    expect(watcher["baselines"].has(watchId)).toBe(true);
    await watcher.executeTool({ action: "remove", watchId });
    expect(watcher["watches"].has(watchId)).toBe(false);
    expect(watcher["baselines"].has(watchId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectChanges
// ---------------------------------------------------------------------------

describe("FsWatcher.detectChanges", () => {
  it("fires timeout path when timeoutAt has elapsed", async () => {
    const { watcher } = makeWatcher({ exists: false }, 9_999);
    const addResult = await watcher.executeTool({
      action: "add",
      path: "/tmp/foo",
      target: "exists",
      timeoutSeconds: 1,
    });
    const watchId = addResult.details["watchId"] as string;
    const watch = watcher["watches"].get(watchId)!;
    watch.timeoutAt = 5_000; // well in the past relative to now=9_999

    const result = await watcher.detectChanges(watch);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.eventType).toBe("timeout");
    expect(result.observedChange).toBe(true);
  });

  it("syncs baseline from this.baselines into watch.baseline before calling poller", async () => {
    const { watcher, client } = makeWatcher({ exists: false });
    const addResult = await watcher.executeTool({
      action: "add",
      path: "/tmp/foo",
      target: "exists",
    });
    const watchId = addResult.details["watchId"] as string;
    const watch = watcher["watches"].get(watchId)!;

    // Overwrite baseline in the map but not on the watch object
    watcher["baselines"].set(watchId, {
      exists: true,
      mtimeNs: 99n,
      size: 100,
    });
    watch.baseline = undefined;

    // Snapshot returns the same state as the new baseline
    (client.snapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: true,
      mtimeNs: 99n,
      size: 100,
    });

    await watcher.detectChanges(watch);
    expect(watch.baseline).toEqual({ exists: true, mtimeNs: 99n, size: 100 });
  });
});

// ---------------------------------------------------------------------------
// containsTerminalStateEvent
// ---------------------------------------------------------------------------

describe("FsWatcher.containsTerminalStateEvent", () => {
  it("returns true when events array is non-empty", () => {
    const { watcher } = makeWatcher();
    const events = [
      {
        watchId: "w1",
        path: "/tmp/foo",
        eventType: "exists" as const,
        summary: "foo now exists",
        formatted: "• foo now exists ✓",
      },
    ];
    expect(
      (
        watcher as unknown as {
          containsTerminalStateEvent(
            e: typeof events,
          ): boolean;
        }
      ).containsTerminalStateEvent(events),
    ).toBe(true);
  });

  it("returns false when events array is empty", () => {
    const { watcher } = makeWatcher();
    expect(
      (
        watcher as unknown as {
          containsTerminalStateEvent(e: never[]): boolean;
        }
      ).containsTerminalStateEvent([]),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normaliseWatch / normaliseBaseline
// ---------------------------------------------------------------------------

describe("FsWatcher.normaliseWatch", () => {
  let watcher: FsWatcher;

  beforeEach(() => {
    ({ watcher } = makeWatcher());
  });

  it("returns null for null / non-object input", () => {
    expect(watcher.normaliseWatch(null)).toBeNull();
    expect(watcher.normaliseWatch("string")).toBeNull();
    expect(watcher.normaliseWatch([])).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(watcher.normaliseWatch({ path: "/tmp/foo", target: "exists" })).toBeNull();
    expect(watcher.normaliseWatch({ watchId: "w1", target: "exists" })).toBeNull();
  });

  it("returns null for invalid target", () => {
    expect(
      watcher.normaliseWatch({
        watchId: "w1",
        path: "/tmp/foo",
        target: "updated",
      }),
    ).toBeNull();
  });

  it("round-trips a valid watch", () => {
    const raw = {
      watchId: "abc",
      path: "/tmp/output.json",
      target: "exists",
      timeoutAt: 99999,
      addedAt: 12345,
      lastPolledAt: 12400,
      baseline: { exists: true, mtimeNs: "1234567890", size: 42 },
      terminal: false,
      consecutiveErrors: 0,
    };
    const result = watcher.normaliseWatch(raw);
    expect(result).not.toBeNull();
    expect(result?.watchId).toBe("abc");
    expect(result?.path).toBe("/tmp/output.json");
    expect(result?.target).toBe("exists");
    expect(result?.baseline?.mtimeNs).toBe(1234567890n);
    expect(result?.baseline?.size).toBe(42);
  });

  it("silently ignores legacy 'mode' field", () => {
    const raw = {
      watchId: "w1",
      path: "/tmp/foo",
      target: "removed",
      mode: "event", // legacy field — should be ignored
      terminal: false,
      consecutiveErrors: 0,
      addedAt: 0,
      timeoutAt: undefined,
      lastPolledAt: undefined,
    };
    const result = watcher.normaliseWatch(raw);
    expect(result).not.toBeNull();
    expect(result).not.toHaveProperty("mode");
  });
});

describe("FsWatcher.normaliseBaseline", () => {
  let watcher: FsWatcher;

  beforeEach(() => {
    ({ watcher } = makeWatcher());
  });

  it("returns null for invalid input", () => {
    expect(watcher.normaliseBaseline(null)).toBeNull();
    expect(watcher.normaliseBaseline("x")).toBeNull();
    expect(watcher.normaliseBaseline([])).toBeNull();
    expect(watcher.normaliseBaseline({ noExists: true })).toBeNull();
  });

  it("parses a minimal baseline", () => {
    expect(watcher.normaliseBaseline({ exists: false })).toEqual({
      exists: false,
    });
  });

  it("round-trips mtimeNs as a BigInt via string serialisation", () => {
    const result = watcher.normaliseBaseline({
      exists: true,
      mtimeNs: "9007199254740993",
      size: 100,
    });
    expect(result?.mtimeNs).toBe(9007199254740993n);
    expect(result?.size).toBe(100);
  });

  it("round-trips mtimeNs when stored as bigint directly", () => {
    const result = watcher.normaliseBaseline({
      exists: true,
      mtimeNs: 42n,
    });
    expect(result?.mtimeNs).toBe(42n);
  });

  it("ignores invalid mtimeNs string", () => {
    const result = watcher.normaliseBaseline({
      exists: true,
      mtimeNs: "not-a-number",
    });
    expect(result?.mtimeNs).toBeUndefined();
  });

  it("drops non-finite size", () => {
    expect(
      watcher.normaliseBaseline({ exists: true, size: Infinity }),
    ).toEqual({ exists: true });
  });
});

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

describe("FsWatcher.classifyError", () => {
  let watcher: FsWatcher;

  beforeEach(() => {
    ({ watcher } = makeWatcher());
  });

  it("classifies EACCES as auth-error kind", () => {
    const err = Object.assign(new Error("EACCES"), { code: "EACCES" });
    const result = watcher.classifyError(err);
    expect(result.kind).toBe("auth");
    expect(result.statusModifier).toBe("auth-error");
    expect(result.shouldBackoff).toBe(false);
    expect(result.userMessage).toMatch(/permission denied/);
  });

  it("classifies EPERM as auth-error kind", () => {
    const err = Object.assign(new Error("EPERM"), { code: "EPERM" });
    const result = watcher.classifyError(err);
    expect(result.kind).toBe("auth");
    expect(result.statusModifier).toBe("auth-error");
  });

  it("classifies generic stat errors", () => {
    const err = new Error("stat failed");
    const result = watcher.classifyError(err);
    expect(result.kind).toBe("generic");
    expect(result.shouldBackoff).toBe(false);
    expect(result.userMessage).toMatch(/check the path is accessible/);
  });

  it("classifies null error gracefully", () => {
    const result = watcher.classifyError(null);
    expect(result.kind).toBe("generic");
  });
});

// ---------------------------------------------------------------------------
// view rendering
// ---------------------------------------------------------------------------

describe("FsWatcher view", () => {
  let watcher: FsWatcher;

  beforeEach(() => {
    ({ watcher } = makeWatcher());
  });

  const mockWatch = {
    watchId: "w1",
    path: "/tmp/output.json",
    target: "exists" as const,
    timeoutAt: undefined,
    addedAt: new Date("2024-01-01").getTime(),
    lastPolledAt: undefined,
    baseline: { exists: false } as FsBaseline,
    terminal: false,
    consecutiveErrors: 0,
  };

  it("renderItemRowText formats correctly", () => {
    const text = watcher.view.renderItemRowText(mockWatch);
    expect(text).toContain("/tmp/output.json");
    expect(text).toContain("WATCHING");
    expect(text).toContain("exists");
  });

  it("renderItemRowText shows DONE for terminal watches", () => {
    const text = watcher.view.renderItemRowText({
      ...mockWatch,
      terminal: true,
    });
    expect(text).toContain("DONE");
  });

  it("renderItemRowText shows EXPIRED for timed-out watches", () => {
    const text = watcher.view.renderItemRowText({ ...mockWatch, terminal: true, timeoutAt: Date.now() - 1000 });
    expect(text).toContain("EXPIRED");
    expect(text).not.toContain("DONE");
  });

  it("renderItemRowText shows DONE for target-met-early (future timeoutAt)", () => {
    const text = watcher.view.renderItemRowText({ ...mockWatch, terminal: true, timeoutAt: Date.now() + 60_000 });
    expect(text).toContain("DONE");
    expect(text).not.toContain("EXPIRED");
  });

  it("renderItemRowTUI returns columns with path first", () => {
    const cols = watcher.view.renderItemRowTUI(mockWatch, {
      theme: {} as never,
      width: 80,
    });
    expect(cols.length).toBeGreaterThan(0);
    expect(cols[0]?.name).toBe("path");
    expect(cols[0]?.text).toBe("/tmp/output.json");
    expect(cols[0]?.color).toBe("accent");
  });

  it("renderItemRowTUI uses dim color for terminal watch path column", () => {
    const cols = watcher.view.renderItemRowTUI(
      { ...mockWatch, terminal: true },
      { theme: {} as never, width: 80 },
    );
    expect(cols[0]?.color).toBe("dim");
  });

  it("renderItemRowTUI uses warning color for terminal watch status column", () => {
    const cols = watcher.view.renderItemRowTUI(
      { ...mockWatch, terminal: true },
      { theme: {} as never, width: 80 },
    );
    expect(cols[1]?.color).toBe("warning");
  });

  it("renderItemRowTUI uses dim color for terminal watch timeout column", () => {
    const cols = watcher.view.renderItemRowTUI(
      { ...mockWatch, terminal: true },
      { theme: {} as never, width: 80 },
    );
    expect(cols[2]?.color).toBe("dim");
  });

  it("renderItemRowTUI uses warning color at error threshold", () => {
    const cols = watcher.view.renderItemRowTUI(
      { ...mockWatch, consecutiveErrors: POLL_ERROR_THRESHOLD },
      { theme: {} as never, width: 80 },
    );
    expect(cols[0]?.color).toBe("warning");
  });

  it("renderItemRowTUI columns: path, status, timeout, target", () => {
    const cols = watcher.view.renderItemRowTUI(mockWatch, {
      theme: {} as never,
      width: 80,
    });
    expect(cols[0]!.name).toBe("path");
    expect(cols[1]!.name).toBe("status");
    expect(cols[2]!.name).toBe("timeout");
    expect(cols[3]!.name).toBe("target");
  });

  it("renderItemDetail includes expected fields", () => {
    const fields = watcher.view.renderItemDetail(mockWatch, {
      theme: {} as never,
      width: 80,
    });
    expect(fields.find((f) => f.label === "path")?.value).toBe(
      "/tmp/output.json",
    );
    expect(fields.find((f) => f.label === "target")?.value).toBe("exists");
    expect(fields.find((f) => f.label === "state")?.value).toBe("absent");
    expect(fields.find((f) => f.label === "polled")?.value).toBe("never");
    expect(fields.find((f) => f.label === "timeout")?.value).toBe("none");
    expect(fields.find((f) => f.label === "errors")?.value).toBe("0");
    expect(fields.find((f) => f.label === "terminal")?.value).toBe("no");
  });

  it("renderItemDetail shows present state when baseline.exists=true", () => {
    const fields = watcher.view.renderItemDetail(
      { ...mockWatch, baseline: { exists: true } },
      { theme: {} as never, width: 80 },
    );
    expect(fields.find((f) => f.label === "state")?.value).toBe("present");
  });

  it("renderItemDetail shows unknown when baseline is undefined", () => {
    const fields = watcher.view.renderItemDetail(
      { ...mockWatch, baseline: undefined },
      { theme: {} as never, width: 80 },
    );
    expect(fields.find((f) => f.label === "state")?.value).toBe("unknown");
  });

  it("renderItemDetail shows poll interval when provided", () => {
    const fields = watcher.view.renderItemDetail(mockWatch, {
      theme: {} as never,
      width: 80,
      pollIntervalMs: 60_000,
    });
    expect(fields.find((f) => f.label === "poll")?.value).toBe("60s");
  });

  it("renderItemDetail shows unknown poll when pollIntervalMs not provided", () => {
    const fields = watcher.view.renderItemDetail(mockWatch, {
      theme: {} as never,
      width: 80,
    });
    expect(fields.find((f) => f.label === "poll")?.value).toBe("unknown");
  });

  it("renderEventRow returns event.formatted", () => {
    const event = {
      watchId: "w1",
      path: "/tmp/foo",
      eventType: "exists" as const,
      summary: "/tmp/foo now exists",
      formatted: "• /tmp/foo now exists ✓",
    };
    expect(watcher.view.renderEventRow(event)).toBe(
      "• /tmp/foo now exists ✓",
    );
  });

  it("itemSortKey returns path", () => {
    expect(watcher.view.itemSortKey(mockWatch)).toBe("/tmp/output.json");
  });
});

// ---------------------------------------------------------------------------
// view — status column behaviour
// ---------------------------------------------------------------------------

describe("FsWatcher view status column", () => {
  let watcher: FsWatcher;
  const baseW = {
    watchId: "w1",
    path: "/tmp/foo",
    target: "exists" as const,
    timeoutAt: undefined as number | undefined,
    addedAt: 0,
    lastPolledAt: undefined as number | undefined,
    baseline: undefined as FsBaseline | undefined,
  };

  beforeEach(() => {
    ({ watcher } = makeWatcher());
  });

  it("active watch shows WATCHING", () => {
    const w = { ...baseW, terminal: false, consecutiveErrors: 0 };
    const cols = watcher.view.renderItemRowTUI(w, {
      theme: {} as never,
      width: 80,
    });
    expect(cols.find((c) => c.name === "status")!.text).toBe("WATCHING");
  });

  it("terminal watch shows DONE", () => {
    const w = { ...baseW, terminal: true, consecutiveErrors: 0 };
    const cols = watcher.view.renderItemRowTUI(w, {
      theme: {} as never,
      width: 80,
    });
    expect(cols.find((c) => c.name === "status")!.text).toBe("DONE");
  });

  it("timed-out watch shows EXPIRED (timeoutAt in the past)", () => {
    const w = { ...baseW, terminal: true, consecutiveErrors: 0, timeoutAt: Date.now() - 1000 };
    const cols = watcher.view.renderItemRowTUI(w, {
      theme: stubTheme as never,
      width: 80,
    });
    expect(cols.find((c) => c.name === "status")!.text).toBe("EXPIRED");
  });

  it("terminal watch with future timeoutAt (target met early) shows DONE", () => {
    const w = { ...baseW, terminal: true, consecutiveErrors: 0, timeoutAt: Date.now() + 60_000 };
    const cols = watcher.view.renderItemRowTUI(w, {
      theme: stubTheme as never,
      width: 80,
    });
    expect(cols.find((c) => c.name === "status")!.text).toBe("DONE");
  });

  it("error threshold watch shows ERROR", () => {
    const w = {
      ...baseW,
      terminal: false,
      consecutiveErrors: POLL_ERROR_THRESHOLD,
    };
    const cols = watcher.view.renderItemRowTUI(w, {
      theme: {} as never,
      width: 80,
    });
    expect(cols.find((c) => c.name === "status")!.text).toBe("ERROR");
  });
});

// ---------------------------------------------------------------------------
// view — timeout column
// ---------------------------------------------------------------------------

describe("FsWatcher view timeout column", () => {
  let watcher: FsWatcher;
  const baseW = {
    watchId: "w1",
    path: "/tmp/foo",
    target: "exists" as const,
    addedAt: 0,
    lastPolledAt: undefined as number | undefined,
    baseline: undefined as FsBaseline | undefined,
  };

  beforeEach(() => {
    ({ watcher } = makeWatcher());
  });

  it("shows '-' when no timeoutAt", () => {
    const w = { ...baseW, timeoutAt: undefined, terminal: false, consecutiveErrors: 0 };
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 });
    expect(cols.find((c) => c.name === "timeout")!.text).toBe("-");
  });

  it("shows 'expired' when timeoutAt is in the past", () => {
    const w = { ...baseW, timeoutAt: Date.now() - 1000, terminal: false, consecutiveErrors: 0 };
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 });
    expect(cols.find((c) => c.name === "timeout")!.text).toBe("expired");
  });

  it("shows time left for future timeouts", () => {
    const w = { ...baseW, timeoutAt: Date.now() + 90_000, terminal: false, consecutiveErrors: 0 };
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 });
    expect(cols.find((c) => c.name === "timeout")!.text).toMatch(/\d+[smh] left/);
  });

  it("uses warning color < 5 min remaining", () => {
    const w = { ...baseW, timeoutAt: Date.now() + 2 * 60_000, terminal: false, consecutiveErrors: 0 };
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 });
    expect(cols.find((c) => c.name === "timeout")!.color).toBe("warning");
  });

  it("uses dim color >= 5 min remaining", () => {
    const w = { ...baseW, timeoutAt: Date.now() + 10 * 60_000, terminal: false, consecutiveErrors: 0 };
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 });
    expect(cols.find((c) => c.name === "timeout")!.color).toBe("dim");
  });

  it("uses dim color for terminal watch", () => {
    const w = { ...baseW, timeoutAt: Date.now() + 10_000, terminal: true, consecutiveErrors: 0 };
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 });
    expect(cols.find((c) => c.name === "timeout")!.color).toBe("dim");
  });

  it("timeout column width is 10", () => {
    const w = { ...baseW, timeoutAt: undefined, terminal: false, consecutiveErrors: 0 };
    const cols = watcher.view.renderItemRowTUI(w, { theme: {} as never, width: 100 });
    expect(cols.find((c) => c.name === "timeout")!.width).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// view.compressColumns
// ---------------------------------------------------------------------------

describe("FsWatcher view.compressColumns", () => {
  it("is defined", () => {
    const { watcher } = makeWatcher();
    expect(typeof watcher.view.compressColumns).toBe("function");
  });

  it("compresses long paths from the left", () => {
    const { watcher } = makeWatcher();
    const longPath =
      "/very/deeply/nested/directory/structure/with/a/long/filename.json";
    const cols: RowColumn[] = [
      { name: "path", text: longPath },
      { name: "status", text: "WATCHING", width: 10 },
      { name: "timeout", text: "-", width: 10 },
      { name: "target", text: "exists", width: 10 },
    ];
    const totalWidth = 60;
    const result = watcher.view.compressColumns!(cols, totalWidth);
    const pathCol = result.find((c) => c.name === "path")!;
    const fixedTotal = 30; // 10+10+10
    const separators = 6; // 3 gaps × 2
    expect(pathCol.text.length).toBeLessThanOrEqual(
      totalWidth - fixedTotal - separators,
    );
    expect(pathCol.text).toContain("…");
  });

  it("leaves path unchanged when it already fits", () => {
    const { watcher } = makeWatcher();
    const cols: RowColumn[] = [
      { name: "path", text: "/tmp/foo.json" },
      { name: "status", text: "WATCHING", width: 10 },
    ];
    const result = watcher.view.compressColumns!(cols, 80);
    expect(result.find((c) => c.name === "path")!.text).toBe("/tmp/foo.json");
  });

  it("passes non-path columns through unchanged", () => {
    const { watcher } = makeWatcher();
    const cols: RowColumn[] = [
      { name: "path", text: "/tmp/x" },
      { name: "target", text: "exists", width: 8 },
    ];
    const result = watcher.view.compressColumns!(cols, 80);
    expect(result.find((c) => c.name === "target")!.text).toBe("exists");
  });
});

// ---------------------------------------------------------------------------
// Per-watch schedulers
// ---------------------------------------------------------------------------

describe("FsWatcher per-watch schedulers", () => {
  it("schedulerFor returns same instance on second call", () => {
    const { watcher } = makeWatcher();
    const sf = (
      watcher as unknown as { schedulerFor(k: string): unknown }
    ).schedulerFor.bind(watcher);
    const s1 = sf("key1");
    const s2 = sf("key1");
    expect(s1).toBe(s2);
    expect(s1).not.toBe(sf("key2"));
  });

  it("addWatch starts a per-watch scheduler when not paused", async () => {
    vi.useFakeTimers();
    const { watcher } = makeWatcher({ exists: false });
    const result = await watcher.executeTool({
      action: "add",
      path: "/tmp/foo",
      target: "exists",
    });
    const watchId = result.details["watchId"] as string;
    const schedulers = (
      watcher as unknown as {
        _watchSchedulers: Map<string, { isRunning: boolean }>;
      }
    )._watchSchedulers;
    expect(schedulers.get(watchId)?.isRunning).toBe(true);
    watcher.stopPolling();
    vi.useRealTimers();
  });

  it("stopPolling stops all per-watch schedulers", async () => {
    vi.useFakeTimers();
    const { watcher } = makeWatcher({ exists: false });
    await watcher.executeTool({
      action: "add",
      path: "/tmp/a",
      target: "exists",
    });
    await watcher.executeTool({
      action: "add",
      path: "/tmp/b",
      target: "exists",
    });
    watcher.stopPolling();
    const schedulers = (
      watcher as unknown as {
        _watchSchedulers: Map<string, { isRunning: boolean }>;
      }
    )._watchSchedulers;
    for (const s of schedulers.values()) {
      expect(s.isRunning).toBe(false);
    }
    vi.useRealTimers();
  });

  it("startPolling only starts schedulers for non-terminal watches", () => {
    vi.useFakeTimers();
    const { watcher } = makeWatcher({ exists: false });
    // Pause to prevent addWatch from starting schedulers
    (watcher as unknown as { paused: boolean }).paused = true;
    watcher["watches"].set("w1", {
      watchId: "w1",
      path: "/tmp/active",
      target: "exists" as const,
      timeoutAt: undefined,
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
    });
    watcher["watches"].set("w2", {
      watchId: "w2",
      path: "/tmp/done",
      target: "exists" as const,
      timeoutAt: undefined,
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: true,
      consecutiveErrors: 0,
    });
    (watcher as unknown as { paused: boolean }).paused = false;
    watcher.startPolling();
    const schedulers = (
      watcher as unknown as {
        _watchSchedulers: Map<string, { isRunning: boolean }>;
      }
    )._watchSchedulers;
    expect(schedulers.get("w1")?.isRunning).toBe(true);
    expect(schedulers.get("w2")).toBeUndefined();
    watcher.stopPolling();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Constructor — defaultDisplayMode
// ---------------------------------------------------------------------------

describe("FsWatcher constructor defaultDisplayMode", () => {
  it("sets defaultDisplayMode from loadConfig when provided", () => {
    vi.mocked(loadConfig).mockReturnValue({ defaultDisplayMode: "statusline" });
    const { watcher } = makeWatcher();
    expect(watcher["defaultDisplayMode"]).toBe("statusline");
  });

  it("does not set defaultDisplayMode when config has no value", () => {
    vi.mocked(loadConfig).mockReturnValue({});
    const { watcher } = makeWatcher();
    expect(watcher["defaultDisplayMode"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// onSessionStart — config integration
// ---------------------------------------------------------------------------

describe("FsWatcher.onSessionStart config integration", () => {
  it("applies defaultDisplayMode=statusline from config when no persisted state", async () => {
    vi.mocked(loadConfig).mockReturnValue({ defaultDisplayMode: "statusline" });
    const { watcher } = makeWatcher();
    const ctx = {
      ui: {
        setStatus: vi.fn(),
        theme: { fg: (_c: string, t: string) => t },
      },
      sessionManager: { getEntries: () => [] },
    };
    await watcher.onSessionStart(ctx);
    expect(watcher["displayMode"]).toBe("statusline");
  });

  it("persisted displayMode overrides user config", async () => {
    vi.mocked(loadConfig).mockReturnValue({ defaultDisplayMode: "statusline" });
    const { watcher } = makeWatcher();
    const ctx = {
      ui: {
        setStatus: vi.fn(),
        theme: { fg: (_c: string, t: string) => t },
      },
      sessionManager: {
        getEntries: () => [
          {
            type: "custom",
            customType: "pi-file-system-watcher:state",
            data: {
              savedAt: 1,
              paused: false,
              watches: [],
              baselines: {},
              enabled: false,
              displayMode: "widget",
            },
          },
        ],
      },
    };
    await watcher.onSessionStart(ctx);
    expect(watcher["displayMode"]).toBe("widget");
  });

  it("defaults to widget when config has no defaultDisplayMode", async () => {
    vi.mocked(loadConfig).mockReturnValue({});
    const { watcher } = makeWatcher();
    const ctx = {
      ui: {
        setStatus: vi.fn(),
        theme: { fg: (_c: string, t: string) => t },
      },
      sessionManager: { getEntries: () => [] },
    };
    await watcher.onSessionStart(ctx);
    expect(watcher["displayMode"]).toBe("widget");
  });
});

// ---------------------------------------------------------------------------
// statusLabel / displayName / commandName
// ---------------------------------------------------------------------------

class TestableFsWatcher extends FsWatcher {
  get statusLabel_pub() {
    return this.statusLabel;
  }
  get displayName_pub() {
    return this.displayName;
  }
  get commandName_pub() {
    return (this as unknown as { commandName: string }).commandName;
  }
  get userDefaultDisplayMode_pub() {
    return this.userDefaultDisplayMode;
  }
  saveUserDefaultDisplayMode_pub(
    mode: "widget" | "statusline" | undefined,
  ) {
    return this.saveUserDefaultDisplayMode(mode);
  }
}

describe("FsWatcher identity", () => {
  let watcher: TestableFsWatcher;

  beforeEach(() => {
    vi.mocked(loadConfig).mockReturnValue({});
    const pi = makePi();
    const client = makeClient({ exists: false });
    watcher = new TestableFsWatcher({ pi: pi as never, client, now: Date.now });
  });

  it('statusLabel is "fs"', () => {
    expect(watcher.statusLabel_pub).toBe("fs");
  });

  it('displayName is "File System Watcher"', () => {
    expect(watcher.displayName_pub).toBe("File System Watcher");
  });

  it('commandName is "file-system-watcher"', () => {
    expect(watcher.commandName_pub).toBe("file-system-watcher");
  });
});

// ---------------------------------------------------------------------------
// userDefaultDisplayMode
// ---------------------------------------------------------------------------

describe("FsWatcher userDefaultDisplayMode", () => {
  let watcher: TestableFsWatcher;

  beforeEach(() => {
    vi.mocked(configModule.loadConfig).mockReturnValue({});
    const pi = makePi();
    const client = makeClient({ exists: false });
    watcher = new TestableFsWatcher({ pi: pi as never, client, now: Date.now });
  });

  it("reads from loadConfig", () => {
    vi.mocked(configModule.loadConfig).mockReturnValue({
      defaultDisplayMode: "statusline",
    });
    expect(watcher.userDefaultDisplayMode_pub).toBe("statusline");
  });

  it("returns undefined when config has no defaultDisplayMode", () => {
    vi.mocked(configModule.loadConfig).mockReturnValue({});
    expect(watcher.userDefaultDisplayMode_pub).toBeUndefined();
  });

  it("saveUserDefaultDisplayMode writes via saveConfig", () => {
    const spy = vi.spyOn(configModule, "saveConfig");
    watcher.saveUserDefaultDisplayMode_pub("widget");
    expect(spy).toHaveBeenCalledWith({ defaultDisplayMode: "widget" });
  });

  it("saveUserDefaultDisplayMode(undefined) clears preference", () => {
    const spy = vi.spyOn(configModule, "saveConfig");
    watcher.saveUserDefaultDisplayMode_pub(undefined);
    expect(spy).toHaveBeenCalledWith({ defaultDisplayMode: undefined });
  });
});

// ---------------------------------------------------------------------------
// browseOptions
// ---------------------------------------------------------------------------

describe("FsWatcher.browseOptions", () => {
  let watcher: FsWatcher;

  beforeEach(() => {
    vi.mocked(configModule.loadConfig).mockReturnValue({});
    const pi = makePi();
    const client = makeClient({ exists: false });
    watcher = new FsWatcher({ pi: pi as never, client, now: Date.now });
  });

  it("searchable is false", () => {
    const opts = (
      watcher as unknown as {
        browseOptions(): Record<string, unknown>;
      }
    ).browseOptions();
    expect(opts["searchable"]).toBe(false);
  });

  it("has remove rowAction", () => {
    const opts = (
      watcher as unknown as {
        browseOptions(): { rowActions?: Array<{ id: string }> };
      }
    ).browseOptions();
    expect(opts.rowActions?.some((a) => a.id === "remove")).toBe(true);
  });

  it("onRefresh calls pollOnce", async () => {
    const opts = (
      watcher as unknown as {
        browseOptions(): { onRefresh?(): Promise<void> };
      }
    ).browseOptions();
    const spy = vi.spyOn(watcher, "pollOnce").mockResolvedValue(undefined);
    await opts.onRefresh!();
    expect(spy).toHaveBeenCalled();
  });

  it("onPurge calls executePurge", () => {
    const spy = vi
      .spyOn(watcher as unknown as { executePurge(): [] }, "executePurge")
      .mockReturnValue([]);
    const opts = (
      watcher as unknown as { browseOptions(): { onPurge?(): [] } }
    ).browseOptions();
    expect(typeof opts.onPurge).toBe("function");
    opts.onPurge!();
    expect(spy).toHaveBeenCalled();
  });

  it("getPollIntervalMs calls schedulerFor with watchId", () => {
    const mockScheduler = { intervalMs: 120_000 };
    vi.spyOn(
      watcher as unknown as { schedulerFor(): unknown },
      "schedulerFor",
    ).mockReturnValue(mockScheduler);
    const opts = (
      watcher as unknown as {
        browseOptions(): {
          getPollIntervalMs?: (w: import("../src/types.js").FsWatch) => number;
        };
      }
    ).browseOptions();
    const result = opts.getPollIntervalMs?.({
      watchId: "test-id",
      path: "/tmp/foo",
      target: "exists" as const,
      timeoutAt: undefined,
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: false,
      consecutiveErrors: 0,
    });
    expect(result).toBe(120_000);
  });
});

// ---------------------------------------------------------------------------
// formatTimeLeft
// ---------------------------------------------------------------------------

describe("formatTimeLeft", () => {
  it("returns '-' when no timeout", () => {
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

// ---------------------------------------------------------------------------
// compressPath
// ---------------------------------------------------------------------------

describe("compressPath", () => {
  it("returns the path unchanged when it fits", () => {
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

// ---------------------------------------------------------------------------
// enabled flag — issue #0002
// ---------------------------------------------------------------------------

describe("FsWatcher.addWatch sets enabled=true [#0002]", () => {
  it("sets enabled=true on the watcher after a successful addWatch", async () => {
    vi.mocked(loadConfig).mockReturnValue({});
    const { watcher } = makeWatcher({ exists: false });
    // enabled starts false (base-class default)
    expect((watcher as unknown as { enabled: boolean }).enabled).toBe(false);

    await watcher.executeTool({
      action: "add",
      path: "/tmp/watch-me.txt",
      target: "exists",
    });

    // After addWatch the watcher should consider itself enabled so that
    // any poll notification fired before onTurnEnd does NOT include the
    // stale "Run manage_tools(...)" reactivation hint.
    expect((watcher as unknown as { enabled: boolean }).enabled).toBe(true);
  });

  it("notification fired after addWatch does NOT include reactivation hint [#0002]", async () => {
    vi.useFakeTimers();
    vi.mocked(loadConfig).mockReturnValue({});
    const pi = makePi();
    // Snapshot: absent first, then present after 65 s → triggers 'exists' event
    const client: FsClient = {
      snapshot: vi.fn()
        .mockResolvedValueOnce({ exists: false })
        .mockResolvedValue({ exists: true }),
    };
    const watcher = new FsWatcher({ pi: pi as never, client, now: Date.now });

    await watcher.executeTool({
      action: "add",
      path: "/tmp/hint-test.txt",
      target: "exists",
    });

    // Advance timer past first poll interval so the poll fires and detects the change
    await vi.advanceTimersByTimeAsync(65_000);

    const changeCalls = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[0] as { content?: string }).content?.includes("detected"),
    );
    expect(changeCalls.length).toBeGreaterThan(0);
    const content = (changeCalls[0]![0] as { content: string }).content;
    expect(content).not.toContain("manage_tools");
    vi.useRealTimers();
  });
});
