import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const {
  createAgentSession,
  defaultResourceLoaderCtor,
  getAgentDir,
  sessionManagerInMemory,
  settingsManagerCreate,
} = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  defaultResourceLoaderCtor: vi.fn(),
  getAgentDir: vi.fn(() => "/mock/agent-dir"),
  sessionManagerInMemory: vi.fn(() => ({ kind: "memory-session-manager" })),
  settingsManagerCreate: vi.fn(() => ({ kind: "settings-manager" })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession,
  DefaultResourceLoader: class {
    constructor(options: unknown) {
      defaultResourceLoaderCtor(options);
    }

    async reload() {}

    getExtensions() { return { extensions: [] }; }
  },
  getAgentDir,
  SessionManager: { inMemory: sessionManagerInMemory },
  SettingsManager: { create: settingsManagerCreate },
}));

vi.mock("../src/agent-types.js", () => ({
  BUILTIN_TOOL_NAMES: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  getConfig: vi.fn(() => ({
    displayName: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    promptMode: "replace",
  })),
  getAgentConfig: vi.fn(() => ({
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
    systemPrompt: "You are Explore.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
  })),
  getMemoryToolNames: vi.fn(() => []),
  getReadOnlyMemoryToolNames: vi.fn(() => []),
  getToolNamesForType: vi.fn(() => ["read"]),
}));

vi.mock("../src/env.js", () => ({
  detectEnv: vi.fn(() => Promise.resolve({ isGitRepo: false, branch: "", platform: "linux" })),
}));

vi.mock("../src/prompts.js", () => ({
  buildAgentPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../src/memory.js", () => ({
  buildMemoryBlock: vi.fn(() => ""),
  buildReadOnlyMemoryBlock: vi.fn(() => ""),
}));

vi.mock("../src/skill-loader.js", () => ({
  preloadSkills: vi.fn(() => []),
}));

import { getAgentConversation, resumeAgent, runAgent } from "../src/agent-runner.js";

function createSession(finalText: string) {
  const listeners: Array<(event: unknown) => void> = [];
  const session = {
    messages: [] as unknown[],
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    prompt: vi.fn(() => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: finalText }],
      });
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read"]),
    setActiveToolsByName: vi.fn(),
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
  };
  return { session, listeners };
}

const ctx = {
  cwd: "/tmp",
  model: undefined,
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: vi.fn(() => "parent prompt"),
  sessionManager: { getBranch: vi.fn(() => []) },
} as unknown as ExtensionContext;

const pi = {} as unknown as ExtensionAPI;

beforeEach(() => {
  createAgentSession.mockReset();
  defaultResourceLoaderCtor.mockClear();
  getAgentDir.mockClear();
  sessionManagerInMemory.mockClear();
  settingsManagerCreate.mockClear();
});

describe("agent-runner final output capture", () => {
  it("returns the final assistant text even when no text_delta events were streamed", async () => {
    const { session } = createSession("LOCKED");
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "Say LOCKED", { pi });

    expect(result.responseText).toBe("LOCKED");
  });

  it("binds extensions before prompting", async () => {
    const { session } = createSession("BOUND");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say BOUND", { pi });

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).toHaveBeenCalledWith(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ onError: expect.any(Function) }),
    );

    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0]!;
    const promptOrder = session.prompt.mock.invocationCallOrder[0]!;
    expect(bindOrder).toBeLessThan(promptOrder);
  });

  it("passes effective cwd and agentDir to the loader and settings manager", async () => {
    const { session } = createSession("CONFIGURED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say CONFIGURED", { pi, cwd: "/tmp/worktree" });

    expect(getAgentDir).toHaveBeenCalledTimes(1);
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/worktree",
      agentDir: "/mock/agent-dir",
    }));
    expect(settingsManagerCreate).toHaveBeenCalledWith("/tmp/worktree", "/mock/agent-dir");
    expect(sessionManagerInMemory).toHaveBeenCalledWith("/tmp/worktree");
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/worktree",
      agentDir: "/mock/agent-dir",
    }));
  });

  it("suppresses AGENTS.md/CLAUDE.md/APPEND_SYSTEM.md for subagents", async () => {
    const { session } = createSession("ISOLATED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say ISOLATED", { pi });

    // noContextFiles skips AGENTS.md/CLAUDE.md at the loader source;
    // appendSystemPromptOverride suppresses APPEND_SYSTEM.md (no flag equivalent).
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        noContextFiles: true,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        appendSystemPromptOverride: expect.any(Function),
      }),
    );
    // The override returns an empty list so any loaded sources are discarded.
    const ctorArgs = (defaultResourceLoaderCtor.mock.calls as unknown[][])[0]![0] as { appendSystemPromptOverride: (s: string[]) => string[] };
    expect(ctorArgs.appendSystemPromptOverride(["would-be-loaded"])).toEqual([]);
  });

  it("resumeAgent also falls back to the final assistant message text", async () => {
    const { session } = createSession("RESUMED");

    const result = await resumeAgent(session as unknown as AgentSession, "Continue");

    expect(result).toBe("RESUMED");
  });

  it("sets the agent name as session name before binding extensions", async () => {
    const { session } = createSession("NAMED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(session.setSessionName).toHaveBeenCalledWith("Explore");
    const setOrder = session.setSessionName.mock.invocationCallOrder[0]!;
    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0]!;
    expect(setOrder).toBeLessThan(bindOrder);
  });

  it("suffixes the session name with a short agentId so parallel spawns are distinguishable", async () => {
    const { session } = createSession("NAMED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, agentId: "a1b2c3d4e5f6" });

    expect(session.setSessionName).toHaveBeenCalledWith("Explore#a1b2c3d4");
  });
});

