import { describe, expect, it, vi } from "vitest";

import createExtension, {
  buildProjectAgentSettingsBlockReason,
  buildUserSettingsBlockReason,
  isProjectAgentSettingsFile,
  isUserSettingsFile,
} from "../src/index.js";

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

function makeFakeCtx(cwd = "/repo") {
  return { cwd };
}

// ---------------------------------------------------------------------------
// isUserSettingsFile
// ---------------------------------------------------------------------------

describe("isUserSettingsFile", () => {
  it("matches ~/.pi/settings.json with ~ prefix", () => {
    expect(isUserSettingsFile("~/.pi/settings.json")).toBe(true);
  });

  it("matches resolved absolute path", () => {
    expect(isUserSettingsFile("/Users/testuser/.pi/settings.json")).toBe(true);
  });

  it("returns false for agent settings file", () => {
    expect(isUserSettingsFile("~/.pi/agent/settings.json")).toBe(false);
  });

  it("returns false for project settings file", () => {
    expect(isUserSettingsFile("/repo/pi/settings.json")).toBe(false);
  });

  it("returns false for project agent settings file", () => {
    expect(isUserSettingsFile("/repo/pi/agent/settings.json")).toBe(false);
  });

  it("returns false for unrelated file", () => {
    expect(isUserSettingsFile("/some/random/file.json")).toBe(false);
  });

  it("resolves ~ paths when HOME is unset (nullish fallback)", () => {
    const original = process.env["HOME"];
    delete process.env["HOME"];
    try {
      // The ~-prefixed guard still matches even without HOME.
      expect(isUserSettingsFile("~/.pi/settings.json")).toBe(true);
      // Non-matching paths resolve normally (replace uses "").
      expect(isUserSettingsFile("/some/random/file.json")).toBe(false);
    } finally {
      if (original !== undefined) {
        process.env["HOME"] = original;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// isProjectAgentSettingsFile
// ---------------------------------------------------------------------------

describe("isProjectAgentSettingsFile", () => {
  it("matches pi/agent/settings.json", () => {
    expect(isProjectAgentSettingsFile("pi/agent/settings.json")).toBe(true);
  });

  it("matches absolute path ending with pi/agent/settings.json", () => {
    expect(isProjectAgentSettingsFile("/repo/pi/agent/settings.json")).toBe(true);
  });

  it("returns false for project settings file", () => {
    expect(isProjectAgentSettingsFile("pi/settings.json")).toBe(false);
  });

  it("returns false for user agent settings file", () => {
    expect(isProjectAgentSettingsFile("~/.pi/agent/settings.json")).toBe(false);
  });

  it("returns false for unrelated file", () => {
    expect(isProjectAgentSettingsFile("/some/random/file.json")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Block reason builders
// ---------------------------------------------------------------------------

describe("block reason builders", () => {
  it("builds user settings block reason", () => {
    const reason = buildUserSettingsBlockReason();
    expect(reason).toContain("~/.pi/settings.json");
    expect(reason).toContain("~/.pi/agent/settings.json");
    expect(reason).toContain("⛔ SETTINGS GUARD");
  });

  it("builds project agent settings block reason", () => {
    const reason = buildProjectAgentSettingsBlockReason();
    expect(reason).toContain("./pi/agent/settings.json");
    expect(reason).toContain("./pi/settings.json");
    expect(reason).toContain("⛔ SETTINGS GUARD");
  });
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe("agentSettingsGuard — wiring", () => {
  it("subscribes to before_agent_start", () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const subscribed = pi.on.mock.calls.map((c) => c[0] as string);
    expect(subscribed).toContain("before_agent_start");
  });

  it("subscribes to tool_call", () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const subscribed = pi.on.mock.calls.map((c) => c[0] as string);
    expect(subscribed).toContain("tool_call");
  });
});

// ---------------------------------------------------------------------------
// System prompt injection
// ---------------------------------------------------------------------------

describe("agentSettingsGuard — system prompt injection", () => {
  it("injects instruction into empty system prompt", () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const handler = pi.handlers.get("before_agent_start")!;
    const result = handler(
      { type: "before_agent_start", prompt: "hello", systemPrompt: "" },
      makeFakeCtx(),
    ) as { systemPrompt: string };
    expect(result.systemPrompt).toContain("# Settings Files");
    expect(result.systemPrompt).toContain("~/.pi/agent/settings.json");
    expect(result.systemPrompt).toContain("./pi/settings.json");
  });

  it("does not duplicate when already present", () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const handler = pi.handlers.get("before_agent_start")!;
    const existingPrompt = "# Some header\n\n# Settings Files\nAlready here";
    const result = handler(
      { type: "before_agent_start", prompt: "hello", systemPrompt: existingPrompt },
      makeFakeCtx(),
    ) as { systemPrompt: string } | undefined;
    expect(result).toBeUndefined();
  });

  it("appends after existing system prompt", () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const handler = pi.handlers.get("before_agent_start")!;
    const result = handler(
      { type: "before_agent_start", prompt: "hello", systemPrompt: "# Header" },
      makeFakeCtx(),
    ) as { systemPrompt: string };
    expect(result.systemPrompt).toMatch(/^# Header\n\n# Settings Files/);
  });
});

// ---------------------------------------------------------------------------
// Edit tool — blocked: user-level settings
// ---------------------------------------------------------------------------

describe("agentSettingsGuard — edit tool blocked: user settings", () => {
  it("blocks edit to ~/.pi/settings.json", async () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const result = (await (pi.handlers.get("tool_call")!(
      {
        type: "tool_call",
        toolName: "edit",
        toolCallId: "1",
        input: {
          path: "~/.pi/settings.json",
          edits: [{ oldText: "a", newText: "b" }],
        },
      },
      makeFakeCtx(),
    )) as { block: boolean; reason: string } | undefined);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("~/.pi/settings.json");
  });

  it("blocks edit to resolved user settings path", async () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const result = (await (pi.handlers.get("tool_call")!(
      {
        type: "tool_call",
        toolName: "edit",
        toolCallId: "2",
        input: {
          path: "/Users/testuser/.pi/settings.json",
          edits: [{ oldText: "a", newText: "b" }],
        },
      },
      makeFakeCtx(),
    )) as { block: boolean; reason: string } | undefined);
    expect(result?.block).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Write tool — blocked: user-level settings
// ---------------------------------------------------------------------------

describe("agentSettingsGuard — write tool blocked: user settings", () => {
  it("blocks write to ~/.pi/settings.json", async () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const result = (await (pi.handlers.get("tool_call")!(
      {
        type: "tool_call",
        toolName: "write",
        toolCallId: "3",
        input: {
          path: "~/.pi/settings.json",
          content: '{"extensions": []}',
        },
      },
      makeFakeCtx(),
    )) as { block: boolean; reason: string } | undefined);
    expect(result?.block).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edit tool — blocked: project agent settings
// ---------------------------------------------------------------------------

describe("agentSettingsGuard — edit tool blocked: project agent settings", () => {
  it("blocks edit to pi/agent/settings.json", async () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const result = (await (pi.handlers.get("tool_call")!(
      {
        type: "tool_call",
        toolName: "edit",
        toolCallId: "4",
        input: {
          path: "pi/agent/settings.json",
          edits: [{ oldText: "a", newText: "b" }],
        },
      },
      makeFakeCtx(),
    )) as { block: boolean; reason: string } | undefined);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain("./pi/agent/settings.json");
  });

  it("blocks edit to absolute project agent settings path", async () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const result = (await (pi.handlers.get("tool_call")!(
      {
        type: "tool_call",
        toolName: "edit",
        toolCallId: "5",
        input: {
          path: "/repo/pi/agent/settings.json",
          edits: [{ oldText: "a", newText: "b" }],
        },
      },
      makeFakeCtx(),
    )) as { block: boolean; reason: string } | undefined);
    expect(result?.block).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Write tool — blocked: project agent settings
// ---------------------------------------------------------------------------

describe("agentSettingsGuard — write tool blocked: project agent settings", () => {
  it("blocks write to pi/agent/settings.json", async () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const result = (await (pi.handlers.get("tool_call")!(
      {
        type: "tool_call",
        toolName: "write",
        toolCallId: "6",
        input: {
          path: "pi/agent/settings.json",
          content: '{"test": true}',
        },
      },
      makeFakeCtx(),
    )) as { block: boolean; reason: string } | undefined);
    expect(result?.block).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edit tool — allowed: correct files
// ---------------------------------------------------------------------------

describe("agentSettingsGuard — allowed edits", () => {
  it("allows edit to ~/.pi/agent/settings.json (correct user settings)", async () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const result = (await (pi.handlers.get("tool_call")!(
      {
        type: "tool_call",
        toolName: "edit",
        toolCallId: "7",
        input: {
          path: "~/.pi/agent/settings.json",
          edits: [{ oldText: "a", newText: "b" }],
        },
      },
      makeFakeCtx(),
    )) as { block?: boolean } | undefined);
    expect(result).toBeUndefined();
  });

  it("allows edit to pi/settings.json (correct project settings)", async () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const result = (await (pi.handlers.get("tool_call")!(
      {
        type: "tool_call",
        toolName: "edit",
        toolCallId: "8",
        input: {
          path: "pi/settings.json",
          edits: [{ oldText: "a", newText: "b" }],
        },
      },
      makeFakeCtx(),
    )) as { block?: boolean } | undefined);
    expect(result).toBeUndefined();
  });

  it("allows edit to any other file", async () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const result = (await (pi.handlers.get("tool_call")!(
      {
        type: "tool_call",
        toolName: "edit",
        toolCallId: "9",
        input: {
          path: "/repo/src/index.ts",
          edits: [{ oldText: "a", newText: "b" }],
        },
      },
      makeFakeCtx(),
    )) as { block?: boolean } | undefined);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Write tool — allowed: correct files
// ---------------------------------------------------------------------------

describe("agentSettingsGuard — allowed writes", () => {
  it("allows write to ~/.pi/agent/settings.json", async () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const result = (await (pi.handlers.get("tool_call")!(
      {
        type: "tool_call",
        toolName: "write",
        toolCallId: "10",
        input: {
          path: "~/.pi/agent/settings.json",
          content: '{"extensions": []}',
        },
      },
      makeFakeCtx(),
    )) as { block?: boolean } | undefined);
    expect(result).toBeUndefined();
  });

  it("allows write to pi/settings.json", async () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const result = (await (pi.handlers.get("tool_call")!(
      {
        type: "tool_call",
        toolName: "write",
        toolCallId: "11",
        input: {
          path: "pi/settings.json",
          content: '{"test": true}',
        },
      },
      makeFakeCtx(),
    )) as { block?: boolean } | undefined);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Non-edit/write tools never blocked
// ---------------------------------------------------------------------------

describe("agentSettingsGuard — non-edit/write tools", () => {
  it("never blocks read tool calls", async () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const result = (await (pi.handlers.get("tool_call")!(
      {
        type: "tool_call",
        toolName: "read",
        toolCallId: "12",
        input: { path: "~/.pi/settings.json" },
      },
      makeFakeCtx(),
    )) as { block?: boolean } | undefined);
    expect(result).toBeUndefined();
  });

  it("never blocks bash tool calls", async () => {
    const pi = makeFakePi();
    createExtension(pi as never);
    const result = (await (pi.handlers.get("tool_call")!(
      {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "13",
        input: { command: "cat ~/.pi/settings.json" },
      },
      makeFakeCtx(),
    )) as { block?: boolean } | undefined);
    expect(result).toBeUndefined();
  });
});
