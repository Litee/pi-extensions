/**
 * Tests for format.ts
 */

import { describe, expect, it } from "vitest";

import { buildChangeChatMessage } from "../src/format.js";
import type { FsEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// buildChangeChatMessage
// ---------------------------------------------------------------------------

describe("buildChangeChatMessage", () => {
  it("formats a single event", () => {
    const events: FsEvent[] = [
      {
        watchId: "w1",
        path: "/tmp/x.txt",
        eventType: "exists",
        summary: "/tmp/x.txt now exists",
        formatted: "• /tmp/x.txt now exists ✓",
      },
    ];
    const msg = buildChangeChatMessage(
      events,
      new Date("2024-01-01T10:30:00"),
    );
    expect(msg).toMatch(/\[10:30\]/);
    expect(msg).toMatch(/1 event/);
    expect(msg).toMatch(/• \/tmp\/x\.txt now exists ✓/);
  });

  it("uses plural for multiple events", () => {
    const events: FsEvent[] = [
      {
        watchId: "w1",
        path: "/a",
        eventType: "exists",
        summary: "appeared",
        formatted: "• appeared ✓",
      },
      {
        watchId: "w2",
        path: "/b",
        eventType: "removed",
        summary: "removed",
        formatted: "• removed ✓",
      },
    ];
    const msg = buildChangeChatMessage(
      events,
      new Date("2024-01-01T10:30:00"),
    );
    expect(msg).toMatch(/2 events/);
  });
});