// ─── message_end → onAssistantUsage wiring (issue #38) ─────────────────
// Both runAgent and resumeAgent dispatch usage to the caller via this
// callback. The callback feeds the AgentRecord lifetime accumulator, which
// is the source of truth for total tokens (survives compaction).
describe("agent-runner usage callback wiring", () => {
  function emitMessageEnd(listeners: Array<(e: unknown) => void>, usage: { input?: number; output?: number; cacheWrite?: number } | undefined) {
    const event = { type: "message_end", message: { role: "assistant", usage } };
    for (const l of listeners) l(event);
  }

  it("runAgent forwards full usage from message_end events", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: Array<{ input: number; output: number; cacheWrite: number }> = [];
    session.prompt = vi.fn(() => {
      // Two assistant messages over the run
      emitMessageEnd(listeners, { input: 100, output: 50, cacheWrite: 10 });
      emitMessageEnd(listeners, { input: 200, output: 80, cacheWrite: 20 });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([
      { input: 100, output: 50, cacheWrite: 10 },
      { input: 200, output: 80, cacheWrite: 20 },
    ]);
  });

  it("runAgent normalizes partial usage objects to 0 for missing fields", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: Array<{ input: number; output: number; cacheWrite: number }> = [];
    session.prompt = vi.fn(() => {
      emitMessageEnd(listeners, { input: 50 }); // output, cacheWrite missing
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([{ input: 50, output: 0, cacheWrite: 0 }]);
  });

  it("runAgent skips the callback when message_end has no usage field", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const cb = vi.fn();
    session.prompt = vi.fn(() => {
      emitMessageEnd(listeners, undefined);
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", { pi, onAssistantUsage: cb });

    expect(cb).not.toHaveBeenCalled();
  });

  it("resumeAgent forwards usage on message_end the same way", async () => {
    const { session, listeners } = createSession("RESUMED");
    const seen: Array<{ input: number; output: number; cacheWrite: number }> = [];

    session.prompt = vi.fn(() => {
      emitMessageEnd(listeners, { input: 10, output: 20, cacheWrite: 5 });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "RESUMED" }] });
    });

    await resumeAgent(session as unknown as AgentSession, "continue", {
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([{ input: 10, output: 20, cacheWrite: 5 }]);
  });

  it("forwards compaction_end events to onCompaction (only when not aborted)", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: Array<{ reason: string; tokensBefore: number }> = [];
    session.prompt = vi.fn(() => {
      // Successful compaction — should fire
      for (const l of listeners) l({
        type: "compaction_end",
        aborted: false,
        reason: "threshold",
        result: { tokensBefore: 12345 },
      });
      // Aborted compaction — should NOT fire
      for (const l of listeners) l({
        type: "compaction_end",
        aborted: true,
        reason: "manual",
        result: { tokensBefore: 99999 },
      });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onCompaction: (info) => seen.push(info),
    });

    expect(seen).toEqual([{ reason: "threshold", tokensBefore: 12345 }]);
  });
});

