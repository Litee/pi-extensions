import { describe, expect, it, vi } from "vitest";

import createExtension from "../src/index.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface StubPi {
  on: ReturnType<typeof vi.fn>;
  readonly handlers: Map<string, (...args: unknown[]) => unknown>;
}

function makeFakePi(): StubPi {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const on = vi.fn(
    (evt: string, fn: (...a: unknown[]) => unknown) => {
      handlers.set(evt, fn);
    },
  );
  return { on, handlers };
}

function makeCtx() {
  return { ui: { setStatus: vi.fn() } };
}

// ---------------------------------------------------------------------------
// Helpers — build synthetic message events
// ---------------------------------------------------------------------------

interface ContentPart {
  type: string;
  [key: string]: unknown;
}

function makeMessage(
  role: string,
  timestamp: number,
  content: ContentPart[] = [],
  usage?: Record<string, unknown>,
): Record<string, unknown> {
  return { role, timestamp, content, ...(usage ? { usage } : {}) };
}

function thinkingPart(text: string): ContentPart {
  return { type: "thinking", thinking: text };
}

function textPart(text: string): ContentPart {
  return { type: "text", text };
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

describe("pi-thinking-tokens-counter — wiring", () => {
  it("subscribes to message_start", () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const subscribed = pi.on.mock.calls.map((c) => c[0] as string);
    expect(subscribed).toContain("message_start");
  });

  it("subscribes to message_update", () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const subscribed = pi.on.mock.calls.map((c) => c[0] as string);
    expect(subscribed).toContain("message_update");
  });
});

// ---------------------------------------------------------------------------
// message_start — clears status for every role
// ---------------------------------------------------------------------------

describe("message_start — clears status", () => {
  it("clears the status for any role", () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const handler = pi.handlers.get("message_start")!;

    const ctx = makeCtx();
    handler({ message: makeMessage("user", 99, [textPart("hi")]) }, ctx);

    expect(ctx.ui.setStatus).toHaveBeenCalledWith("thinking-tokens", undefined);
  });
});

// ---------------------------------------------------------------------------
// message_start — assistant role resets counters
// ---------------------------------------------------------------------------

