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
  it("formats a single event — noun is 'change' (not 'event') [#0001]", () => {
    const events: FsEvent[] = [
      {
        watchId: "w1",
        path: "/tmp/x.txt",
        eventType: "creation",
        summary: "/tmp/x.txt now exists",
        formatted: "• /tmp/x.txt: absent → present",
      },
    ];
    const msg = buildChangeChatMessage(
      events,
      new Date("2024-01-01T10:30:00"),
    );
    expect(msg).toMatch(/\[10:30\]/);
    expect(msg).toMatch(/1 change/);
    expect(msg).not.toMatch(/1 event/);
    expect(msg).toMatch(/• \/tmp\/x\.txt: absent → present/);
  });

  it("uses plural 'changes' for multiple events [#0001]", () => {
    const events: FsEvent[] = [
      {
        watchId: "w1",
        path: "/a",
        eventType: "creation",
        summary: "appeared",
        formatted: "• /a: absent → present",
      },
      {
        watchId: "w2",
        path: "/b",
        eventType: "deletion",
        summary: "removed",
        formatted: "• /b: present → absent",
      },
    ];
    const msg = buildChangeChatMessage(
      events,
      new Date("2024-01-01T10:30:00"),
    );
    expect(msg).toMatch(/2 changes/);
    expect(msg).not.toMatch(/2 events/);
  });
});