// getAgentConversation renders the subagent transcript shown in the /agents
// inspect overlay. Pure function over session.messages — no mocks needed
// beyond a literal-object session.
describe("getAgentConversation", () => {
  function fakeSession(messages: unknown[]) {
    return { messages } as never;
  }

  it("returns an empty string for a session with no messages", () => {
    expect(getAgentConversation(fakeSession([]))).toBe("");
  });

  it("formats a user-then-assistant exchange with role-prefixed lines joined by blank lines", () => {
    const out = getAgentConversation(
      fakeSession([
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ]),
    );
    expect(out).toBe("[User]: hi\n\n[Assistant]: hello");
  });

  it("accepts user content as content-blocks (not just strings)", () => {
    const out = getAgentConversation(
      fakeSession([{ role: "user", content: [{ type: "text", text: "from blocks" }] }]),
    );
    expect(out).toBe("[User]: from blocks");
  });

  it("emits a [Tool Calls] block listing each toolCall by name or toolName, falling back to 'unknown'", () => {
    const out = getAgentConversation(
      fakeSession([
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling tools" },
            { type: "toolCall", name: "search" },
            { type: "toolCall", toolName: "edit" },
            { type: "toolCall" },
          ],
        },
      ]),
    );
    expect(out).toContain("[Assistant]: calling tools");
    expect(out).toContain("[Tool Calls]:\n  Tool: search\n  Tool: edit\n  Tool: unknown");
  });

  it("truncates toolResult content beyond 200 chars and tags it with the tool name", () => {
    const longText = "x".repeat(300);
    const out = getAgentConversation(
      fakeSession([
        {
          role: "toolResult",
          toolName: "bash",
          content: [{ type: "text", text: longText }],
        },
      ]),
    );
    expect(out.startsWith("[Tool Result (bash)]: ")).toBe(true);
    expect(out.endsWith("...")).toBe(true);
    // prefix + 200 chars + "..."
    expect(out.length).toBe("[Tool Result (bash)]: ".length + 200 + 3);
  });

  it("emits [Tool Calls] but no [Assistant] when the assistant only made tool calls", () => {
    const out = getAgentConversation(
      fakeSession([
        { role: "user", content: "do it" },
        { role: "assistant", content: [{ type: "toolCall", name: "search" }] },
      ]),
    );
    expect(out).toContain("[User]: do it");
    expect(out).not.toContain("[Assistant]:");
    expect(out).toContain("[Tool Calls]:\n  Tool: search");
  });
});

// ─── Extra coverage: uncovered branches ──────────────────────────────────
import { getConfig, getAgentConfig, getMemoryToolNames, getReadOnlyMemoryToolNames } from "../src/agent-types.js";
import { preloadSkills } from "../src/skill-loader.js";
import { buildAgentPrompt } from "../src/prompts.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "../src/memory.js";

describe("agent-runner — agentConfig=null fallback to DEFAULT_AGENTS", () => {
  it("calls buildAgentPrompt with general-purpose fallback when getAgentConfig returns null", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(undefined);
    const { session } = createSession("FALLBACK");
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "unknown-type", "go", { pi });
    expect(result.responseText).toBe("FALLBACK");
    expect(buildAgentPrompt).toHaveBeenCalled();
  });
});

describe("agent-runner — isolated: true", () => {
  it("passes noExtensions and noSkills=true when isolated", async () => {
    const { session } = createSession("ISO");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, isolated: true });

    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({ noExtensions: true, noSkills: true }),
    );
  });
});

describe("agent-runner — thinkingLevel", () => {
  it("sets thinkingLevel on sessionOpts when provided", async () => {
    const { session } = createSession("THINK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, thinkingLevel: "high" });

    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ thinkingLevel: "high" }),
    );
  });
});