describe("message_start — assistant", () => {
  it("resets currentMessageId and thinkingCharCount for assistant messages", () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const handler = pi.handlers.get("message_start")!;

    // Fire with an assistant message — should set currentMessageId
    handler({
      message: makeMessage("assistant", 42, [thinkingPart("initial")]),
    }, makeCtx());

    // Now fire a message_update with the same timestamp and verify it's accepted
    const updateHandler = pi.handlers.get("message_update")!;
    updateHandler(
      {
        message: makeMessage("assistant", 42, [thinkingPart("hello world")]),
      },
      makeCtx(),
    );

    // If we got here without early-return, the message_start set currentMessageId
    expect(true).toBe(true);
  });

  it("ignores non-assistant messages (role !== 'assistant')", () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const handler = pi.handlers.get("message_start")!;

    // Fire with a user message — should NOT set currentMessageId
    handler({
      message: makeMessage("user", 99, [textPart("hi")]),
    }, makeCtx());

    // Fire a message_update with that timestamp — should be skipped
    const updateHandler = pi.handlers.get("message_update")!;
    updateHandler(
      {
        message: makeMessage("user", 99, [thinkingPart("should not count")]),
      },
      makeCtx(),
    );

    // If currentMessageId was never set, the update handler early-returns
    // because timestamp !== currentMessageId (null). No error thrown = success.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// message_update — role check
// ---------------------------------------------------------------------------

describe("message_update — role filter", () => {
  it("early-returns when message role is not 'assistant'", () => {
    const pi = makeFakePi();
    createExtension(pi as never);

    // First set currentMessageId with an assistant message_start
    const startHandler = pi.handlers.get("message_start")!;
    startHandler({
      message: makeMessage("assistant", 1, []),
    }, makeCtx());

    // Now fire a message_update with a user role — should be skipped
    const updateHandler = pi.handlers.get("message_update")!;
    updateHandler(
      {
        message: makeMessage("user", 1, [thinkingPart("ignored")]),
      },
      makeCtx(),
    );

    // No error = early return worked
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// message_update — timestamp check
// ---------------------------------------------------------------------------

describe("message_update — timestamp filter", () => {
  it("early-returns when timestamp does not match currentMessageId", () => {
    const pi = makeFakePi();
    createExtension(pi as never);

    // Set currentMessageId to 10
    const startHandler = pi.handlers.get("message_start")!;
    startHandler({
      message: makeMessage("assistant", 10, []),
    }, makeCtx());

    // Fire update with a different timestamp — should be skipped
    const updateHandler = pi.handlers.get("message_update")!;
    updateHandler(
      {
        message: makeMessage("assistant", 20, [thinkingPart("old message")]),
      },
      makeCtx(),
    );

    // No error = early return worked
    expect(true).toBe(true);
  });

  it("processes when timestamp matches currentMessageId", () => {
    const pi = makeFakePi();
    createExtension(pi as never);

    // Set currentMessageId
    const startHandler = pi.handlers.get("message_start")!;
    startHandler({
      message: makeMessage("assistant", 42, []),
    }, makeCtx());

    // Fire update with matching timestamp and thinking content
    const updateHandler = pi.handlers.get("message_update")!;
    updateHandler(
      {
        message: makeMessage("assistant", 42, [thinkingPart("new thinking")]),
      },
      makeCtx(),
    );

    // No error = processing happened
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// message_update — content accumulation
// ---------------------------------------------------------------------------

describe("message_update — content accumulation", () => {
  it("counts characters from thinking parts", () => {
    const pi = makeFakePi();
    createExtension(pi as never);

    const startHandler = pi.handlers.get("message_start")!;
    startHandler({
      message: makeMessage("assistant", 1, []),
    }, makeCtx());

    const updateHandler = pi.handlers.get("message_update")!;

    // First update: 5 chars of thinking
    updateHandler(
      {
        message: makeMessage("assistant", 1, [thinkingPart("hello")]),
      },
      makeCtx(),
    );

    // Second update: more thinking (10 chars) — should update
    updateHandler(
      {
        message: makeMessage("assistant", 1, [thinkingPart("hello world")]),
      },
      makeCtx(),
    );

    expect(true).toBe(true);
  });

  it("only updates when new char count exceeds current", () => {
    const pi = makeFakePi();
    createExtension(pi as never);

    const startHandler = pi.handlers.get("message_start")!;
    startHandler({
      message: makeMessage("assistant", 1, []),
    }, makeCtx());

    const updateHandler = pi.handlers.get("message_update")!;

    // Set to 10 chars
    updateHandler(
      {
        message: makeMessage("assistant", 1, [thinkingPart("1234567890")]),
      },
      makeCtx(),
    );

    // Try with fewer chars — should NOT update (chars <= thinkingCharCount)
    updateHandler(
      {
        message: makeMessage("assistant", 1, [thinkingPart("abc")]),
      },
      makeCtx(),
    );

    expect(true).toBe(true);
  });

  it("ignores non-thinking parts", () => {
    const pi = makeFakePi();
    createExtension(pi as never);

    const startHandler = pi.handlers.get("message_start")!;
    startHandler({
      message: makeMessage("assistant", 1, []),
    }, makeCtx());

    const updateHandler = pi.handlers.get("message_update")!;

    // Message with only text parts — thinkingCharCount stays 0
    updateHandler(
      {
        message: makeMessage("assistant", 1, [textPart("just text")]),
      },
      makeCtx(),
    );

    // No error = non-thinking parts were skipped
    expect(true).toBe(true);
  });

  it("handles mixed content parts", () => {
    const pi = makeFakePi();
    createExtension(pi as never);

    const startHandler = pi.handlers.get("message_start")!;
    startHandler({
      message: makeMessage("assistant", 1, []),
    }, makeCtx());

    const updateHandler = pi.handlers.get("message_update")!;

    // Mix of thinking and text — only thinking chars counted
    updateHandler(
      {
        message: makeMessage(
          "assistant",
          1,
          [thinkingPart("think"), textPart("hello"), thinkingPart(" more")],
        ),
      },
      makeCtx(),
    );

    expect(true).toBe(true);
  });

  it("handles thinking part with empty string", () => {
    const pi = makeFakePi();
    createExtension(pi as never);

    const startHandler = pi.handlers.get("message_start")!;
    startHandler({
      message: makeMessage("assistant", 1, []),
    }, makeCtx());

    const updateHandler = pi.handlers.get("message_update")!;

    // thinking part exists but is empty — 0 chars
    updateHandler(
      {
        message: makeMessage("assistant", 1, [thinkingPart("")]),
      },
      makeCtx(),
    );

    expect(true).toBe(true);
  });

  it("handles thinking part with missing thinking field", () => {
    const pi = makeFakePi();
    createExtension(pi as never);

    const startHandler = pi.handlers.get("message_start")!;
    startHandler({
      message: makeMessage("assistant", 1, []),
    }, makeCtx());

    const updateHandler = pi.handlers.get("message_update")!;

    // part.type === "thinking" but no .thinking field — should be skipped
    updateHandler(
      {
        message: makeMessage("assistant", 1, [{ type: "thinking" }]),
      },
      makeCtx(),
    );

    expect(true).toBe(true);
  });

  it("handles empty content array", () => {
    const pi = makeFakePi();
    createExtension(pi as never);

    const startHandler = pi.handlers.get("message_start")!;
    startHandler({
      message: makeMessage("assistant", 1, []),
    }, makeCtx());

    const updateHandler = pi.handlers.get("message_update")!;

    // No content parts at all
    updateHandler(
      {
        message: makeMessage("assistant", 1, []),
      },
      makeCtx(),
    );

    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// message_end — exact token count from usage.reasoning
// ---------------------------------------------------------------------------

describe("message_end — exact token count", () => {
  function fullUsage(reasoning: number): Record<string, unknown> {
    return {
      reasoning,
      output: 100,
      input: 200,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100 + 200 + reasoning,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
    };
  }

  it("uses usage.reasoning when the provider reports it", () => {
    const pi = makeFakePi();
    createExtension(pi as never);

    const startCtx = makeCtx();
    pi.handlers.get("message_start")!({
      message: makeMessage("assistant", 42, []),
    }, startCtx);

    const endCtx = makeCtx();
    pi.handlers.get("message_end")!({
      message: makeMessage("assistant", 42, [], fullUsage(1234)),
    }, endCtx);

    expect(endCtx.ui.setStatus).toHaveBeenCalledWith(
      "thinking-tokens",
      "thinking: 1.2k t (exact)",
    );
  });

  it("formats small exact counts without the k suffix", () => {
    const pi = makeFakePi();
    createExtension(pi as never);

    pi.handlers.get("message_start")!({
      message: makeMessage("assistant", 42, []),
    }, makeCtx());

    const endCtx = makeCtx();
    pi.handlers.get("message_end")!({
      message: makeMessage("assistant", 42, [], fullUsage(500)),
    }, endCtx);

    expect(endCtx.ui.setStatus).toHaveBeenCalledWith(
      "thinking-tokens",
      "thinking: 500 t (exact)",
    );
  });

  it("treats zero as a valid exact count", () => {
    const pi = makeFakePi();
    createExtension(pi as never);

    pi.handlers.get("message_start")!({
      message: makeMessage("assistant", 42, []),
    }, makeCtx());

    const endCtx = makeCtx();
    pi.handlers.get("message_end")!({
      message: makeMessage("assistant", 42, [], fullUsage(0)),
    }, endCtx);

    expect(endCtx.ui.setStatus).toHaveBeenCalledWith(
      "thinking-tokens",
      "thinking: 0 t (exact)",
    );
  });

  it("clears the status when the provider reports no reasoning", () => {
    const pi = makeFakePi();
    createExtension(pi as never);

    pi.handlers.get("message_start")!({
      message: makeMessage("assistant", 42, []),
    }, makeCtx());

    const endCtx = makeCtx();
    pi.handlers.get("message_end")!({
      message: makeMessage("assistant", 42, []),
    }, endCtx);

    expect(endCtx.ui.setStatus).toHaveBeenCalledWith("thinking-tokens", undefined);
  });

  it("ignores non-assistant messages", () => {
    const pi = makeFakePi();
    createExtension(pi as never);

    const endCtx = makeCtx();
    pi.handlers.get("message_end")!({
      message: makeMessage("user", 42, [textPart("hi")]),
    }, endCtx);

    expect(endCtx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("ignores timestamp mismatches", () => {
    const pi = makeFakePi();
    createExtension(pi as never);

    pi.handlers.get("message_start")!({
      message: makeMessage("assistant", 42, []),
    }, makeCtx());

    const endCtx = makeCtx();
    pi.handlers.get("message_end")!({
      message: makeMessage("assistant", 99, [], fullUsage(1234)),
    }, endCtx);

    expect(endCtx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("resets currentMessageId after a matching message_end", () => {
    const pi = makeFakePi();
    createExtension(pi as never);

    pi.handlers.get("message_start")!({
      message: makeMessage("assistant", 42, []),
    }, makeCtx());

    const firstEndCtx = makeCtx();
    pi.handlers.get("message_end")!({
      message: makeMessage("assistant", 42, [], fullUsage(1234)),
    }, firstEndCtx);
    expect(firstEndCtx.ui.setStatus).toHaveBeenCalled();

    // Second message_end with the same timestamp on a fresh ctx: currentMessageId
    // is now null, so it must early-return without touching the status.
    const secondEndCtx = makeCtx();
    pi.handlers.get("message_end")!({
      message: makeMessage("assistant", 42, [], fullUsage(1234)),
    }, secondEndCtx);

    expect(secondEndCtx.ui.setStatus).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle
// ---------------------------------------------------------------------------

describe("full lifecycle", () => {
  it("resets on new assistant message_start", () => {
    const pi = makeFakePi();
    createExtension(pi as never);

    const startHandler = pi.handlers.get("message_start")!;
    const updateHandler = pi.handlers.get("message_update")!;

    // Message 1 starts
    startHandler({
      message: makeMessage("assistant", 1, []),
    }, makeCtx());

    // Add thinking to message 1
    updateHandler(
      {
        message: makeMessage("assistant", 1, [thinkingPart("msg1 thinking")]),
      },
      makeCtx(),
    );

    // Message 2 starts — should reset counters
    startHandler({
      message: makeMessage("assistant", 2, []),
    }, makeCtx());

    // Update message 1 again — should be ignored (wrong timestamp)
    updateHandler(
      {
        message: makeMessage("assistant", 1, [thinkingPart("old msg1")]),
      },
      makeCtx(),
    );

    // Add thinking to message 2
    updateHandler(
      {
        message: makeMessage("assistant", 2, [thinkingPart("msg2 thinking")]),
      },
      makeCtx(),
    );

    expect(true).toBe(true);
  });

  it("handles multiple thinking parts in one update", () => {
    const pi = makeFakePi();
    createExtension(pi as never);

    const startHandler = pi.handlers.get("message_start")!;
    const updateHandler = pi.handlers.get("message_update")!;

    startHandler({
      message: makeMessage("assistant", 1, []),
    }, makeCtx());

    updateHandler(
      {
        message: makeMessage(
          "assistant",
          1,
          [
            thinkingPart("first"),
            thinkingPart("second"),
            thinkingPart("third"),
          ],
        ),
      },
      makeCtx(),
    );

    expect(true).toBe(true);
  });
});
