import { describe, expect, it } from "vitest";
import { buildChangeChatMessage, buildStatusLine } from "../src/format.js";
import type { WatchMap } from "../src/types.js";

// ---------------------------------------------------------------------------
// buildChangeChatMessage
// ---------------------------------------------------------------------------

describe("buildChangeChatMessage", () => {
  const fakeDate = new Date("2024-01-15T10:30:00.000Z");

  function makeEvent(summary: string, formatted: string) {
    return {
      watchId: "w1",
      repoPath: "/repo/myproject",
      branch: "main",
      eventType: "new_commit" as const,
      sha: "abc1234abc1234",
      isTerminal: false,
      summary,
      formatted,
      timestamp: fakeDate.getTime(),
    };
  }

  it("uses singular 'change' for 1 event", () => {
    const events = [makeEvent("my-repo [main]: new commit abc1234", "• my-repo [main]: new commit abc1234 ✓")];
    const msg = buildChangeChatMessage(events, fakeDate);
    expect(msg).toContain("1 change detected");
    expect(msg).not.toContain("changes");
  });

  it("uses plural 'changes' for 2+ events", () => {
    const events = [
      makeEvent("my-repo [main]: new commit abc1234", "• my-repo [main]: new commit abc1234 ✓"),
      makeEvent("my-repo: branch 'feature' created", "• my-repo: branch 'feature' created ✓"),
    ];
    const msg = buildChangeChatMessage(events, fakeDate);
    expect(msg).toContain("2 changes detected");
  });

  it("includes formatted time in header", () => {
    const events = [makeEvent("s", "• s ✓")];
    const msg = buildChangeChatMessage(events, fakeDate);
    // Should contain some time-like pattern
    expect(msg).toMatch(/\[\d{1,2}:\d{2}\]/);
  });

  it("includes each event's formatted line", () => {
    const events = [
      makeEvent("foo", "• foo ✓"),
      makeEvent("bar", "• bar ✓"),
    ];
    const msg = buildChangeChatMessage(events, fakeDate);
    expect(msg).toContain("• foo ✓");
    expect(msg).toContain("• bar ✓");
  });
});

// ---------------------------------------------------------------------------
// buildStatusLine
// ---------------------------------------------------------------------------

function makeWatchMap(entries: Array<{ watchId: string; terminal?: boolean }>): WatchMap {
  const map: WatchMap = {};
  for (const e of entries) {
    map[e.watchId] = {
      watchId: e.watchId,
      repoPath: "/repo",
      branch: "main",
      targets: ["new_commit"],
      timeoutAt: undefined,
      addedAt: 0,
      lastPolledAt: undefined,
      baseline: undefined,
      terminal: e.terminal ?? false,
      consecutiveErrors: 0,
    };
  }
  return map;
}

describe("buildStatusLine", () => {
  it("idle: returns 'git: idle' with muted alias when no active watches", () => {
    const result = buildStatusLine({}, false, false);
    expect(result.text).toBe("git: idle");
    expect(result.colorAlias).toBe("muted");
  });

  it("idle: terminal-only watches count as idle", () => {
    const watches = makeWatchMap([{ watchId: "w1", terminal: true }]);
    const result = buildStatusLine(watches, false, false);
    expect(result.text).toBe("git: idle");
  });

  it("active: shows count with no errors or paused", () => {
    const watches = makeWatchMap([
      { watchId: "w1" },
      { watchId: "w2" },
      { watchId: "w3" },
    ]);
    const result = buildStatusLine(watches, false, false);
    expect(result.text).toBe("git: 3");
  });

  it("active + errors: includes ⚠ errors", () => {
    const watches = makeWatchMap([{ watchId: "w1" }, { watchId: "w2" }]);
    const result = buildStatusLine(watches, false, true);
    expect(result.text).toBe("git: 2 | ⚠ errors");
    expect(result.colorAlias).toBe("warning");
  });

  it("paused: includes (paused) suffix", () => {
    const watches = makeWatchMap([{ watchId: "w1" }, { watchId: "w2" }]);
    const result = buildStatusLine(watches, true, false);
    expect(result.text).toBe("git: 2 (paused)");
  });

  it("paused + errors: includes both", () => {
    const watches = makeWatchMap([{ watchId: "w1" }]);
    const result = buildStatusLine(watches, true, true);
    expect(result.text).toBe("git: 1 | ⚠ errors (paused)");
    expect(result.colorAlias).toBe("warning");
  });
});