describe("agent-runner — extensions as array", () => {
  it("filters active tools to only those matching the extension prefix list", async () => {
    vi.mocked(getConfig).mockReturnValueOnce({
      displayName: "Explore",
      description: "Explore",
      builtinToolNames: ["read"],
      extensions: ["allowed-ext"],
      skills: false,
      promptMode: "replace",
    } as never);
    vi.mocked(getAgentConfig).mockReturnValueOnce({
      name: "Explore",
      description: "Explore",
      builtinToolNames: ["read"],
      extensions: ["allowed-ext"],
      skills: false,
      systemPrompt: "You are Explore.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    } as never);

    const { session } = createSession("EXT");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    // Tools are now passed to createAgentSession (no post-construction setActiveToolsByName)
    const sessionCallOpts = createAgentSession.mock.calls.at(-1)?.[0] as { tools: string[] };
    expect(sessionCallOpts.tools).toContain("read");
    expect(sessionCallOpts.tools).not.toContain("Agent");
    // Mock loader returns no extensions, so no extension tools surface
    expect(sessionCallOpts.tools).not.toContain("other-ext:tool");
  });
});

describe("agent-runner — disallowedTools with extensions=false", () => {
  it("filters disallowed tools even when extensions=false", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce({
      name: "Explore",
      description: "Explore",
      builtinToolNames: ["read", "bash"],
      extensions: false,
      skills: false,
      systemPrompt: "You are Explore.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
      disallowedTools: ["bash"],
    } as never);

    const { session } = createSession("DENY");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    // Tools are now passed to createAgentSession; disallowed tools are excluded there
    const sessionCallOpts = createAgentSession.mock.calls.at(-1)?.[0] as { tools: string[] };
    expect(sessionCallOpts.tools).not.toContain("bash");
    expect(sessionCallOpts.tools).toContain("read");
  });
});

describe("agent-runner — skills as array (preloadSkills)", () => {
  it("calls preloadSkills with the skills array when skills is string[]", async () => {
    vi.mocked(getConfig).mockReturnValueOnce({
      displayName: "Explore",
      description: "Explore",
      builtinToolNames: ["read"],
      extensions: false,
      skills: ["some-skill"],
      promptMode: "replace",
    } as never);
    vi.mocked(getAgentConfig).mockReturnValueOnce({
      name: "Explore",
      description: "Explore",
      builtinToolNames: ["read"],
      extensions: false,
      skills: ["some-skill"],
      systemPrompt: "You are Explore.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    } as never);
    vi.mocked(preloadSkills).mockReturnValueOnce([{ name: "some-skill", content: "skill content" }] as never);

    const { session } = createSession("SKILLS");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(preloadSkills).toHaveBeenCalledWith(["some-skill"], ctx.cwd);
    // noSkills=true since skills is array
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({ noSkills: true }),
    );
  });
});

describe("agent-runner — memory block (read-write)", () => {
  it("calls buildMemoryBlock when agent has memory and write tools", async () => {
    vi.mocked(getConfig).mockReturnValueOnce({
      displayName: "Explore",
      description: "Explore",
      builtinToolNames: ["read", "write", "edit"],
      extensions: false,
      skills: false,
      promptMode: "replace",
    } as never);
    vi.mocked(getAgentConfig).mockReturnValueOnce({
      name: "Explore",
      description: "Explore",
      builtinToolNames: ["read", "write", "edit"],
      extensions: false,
      skills: false,
      systemPrompt: "You are Explore.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
      memory: { path: "/tmp/memory.md", description: "Memory" },
    } as never);
    vi.mocked(getMemoryToolNames).mockReturnValueOnce(["memory_read", "memory_write"]);

    // Override getToolNamesForType to return write tools so hasWriteTools=true
    const { getToolNamesForType } = await import("../src/agent-types.js");
    vi.mocked(getToolNamesForType).mockReturnValueOnce(["read", "write", "edit"]);

    const { session } = createSession("MEM");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(buildMemoryBlock).toHaveBeenCalled();
  });
});

describe("agent-runner — memory block (read-only)", () => {
  it("calls buildReadOnlyMemoryBlock when agent has memory but no write tools", async () => {
    vi.mocked(getConfig).mockReturnValueOnce({
      displayName: "Explore",
      description: "Explore",
      builtinToolNames: ["read"],
      extensions: false,
      skills: false,
      promptMode: "replace",
    } as never);
    vi.mocked(getAgentConfig).mockReturnValueOnce({
      name: "Explore",
      description: "Explore",
      builtinToolNames: ["read"],
      extensions: false,
      skills: false,
      systemPrompt: "You are Explore.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
      memory: { path: "/tmp/memory.md", description: "Memory" },
    } as never);
    vi.mocked(getReadOnlyMemoryToolNames).mockReturnValueOnce(["memory_read"]);

    const { session } = createSession("ROMEM");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(buildReadOnlyMemoryBlock).toHaveBeenCalled();
  });
});

describe("agent-runner — inheritContext", () => {
  it("prepends parent context when inheritContext=true and context is non-empty", async () => {
    const ctxWithHistory = {
      ...ctx,
      sessionManager: {
        getBranch: vi.fn(() => [{
          type: "message",
          message: { role: "user", content: "previous question" },
        }]),
      },
    } as unknown as ExtensionContext;

    const { session } = createSession("INHERIT");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctxWithHistory, "Explore", "new task", { pi, inheritContext: true });

    const promptArg = ((session.prompt.mock.calls as unknown as string[][])[0]![0]);
    expect(promptArg).toContain("Parent Conversation Context");
    expect(promptArg).toContain("new task");
  });

  it("does not prepend context when inheritContext=true but context is empty", async () => {
    const { session } = createSession("NOINHERIT");
    createAgentSession.mockResolvedValue({ session });
    // ctx.sessionManager.getBranch returns [] by default

    await runAgent(ctx, "Explore", "task", { pi, inheritContext: true });

    const promptArg = ((session.prompt.mock.calls as unknown as string[][])[0]![0]);
    expect(promptArg).toBe("task");
  });
});

describe("agent-runner — event callbacks", () => {
  it("fires onTurnEnd after each turn_end event", async () => {
    const { session, listeners } = createSession("TURNS");
    createAgentSession.mockResolvedValue({ session });

    const turnCounts: number[] = [];
    session.prompt = vi.fn(() => {
      for (const l of listeners) l({ type: "turn_end" });
      for (const l of listeners) l({ type: "turn_end" });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "TURNS" }] });
    });

    await runAgent(ctx, "Explore", "go", { pi, onTurnEnd: (n) => turnCounts.push(n) });

    expect(turnCounts).toEqual([1, 2]);
  });

  it("fires onToolActivity for tool_execution_start and tool_execution_end events", async () => {
    const { session, listeners } = createSession("TOOLS");
    createAgentSession.mockResolvedValue({ session });

    const activities: Array<{ type: string; toolName: string }> = [];
    session.prompt = vi.fn(() => {
      for (const l of listeners) l({ type: "tool_execution_start", toolName: "bash" });
      for (const l of listeners) l({ type: "tool_execution_end", toolName: "bash" });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "TOOLS" }] });
    });

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity: (a) => activities.push(a) });

    expect(activities).toEqual([
      { type: "start", toolName: "bash" },
      { type: "end", toolName: "bash" },
    ]);
  });

  it("fires onTextDelta for message_update text_delta events", async () => {
    const { session, listeners } = createSession("DELTA");
    createAgentSession.mockResolvedValue({ session });

    const deltas: string[] = [];
    session.prompt = vi.fn(() => {
      for (const l of listeners) l({ type: "message_start" });
      for (const l of listeners) l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hel" } });
      for (const l of listeners) l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "DELTA" }] });
    });

    await runAgent(ctx, "Explore", "go", { pi, onTextDelta: (d) => deltas.push(d) });

    expect(deltas).toEqual(["hel", "lo"]);
  });

  it("fires onSessionCreated with the session object", async () => {
    const { session } = createSession("SESS");
    createAgentSession.mockResolvedValue({ session });

    let createdSession: AgentSession | undefined;
    await runAgent(ctx, "Explore", "go", { pi, onSessionCreated: (s) => { createdSession = s; } });

    expect(createdSession).toBe(session);
  });

  it("fires onToolActivity extension-error for bindExtensions error", async () => {
    const { session } = createSession("ERR");
    createAgentSession.mockResolvedValue({ session });

    const activities: Array<{ type: string; toolName: string }> = [];
    const bindWithError = (opts: { onError?: (e: { extensionPath: string }) => void }) => {
      opts.onError?.({ extensionPath: "/some/ext" });
      return Promise.resolve();
    };
    session.bindExtensions = vi.fn(bindWithError as never);

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity: (a) => activities.push(a) });

    expect(activities.some(a => a.toolName.startsWith("extension-error:"))).toBe(true);
  });
});

describe("agent-runner — maxTurns enforcement", () => {
  it("steers the agent when turn count reaches maxTurns", async () => {
    const { session, listeners } = createSession("STEERED");
    createAgentSession.mockResolvedValue({ session });

    session.prompt = vi.fn(() => {
      // Fire turn_end events up to maxTurns
      for (const l of listeners) l({ type: "turn_end" });
      for (const l of listeners) l({ type: "turn_end" });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "STEERED" }] });
    });

    const result = await runAgent(ctx, "Explore", "go", { pi, maxTurns: 2 });
    expect(session.steer).toHaveBeenCalledWith(expect.stringContaining("Wrap up"));
    expect(result.steered).toBe(true);
  });

  it("aborts the agent when turns exceed maxTurns + graceTurns", async () => {
    const { session, listeners } = createSession("ABORTED");
    createAgentSession.mockResolvedValue({ session });
    const { setGraceTurns } = await import("../src/agent-runner.js");
    setGraceTurns(1);

    session.prompt = vi.fn(() => {
      // maxTurns=1, graceTurns=1 → abort fires at turn 2
      for (const l of listeners) l({ type: "turn_end" }); // turnCount=1 → soft limit
      for (const l of listeners) l({ type: "turn_end" }); // turnCount=2 → abort
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "ABORTED" }] });
    });

    const result = await runAgent(ctx, "Explore", "go", { pi, maxTurns: 1 });
    expect(session.abort).toHaveBeenCalled();
    expect(result.aborted).toBe(true);

    // Restore grace turns
    setGraceTurns(5);
  });
});

describe("agent-runner — abort signal forwarding", () => {
  it("aborts the session when the signal fires during prompt execution", async () => {
    const { session } = createSession("SIG");
    createAgentSession.mockResolvedValue({ session });

    const controller = new AbortController();
    session.prompt = vi.fn(() => {
      // Abort while prompt is executing (after forwardAbortSignal has registered)
      controller.abort();
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "SIG" }] });
    });

    await runAgent(ctx, "Explore", "go", { pi, signal: controller.signal });
    expect(session.abort).toHaveBeenCalled();
  });
});

describe("agent-runner — resumeAgent with no callbacks", () => {
  it("works when called with empty options (no onToolActivity etc.)", async () => {
    const { session } = createSession("MINIMAL");

    const result = await resumeAgent(session as unknown as AgentSession, "go");
    expect(result).toBe("MINIMAL");
  });

  it("works when called with abort signal", async () => {
    const { session } = createSession("SIG-RESUME");

    const controller = new AbortController();
    session.prompt = vi.fn(() => {
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "SIG-RESUME" }] });
    });

    const result = await resumeAgent(session as unknown as AgentSession, "go", {
      signal: controller.signal,
    });
    expect(result).toBe("SIG-RESUME");
  });
});

describe("agent-runner — normalizeMaxTurns and setDefaultMaxTurns", () => {
  it("normalizeMaxTurns(0) returns undefined (unlimited)", async () => {
    const { normalizeMaxTurns } = await import("../src/agent-runner.js");
    expect(normalizeMaxTurns(0)).toBeUndefined();
  });

  it("normalizeMaxTurns(undefined) returns undefined", async () => {
    const { normalizeMaxTurns } = await import("../src/agent-runner.js");
    expect(normalizeMaxTurns(undefined)).toBeUndefined();
  });

  it("normalizeMaxTurns(3) returns 3", async () => {
    const { normalizeMaxTurns } = await import("../src/agent-runner.js");
    expect(normalizeMaxTurns(3)).toBe(3);
  });

  it("setDefaultMaxTurns updates the default", async () => {
    const { setDefaultMaxTurns, getDefaultMaxTurns } = await import("../src/agent-runner.js");
    setDefaultMaxTurns(10);
    expect(getDefaultMaxTurns()).toBe(10);
    setDefaultMaxTurns(undefined);
    expect(getDefaultMaxTurns()).toBeUndefined();
  });
});

// Test resolveDefaultModel via the config.model path in runAgent
describe("agent-runner — config.model resolution", () => {
  it("uses config.model when getAgentConfig has a model field", async () => {
    const mockModel = { id: "gpt-4", provider: "openai" };
    vi.mocked(getAgentConfig).mockReturnValueOnce({
      name: "Explore",
      description: "Explore",
      builtinToolNames: ["read"],
      extensions: false,
      skills: false,
      systemPrompt: "You are Explore.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
      model: "openai/gpt-4",
    } as never);

    const ctxWithRegistry = {
      ...ctx,
      modelRegistry: {
        find: vi.fn().mockReturnValue(mockModel),
        getAvailable: vi.fn(() => [{ provider: "openai", id: "gpt-4" }]),
      },
    } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;

    const { session } = createSession("MODELRES");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctxWithRegistry, "Explore", "go", { pi });

    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: mockModel }),
    );
  });

  it("falls back to parent model when configured model is not in available list", async () => {
    const parentModel = { id: "claude-3", provider: "anthropic" };
    vi.mocked(getAgentConfig).mockReturnValueOnce({
      name: "Explore",
      description: "Explore",
      builtinToolNames: ["read"],
      extensions: false,
      skills: false,
      systemPrompt: "You are Explore.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
      model: "openai/gpt-4",
    } as never);

    const ctxWithModel = {
      ...ctx,
      model: parentModel,
      modelRegistry: {
        find: vi.fn().mockReturnValue({ id: "gpt-4", provider: "openai" }),
        // gpt-4 is NOT in available list
        getAvailable: vi.fn(() => [{ provider: "anthropic", id: "claude-3" }]),
      },
    } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;

    const { session } = createSession("FALLBACK-MODEL");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctxWithModel, "Explore", "go", { pi });

    // Should use parent model since gpt-4 is not available
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: parentModel }),
    );
  });

  it("handles config.model without slash (no provider prefix) gracefully", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce({
      name: "Explore",
      description: "Explore",
      builtinToolNames: ["read"],
      extensions: false,
      skills: false,
      systemPrompt: "You are Explore.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
      model: "gpt-4-no-slash",
    } as never);

    const { session } = createSession("NOSLASH");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    // "gpt-4-no-slash" has no "/" so resolveDefaultModel's slash-split branch is
    // skipped entirely and it returns parentModel (ctx.model = undefined).
    // Because model === undefined, the spread `...(model !== undefined ? { model } : {})`
    // emits no `model` key — assert the session was created without one.
    expect(createAgentSession).toHaveBeenCalledWith(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.not.objectContaining({ model: expect.anything() }),
    );
  });
});

// Test resolveDefaultModel: no getAvailable method and find returns undefined
describe("agent-runner — config.model resolution edge cases", () => {
  it("uses found model when registry.getAvailable is not a function", async () => {
    const mockModel = { id: "gpt-4", provider: "openai" };
    vi.mocked(getAgentConfig).mockReturnValueOnce({
      name: "Explore",
      description: "Explore",
      builtinToolNames: ["read"],
      extensions: false,
      skills: false,
      systemPrompt: "You are Explore.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
      model: "openai/gpt-4",
    } as never);

    const ctxNoGetAvail = {
      ...ctx,
      modelRegistry: {
        find: vi.fn().mockReturnValue(mockModel),
        // no getAvailable method
      },
    } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;

    const { session } = createSession("NOGETAVAIL");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctxNoGetAvail, "Explore", "go", { pi });
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: mockModel }),
    );
  });

  it("falls back to parent model when registry.find returns undefined", async () => {
    const parentModel = { id: "claude-3", provider: "anthropic" };
    vi.mocked(getAgentConfig).mockReturnValueOnce({
      name: "Explore",
      description: "Explore",
      builtinToolNames: ["read"],
      extensions: false,
      skills: false,
      systemPrompt: "You are Explore.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
      model: "openai/not-found",
    } as never);

    const ctxWithModel = {
      ...ctx,
      model: parentModel,
      modelRegistry: {
        find: vi.fn().mockReturnValue(undefined), // not found
        getAvailable: vi.fn(() => [{ provider: "openai", id: "gpt-4" }]),
      },
    } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;

    const { session } = createSession("NOTFOUND");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctxWithModel, "Explore", "go", { pi });
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ model: parentModel }),
    );
  });
});

describe("agent-runner — maxTurns with no limit", () => {
  it("no steer/abort when maxTurns is undefined (unlimited)", async () => {
    const { session, listeners } = createSession("UNLIMITED");
    createAgentSession.mockResolvedValue({ session });

    session.prompt = vi.fn(() => {
      // Fire many turn_end events
      for (let i = 0; i < 10; i++) {
        for (const l of listeners) l({ type: "turn_end" });
      }
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "UNLIMITED" }] });
    });

    const result = await runAgent(ctx, "Explore", "go", { pi, maxTurns: 0 }); // 0 = unlimited
    expect(session.steer).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(result.aborted).toBe(false);
    expect(result.steered).toBe(false);
  });
});

describe("agent-runner — resumeAgent with tool activity callback", () => {
  it("fires onToolActivity for tool events in resumeAgent", async () => {
    const { session, listeners } = createSession("TOOL-RESUME");
    const activities: Array<{ type: string; toolName: string }> = [];

    session.prompt = vi.fn(() => {
      for (const l of listeners) l({ type: "tool_execution_start", toolName: "bash" });
      for (const l of listeners) l({ type: "tool_execution_end", toolName: "bash" });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "TOOL-RESUME" }] });
    });

    await resumeAgent(session as unknown as import("@earendil-works/pi-coding-agent").AgentSession, "go", {
      onToolActivity: (a) => activities.push(a),
    });

    expect(activities).toEqual([
      { type: "start", toolName: "bash" },
      { type: "end", toolName: "bash" },
    ]);
  });
});

describe("agent-runner — getLastAssistantText fallback", () => {
  it("returns empty string when no assistant messages exist", async () => {
    const { session } = createSession(""); // empty finalText
    createAgentSession.mockResolvedValue({ session });

    // Override prompt to add NO assistant messages (only user messages)
    session.prompt = vi.fn(() => {
      session.messages.push({ role: "user", content: "question" });
    });

    const result = await runAgent(ctx, "Explore", "go", { pi });
    // Both collector (no text_delta) and getLastAssistantText (no assistant msg) return ""
    expect(result.responseText).toBe("");
  });
});

describe("agent-runner — extensions=true (not array, not false)", () => {
  it("does not filter tools to an allowlist when extensions=true", async () => {
    vi.mocked(getConfig).mockReturnValueOnce({
      displayName: "Explore",
      description: "Explore",
      builtinToolNames: ["read"],
      extensions: true, // Not false, not array
      skills: false,
      promptMode: "replace",
    } as never);
    vi.mocked(getAgentConfig).mockReturnValueOnce({
      name: "Explore",
      description: "Explore",
      builtinToolNames: ["read"],
      extensions: true,
      skills: false,
      systemPrompt: "You are Explore.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    } as never);

    const { session } = createSession("ALLTOOLS");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    // With extensions=true, builtin tools pass through; EXCLUDED_TOOL_NAMES are excluded
    const sessionCallOpts = createAgentSession.mock.calls.at(-1)?.[0] as { tools: string[] };
    expect(sessionCallOpts.tools).toContain("read");
    expect(sessionCallOpts.tools).not.toContain("Agent");
    // Mock loader returns no extensions so no ext tools — but builtin tools are kept
    expect(sessionCallOpts.tools).not.toContain("other-ext:tool");
  });
});

describe("agent-runner — agentConfig with maxTurns", () => {
  it("uses agentConfig.maxTurns when options.maxTurns is not set", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce({
      name: "Explore",
      description: "Explore",
      builtinToolNames: ["read"],
      extensions: false,
      skills: false,
      systemPrompt: "You are Explore.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
      maxTurns: 3,
    } as never);

    const { session, listeners } = createSession("TURNS");
    createAgentSession.mockResolvedValue({ session });
    const { setGraceTurns } = await import("../src/agent-runner.js");
    setGraceTurns(1);

    session.prompt = vi.fn(() => {
      // 3 turns = soft limit, then grace turn = abort
      for (const l of listeners) l({ type: "turn_end" });
      for (const l of listeners) l({ type: "turn_end" });
      for (const l of listeners) l({ type: "turn_end" }); // soft limit
      for (const l of listeners) l({ type: "turn_end" }); // abort
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "TURNS" }] });
    });

    const result = await runAgent(ctx, "Explore", "go", { pi });
    expect(result.aborted).toBe(true);
    setGraceTurns(5);
  });
});

describe("agent-runner — getAgentConversation all branches", () => {
  function fakeSession(messages: unknown[]) {
    return { messages } as never;
  }

  it("skips assistant messages with empty text content", () => {
    const out = getAgentConversation(
      fakeSession([
        { role: "assistant", content: [{ type: "text", text: "" }] }, // empty - should be skipped
        { role: "assistant", content: [{ type: "text", text: "final answer" }] },
      ]),
    );
    expect(out).toBe("[Assistant]: final answer");
  });
});

describe("agent-runner — runAgent disallowedSet excludes specified tools", () => {
  it("excludes EXCLUDED_TOOL_NAMES (Agent) even when extensions=true", async () => {
    vi.mocked(getConfig).mockReturnValueOnce({
      displayName: "Explore",
      description: "Explore",
      builtinToolNames: ["read"],
      extensions: true,
      skills: false,
      promptMode: "replace",
    } as never);
    vi.mocked(getAgentConfig).mockReturnValueOnce({
      name: "Explore",
      description: "Explore",
      builtinToolNames: ["read"],
      extensions: true,
      skills: false,
      systemPrompt: "You are Explore.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
      disallowedTools: ["bash"],
    } as never);

    const { session } = createSession("EXCL");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const sessionCallOpts = createAgentSession.mock.calls.at(-1)?.[0] as { tools: string[] };
    expect(sessionCallOpts.tools).not.toContain("Agent");
    expect(sessionCallOpts.tools).not.toContain("get_subagent_result");
    expect(sessionCallOpts.tools).not.toContain("bash"); // disallowed
    expect(sessionCallOpts.tools).toContain("read");
  });
});

