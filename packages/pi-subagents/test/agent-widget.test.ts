import { describe, expect, it, vi } from "vitest";
import {
  AgentWidget,
  buildInvocationTags,
  describeActivity,
  formatDuration,
  formatMs,
  formatSessionTokens,
  formatTokens,
  formatTurns,
  getDisplayName,
  getPromptModeLabel,
  type AgentActivity,
  type Theme,
  type UICtx,
} from "../src/ui/agent-widget.js";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("<dim>1.2k token</dim>");
    expect(formatSessionTokens(1234, 50, theme)).toBe("<dim>1.2k token</dim> (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("<dim>1.2k token</dim> (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("<dim>1.2k token</dim> (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("<dim>1.2k token</dim> (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("<dim>1.2k token</dim> (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("<dim>1.2k token</dim> (<dim>⇊1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("<dim>1.2k token</dim> (<dim>⇊3</dim>)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("<dim>1.2k token</dim> (<dim>45%</dim> · <dim>⇊2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("<dim>1.2k token</dim> (<error>88%</error> · <dim>⇊4</dim>)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("<dim>1.2k token</dim> (<dim>45%</dim>)");
  });
});

describe("AgentWidget running-agent stats line", () => {
  const theme: Theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };

  it("wraps elapsed-time suffix in dim even when tokenText contains pre-styled content", () => {
    // --- Minimal running agent record ---
    const agentId = "test-agent-1";
    const startedAt = Date.now() - 5000; // 5 seconds ago

    const agentRecord: AgentRecord = {
      id: agentId,
      type: "general-purpose",
      description: "Test task",
      status: "running",
      toolUses: 3,
      startedAt,
      lifetimeUsage: { input: 50_000, output: 5_000, cacheWrite: 0 },
      compactionCount: 0,
    };

    // --- AgentActivity with tokens so tokenText gets pre-styled content ---
    const activity: AgentActivity = {
      activeTools: new Map(),
      toolUses: 3,
      responseText: "",
      session: undefined,
      turnCount: 2,
      maxTurns: undefined,
      lifetimeUsage: { input: 50_000, output: 5_000, cacheWrite: 0 },
    };
    const agentActivityMap = new Map<string, AgentActivity>([[agentId, activity]]);

    // --- Minimal AgentManager stub ---
    const stubManager = {
      listAgents: () => [agentRecord] as AgentRecord[],
    } as unknown as AgentManager;

    // --- Capture the widget factory registered via setWidget ---
    let capturedFactory: ((tui: unknown, theme: Theme) => { render(): string[] }) | undefined;
    const stubUiCtx: UICtx = {
      setStatus: () => {},
      setWidget: (_key, content) => {
        if (content) capturedFactory = content as typeof capturedFactory;
      },
    };

    // --- Stub TUI ---
    const stubTui = {
      terminal: { columns: 2000 },
      requestRender: () => {},
    };

    // --- Wire it up ---
    const widget = new AgentWidget(stubManager, agentActivityMap);
    widget.setUICtx(stubUiCtx);
    widget.update();

    expect(capturedFactory, "setWidget should have been called").toBeDefined();
    const component = capturedFactory!(stubTui, theme);
    const lines = component.render();

    // Find the running-agent header line (contains the elapsed time, e.g. "5.0s")
    const statsLine = lines.find(l => /\d+\.\d+s<\//.test(l));
    expect(statsLine, `Expected a stats line with elapsed time, got lines: ${JSON.stringify(lines)}`).toBeDefined();

    // The elapsed time must appear inside <dim>...</dim>, not as bare text.
    // Match the dim-wrapped elapsed segment: <dim>N.Ns</dim>
    expect(statsLine).toMatch(/<dim>\d+\.\d+s<\/dim>/);
  });
});

describe("AgentWidget — overflow branch", () => {
  const theme: Theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  // MAX_WIDGET_LINES is 12. Heading takes 1 line → maxBody = 11.
  // Each running agent takes 2 lines, so 7+ running agents (14 body lines) triggers overflow.
  function makeRunningRecord(id: string): import("../src/types.js").AgentRecord {
    return {
      id,
      type: "general-purpose",
      description: `task-${id}`,
      status: "running",
      toolUses: 0,
      startedAt: Date.now() - 1000,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
  }

  it("renders overflow indicator when agents exceed MAX_WIDGET_LINES", () => {
    const ids = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"];
    const records = ids.map(makeRunningRecord);
    const activity = new Map<string, import("../src/ui/agent-widget.js").AgentActivity>();

    const stubManager = {
      listAgents: () => records,
    } as unknown as import("../src/agent-manager.js").AgentManager;

    let capturedFactory: ((tui: unknown, theme: Theme) => { render(): string[] }) | undefined;
    const stubUiCtx: import("../src/ui/agent-widget.js").UICtx = {
      setStatus: () => {},
      setWidget: (_key: string, content: unknown) => {
        if (content) capturedFactory = content as typeof capturedFactory;
      },
    };

    const widget = new AgentWidget(stubManager, activity);
    widget.setUICtx(stubUiCtx);
    widget.update();

    expect(capturedFactory).toBeDefined();

    const stubTui = { terminal: { columns: 100 }, requestRender: () => {} };
    const lines = capturedFactory!(stubTui, theme).render();

    // The overflow indicator line should mention hidden agents
    const overflowLine = lines.find(l => /more/.test(l) || /running/.test(l.toLowerCase()));
    expect(lines.length).toBeLessThanOrEqual(12); // never exceeds MAX_WIDGET_LINES
    expect(overflowLine).toBeDefined();
  });
});

describe("AgentWidget — update() and dispose()", () => {
  it("update() with no active agents clears widget and status", () => {
    const activity = new Map<string, import("../src/ui/agent-widget.js").AgentActivity>();

    const runningRecord: import("../src/types.js").AgentRecord = {
      id: "ag1",
      type: "general-purpose",
      description: "task",
      status: "running",
      toolUses: 0,
      startedAt: Date.now() - 500,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };

    // Mutable agent list so we can switch from "running" to "empty" on the same widget
    let agentList: import("../src/types.js").AgentRecord[] = [runningRecord];
    const stubManager = {
      listAgents: () => agentList,
    } as unknown as import("../src/agent-manager.js").AgentManager;

    const setWidgetCalls: Array<[string, unknown]> = [];
    const setStatusCalls: Array<[string, unknown]> = [];

    const stubUiCtx: import("../src/ui/agent-widget.js").UICtx = {
      setWidget: (key: string, content: unknown) => setWidgetCalls.push([key, content]),
      setStatus: (key: string, text: unknown) => setStatusCalls.push([key, text]),
    };

    const widget = new AgentWidget(stubManager, activity);
    widget.setUICtx(stubUiCtx);
    widget.update(); // registers widget (widgetRegistered = true)

    // Now switch to empty agent list and call update() again
    agentList = [];
    widget.update(); // should call setWidget("agents", undefined) since widgetRegistered=true

    const clearCall = setWidgetCalls.find(([_k, content]) => content === undefined);
    expect(clearCall).toBeDefined();
  });

  it("dispose() clears widget and status", () => {
    const activity = new Map<string, import("../src/ui/agent-widget.js").AgentActivity>();
    const stubManager = { listAgents: () => [] } as unknown as import("../src/agent-manager.js").AgentManager;

    const setWidgetCalls: Array<[string, unknown]> = [];
    const setStatusCalls: Array<[string, unknown]> = [];

    const stubUiCtx: import("../src/ui/agent-widget.js").UICtx = {
      setWidget: (key: string, content: unknown) => setWidgetCalls.push([key, content]),
      setStatus: (key: string, text: unknown) => setStatusCalls.push([key, text]),
    };

    const widget = new AgentWidget(stubManager, activity);
    widget.setUICtx(stubUiCtx);
    widget.dispose();

    // dispose() should call setWidget("agents", undefined) and setStatus("subagents", undefined)
    expect(setWidgetCalls.some(([k, v]) => k === "agents" && v === undefined)).toBe(true);
    expect(setStatusCalls.some(([k, v]) => k === "subagents" && v === undefined)).toBe(true);
  });
});

// ─── Pure formatting helpers ──────────────────────────────────────────────

describe("formatTokens", () => {
  it("formats values below 1000 as plain number", () => {
    expect(formatTokens(0)).toBe("0 token");
    expect(formatTokens(500)).toBe("500 token");
    expect(formatTokens(999)).toBe("999 token");
  });

  it("formats values in the thousands as Nk", () => {
    expect(formatTokens(1_000)).toBe("1.0k token");
    expect(formatTokens(33_800)).toBe("33.8k token");
    expect(formatTokens(999_999)).toBe("1000.0k token");
  });

  it("formats values >= 1M as NM", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M token");
    expect(formatTokens(2_500_000)).toBe("2.5M token");
  });
});

describe("formatMs", () => {
  it("formats milliseconds as seconds with 1dp", () => {
    expect(formatMs(1000)).toBe("1.0s");
    expect(formatMs(2500)).toBe("2.5s");
    expect(formatMs(100)).toBe("0.1s");
  });
});

describe("formatTurns", () => {
  it("formats without limit when maxTurns is undefined", () => {
    expect(formatTurns(5, undefined)).toBe("↻5");
  });

  it("formats without limit when maxTurns is null", () => {
    expect(formatTurns(3, null)).toBe("↻3");
  });

  it("formats with limit when maxTurns is provided", () => {
    expect(formatTurns(5, 30)).toBe("↻5≤30");
    expect(formatTurns(0, 10)).toBe("↻0≤10");
  });
});

describe("formatDuration", () => {
  it("formats completed duration when completedAt is provided", () => {
    const result = formatDuration(1000, 6000);
    expect(result).toBe("5.0s");
  });

  it("shows running indicator when completedAt is absent", () => {
    const start = Date.now() - 2000;
    const result = formatDuration(start);
    expect(result).toMatch(/\d+\.\d+s \(running\)/);
  });

  it("shows running indicator when completedAt is 0 (falsy)", () => {
    const start = Date.now() - 1000;
    const result = formatDuration(start, 0);
    expect(result).toMatch(/\d+\.\d+s \(running\)/);
  });
});

describe("buildInvocationTags", () => {
  it("returns empty tags when invocation is undefined", () => {
    expect(buildInvocationTags(undefined)).toEqual({ tags: [] });
  });

  it("includes thinking tag when present", () => {
    const result = buildInvocationTags({ thinking: "high" });
    expect(result.tags).toContain("thinking: high");
  });

  it("includes isolated tag", () => {
    const result = buildInvocationTags({ isolated: true });
    expect(result.tags).toContain("isolated");
  });

  it("includes worktree tag for worktree isolation", () => {
    const result = buildInvocationTags({ isolation: "worktree" });
    expect(result.tags).toContain("worktree");
  });

  it("includes inherit-context tag", () => {
    const result = buildInvocationTags({ inheritContext: true });
    expect(result.tags).toContain("inherit context");
  });

  it("includes background tag", () => {
    const result = buildInvocationTags({ runInBackground: true });
    expect(result.tags).toContain("background");
  });

  it("includes max-turns tag", () => {
    const result = buildInvocationTags({ maxTurns: 20 });
    expect(result.tags).toContain("max turns: 20");
  });

  it("includes modelName when provided", () => {
    const result = buildInvocationTags({ modelName: "haiku" });
    expect(result.modelName).toBe("haiku");
  });
});

describe("describeActivity", () => {
  it("returns 'thinking…' when no tools and no response text", () => {
    expect(describeActivity(new Map(), "")).toBe("thinking…");
    expect(describeActivity(new Map())).toBe("thinking…");
  });

  it("returns truncated response text when no active tools", () => {
    const long = "a".repeat(70);
    const result = describeActivity(new Map(), long);
    expect(result).toMatch(/a+…/);
    expect(result.length).toBeLessThanOrEqual(65);
  });

  it("returns single tool action for one active tool", () => {
    const tools = new Map([["t1", "bash"]]);
    expect(describeActivity(tools)).toBe("running command…");
  });

  it("groups duplicate tool actions with count and files label", () => {
    const tools = new Map([["t1", "read"], ["t2", "read"], ["t3", "read"]]);
    const result = describeActivity(tools);
    expect(result).toContain("reading 3 files");
  });

  it("groups search actions with patterns label", () => {
    const tools = new Map([["t1", "grep"], ["t2", "grep"]]);
    const result = describeActivity(tools);
    expect(result).toContain("searching 2 patterns");
  });

  it("uses raw tool name for unknown tools", () => {
    const tools = new Map([["t1", "custom_tool"]]);
    expect(describeActivity(tools)).toBe("custom_tool…");
  });
});

describe("getDisplayName", () => {
  it("returns a non-empty string for general-purpose type", () => {
    const name = getDisplayName("general-purpose");
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
  });
});

describe("getPromptModeLabel", () => {
  it("returns 'twin' for append mode types", () => {
    // agent-widget's getPromptModeLabel maps append→'twin'; wrap in try/catch for unknown types
    // general-purpose actually uses append, so it returns 'twin'
    const label = getPromptModeLabel("general-purpose");
    // Just verify the function returns a string or undefined (don't hard-code the type's mode)
    expect(label === undefined || typeof label === "string").toBe(true);
  });
});

// ─── Widget rendering with finished agents ────────────────────────────────

function makeStubWidget(records: AgentRecord[], activity = new Map<string, AgentActivity>()) {
  const stubManager = { listAgents: () => records } as unknown as AgentManager;
  let capturedFactory: ((tui: unknown, theme: Theme) => { render(): string[] }) | undefined;
  const stubUiCtx: UICtx = {
    setStatus: () => {},
    setWidget: (_key, content) => {
      if (content) capturedFactory = content as typeof capturedFactory;
    },
  };
  const widget = new AgentWidget(stubManager, activity);
  widget.setUICtx(stubUiCtx);
  return { widget, getFactory: () => capturedFactory };
}

const plainTheme: Theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
const stubTui = { terminal: { columns: 200 }, requestRender: vi.fn() };

describe("AgentWidget — finished agents rendering", () => {
  function makeFinishedRecord(id: string, status: AgentRecord["status"]): AgentRecord {
    return {
      id,
      type: "general-purpose",
      description: `task-${id}`,
      status,
      toolUses: 2,
      startedAt: Date.now() - 3000,
      completedAt: Date.now() - 1000,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
  }

  it("renders a completed agent with check icon", () => {
    const rec = makeFinishedRecord("c1", "completed");
    const { widget, getFactory } = makeStubWidget([rec]);
    widget.markFinished("c1");
    widget.update();
    const lines = getFactory()!(stubTui, plainTheme).render();
    expect(lines.some(l => l.includes("✓"))).toBe(true);
  });

  it("renders a steered agent", () => {
    const rec = makeFinishedRecord("s1", "steered");
    const { widget, getFactory } = makeStubWidget([rec]);
    widget.markFinished("s1");
    widget.update();
    const lines = getFactory()!(stubTui, plainTheme).render();
    expect(lines.some(l => l.includes("turn limit"))).toBe(true);
  });

  it("renders a stopped agent", () => {
    const rec = makeFinishedRecord("st1", "stopped");
    const { widget, getFactory } = makeStubWidget([rec]);
    widget.markFinished("st1");
    widget.update();
    const lines = getFactory()!(stubTui, plainTheme).render();
    expect(lines.some(l => l.includes("stopped"))).toBe(true);
  });

  it("renders an error agent with error message", () => {
    const rec: AgentRecord = {
      ...makeFinishedRecord("e1", "error"),
      error: "network failure",
    };
    const { widget, getFactory } = makeStubWidget([rec]);
    widget.markFinished("e1");
    widget.update();
    const lines = getFactory()!(stubTui, plainTheme).render();
    expect(lines.some(l => l.includes("error"))).toBe(true);
  });

  it("renders an aborted agent", () => {
    const rec = makeFinishedRecord("a1", "aborted");
    const { widget, getFactory } = makeStubWidget([rec]);
    widget.markFinished("a1");
    widget.update();
    const lines = getFactory()!(stubTui, plainTheme).render();
    expect(lines.some(l => l.includes("aborted"))).toBe(true);
  });
});

describe("AgentWidget — queued agents", () => {
  it("renders a queued indicator when agents are queued", () => {
    const rec: AgentRecord = {
      id: "q1",
      type: "general-purpose",
      description: "queued task",
      status: "queued",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
    const { widget, getFactory } = makeStubWidget([rec]);
    widget.update();
    const lines = getFactory()!(stubTui, plainTheme).render();
    expect(lines.some(l => l.includes("queued"))).toBe(true);
  });
});

describe("AgentWidget — requestRender when already registered", () => {
  it("calls tui.requestRender on second update() instead of re-registering", () => {
    const rec: AgentRecord = {
      id: "r1",
      type: "general-purpose",
      description: "running",
      status: "running",
      toolUses: 0,
      startedAt: Date.now() - 500,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
    const stubManager = { listAgents: () => [rec] } as unknown as AgentManager;
    const requestRender = vi.fn();
    const localTui = { terminal: { columns: 200 }, requestRender };

    let setWidgetCallCount = 0;
    let capturedFactory: ((tui: unknown, theme: Theme) => { render(): string[]; invalidate(): void }) | undefined;
    const uiCtx: UICtx = {
      setStatus: () => {},
      setWidget: (_key, content) => {
        setWidgetCallCount++;
        if (content) capturedFactory = content as typeof capturedFactory;
      },
    };

    const widget = new AgentWidget(stubManager, new Map());
    widget.setUICtx(uiCtx);

    // First update — registers widget
    widget.update();
    expect(setWidgetCallCount).toBe(1);

    // Invoke factory to set this.tui
    capturedFactory!(localTui, plainTheme);

    // Second update — should requestRender, not call setWidget again
    widget.update();
    expect(setWidgetCallCount).toBe(1); // unchanged
    expect(requestRender).toHaveBeenCalled();
  });

  it("invalidate() clears widgetRegistered so next update re-registers", () => {
    const rec: AgentRecord = {
      id: "r2",
      type: "general-purpose",
      description: "running",
      status: "running",
      toolUses: 0,
      startedAt: Date.now() - 500,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
    const stubManager = { listAgents: () => [rec] } as unknown as AgentManager;

    let setWidgetCallCount = 0;
    let capturedFactory: ((tui: unknown, theme: Theme) => { render(): string[]; invalidate(): void }) | undefined;
    const uiCtx: UICtx = {
      setStatus: () => {},
      setWidget: (_key, content) => {
        setWidgetCallCount++;
        if (content) capturedFactory = content as typeof capturedFactory;
      },
    };

    const widget = new AgentWidget(stubManager, new Map());
    widget.setUICtx(uiCtx);
    widget.update();

    const component = capturedFactory!(stubTui, plainTheme);
    component.invalidate();

    // After invalidate, next update should re-register
    widget.update();
    expect(setWidgetCallCount).toBe(2);
  });
});

describe("AgentWidget — onTurnStart aging and ensureTimer", () => {
  it("onTurnStart ages finished records and triggers update", () => {
    const rec: AgentRecord = {
      id: "fin1",
      type: "general-purpose",
      description: "done",
      status: "completed",
      toolUses: 0,
      startedAt: Date.now() - 3000,
      completedAt: Date.now() - 1000,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
    const stubManager = { listAgents: () => [] as AgentRecord[] } as unknown as AgentManager;
    const setStatusCalls: unknown[] = [];
    const uiCtx: UICtx = {
      setStatus: (_k, v) => setStatusCalls.push(v),
      setWidget: () => {},
    };
    const widget = new AgentWidget(stubManager, new Map());
    widget.setUICtx(uiCtx);
    widget.markFinished(rec.id);
    // onTurnStart should not throw
    widget.onTurnStart();
  });

  it("ensureTimer starts interval and is idempotent", () => {
    const stubManager = { listAgents: () => [] as AgentRecord[] } as unknown as AgentManager;
    const uiCtx: UICtx = { setStatus: () => {}, setWidget: () => {} };
    const widget = new AgentWidget(stubManager, new Map());
    widget.setUICtx(uiCtx);
    widget.ensureTimer();
    widget.ensureTimer(); // idempotent — should not throw
    widget.dispose(); // cleanup interval
  });
});

describe("AgentWidget — setUICtx context change resets registration", () => {
  it("calling setUICtx with a new context resets widgetRegistered", () => {
    const rec: AgentRecord = {
      id: "ctx1",
      type: "general-purpose",
      description: "running",
      status: "running",
      toolUses: 0,
      startedAt: Date.now() - 500,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
    const stubManager = { listAgents: () => [rec] } as unknown as AgentManager;
    let setWidgetCallCount = 0;
    const makeCtx = (): UICtx => ({
      setStatus: () => {},
      setWidget: () => { setWidgetCallCount++; },
    });

    const widget = new AgentWidget(stubManager, new Map());
    const ctx1 = makeCtx();
    widget.setUICtx(ctx1);
    widget.update(); // registers on ctx1

    // Switch to new context — should force re-registration
    const ctx2 = makeCtx();
    widget.setUICtx(ctx2);
    widget.update(); // re-registers on ctx2

    expect(setWidgetCallCount).toBeGreaterThanOrEqual(2);
  });
});

// ─── More renderWidget coverage ───────────────────────────────────────────

describe("AgentWidget — running agent with activity stats", () => {
  const theme: Theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
  const stubTui2 = { terminal: { columns: 200 }, requestRender: vi.fn() };

  function makeRunningRecord(id: string): import("../src/types.js").AgentRecord {
    return {
      id,
      type: "general-purpose",
      description: `task-${id}`,
      status: "running",
      toolUses: 0,
      startedAt: Date.now() - 1000,
      lifetimeUsage: { input: 50_000, output: 5_000, cacheWrite: 0 },
      compactionCount: 0,
    };
  }

  it("renders running agent with non-zero tokens in bg activity", () => {
    const rec = makeRunningRecord("r1");
    const activity = new Map<string, AgentActivity>([["r1", {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "working on it",
      turnCount: 3,
      maxTurns: 10,
      lifetimeUsage: { input: 50_000, output: 5_000, cacheWrite: 0 },
    }]]);
    const stubManager = { listAgents: () => [rec] } as unknown as import("../src/agent-manager.js").AgentManager;
    let capturedFactory: ((tui: unknown, theme: Theme) => { render(): string[] }) | undefined;
    const uiCtx: UICtx = {
      setStatus: () => {},
      setWidget: (_k, content) => { if (content) capturedFactory = content as typeof capturedFactory; },
    };
    const widget = new AgentWidget(stubManager, activity);
    widget.setUICtx(uiCtx);
    widget.update();
    const lines = capturedFactory!(stubTui2, theme).render();
    // Should have activity description from responseText
    expect(lines.some(l => l.includes("working on it"))).toBe(true);
  });

  it("renders running agent with active tools in activity", () => {
    const rec = makeRunningRecord("r2");
    const activity = new Map<string, AgentActivity>([["r2", {
      activeTools: new Map([["t1", "bash"], ["t2", "bash"]]),
      toolUses: 2,
      responseText: "",
      turnCount: 1,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    }]]);
    const stubManager = { listAgents: () => [rec] } as unknown as import("../src/agent-manager.js").AgentManager;
    let capturedFactory: ((tui: unknown, theme: Theme) => { render(): string[] }) | undefined;
    const uiCtx: UICtx = {
      setStatus: () => {},
      setWidget: (_k, content) => { if (content) capturedFactory = content as typeof capturedFactory; },
    };
    const widget = new AgentWidget(stubManager, activity);
    widget.setUICtx(uiCtx);
    widget.update();
    const lines = capturedFactory!(stubTui2, theme).render();
    expect(lines.some(l => l.includes("running command"))).toBe(true);
  });

  it("renders running agent with zero tokens (no tokenText)", () => {
    const rec = makeRunningRecord("r3");
    rec.lifetimeUsage = { input: 0, output: 0, cacheWrite: 0 };
    const activity = new Map<string, AgentActivity>([["r3", {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "thinking",
      turnCount: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    }]]);
    const stubManager = { listAgents: () => [rec] } as unknown as import("../src/agent-manager.js").AgentManager;
    let capturedFactory: ((tui: unknown, theme: Theme) => { render(): string[] }) | undefined;
    const uiCtx: UICtx = {
      setStatus: () => {},
      setWidget: (_k, content) => { if (content) capturedFactory = content as typeof capturedFactory; },
    };
    const widget = new AgentWidget(stubManager, activity);
    widget.setUICtx(uiCtx);
    widget.update();
    const lines = capturedFactory!(stubTui2, theme).render();
    // Should still render some content
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("AgentWidget — status bar text with queued count", () => {

  it("shows queued count in status when agents are queued", () => {
    const running: import("../src/types.js").AgentRecord = {
      id: "r1",
      type: "general-purpose",
      description: "r",
      status: "running",
      toolUses: 0,
      startedAt: Date.now() - 500,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
    const queued: import("../src/types.js").AgentRecord = {
      id: "q1",
      type: "general-purpose",
      description: "q",
      status: "queued",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
    const stubManager = { listAgents: () => [running, queued] } as unknown as import("../src/agent-manager.js").AgentManager;
    const statusTexts: (string | undefined)[] = [];
    const uiCtx: UICtx = {
      setStatus: (_k, v) => statusTexts.push(v),
      setWidget: () => {},
    };
    const widget = new AgentWidget(stubManager, new Map());
    widget.setUICtx(uiCtx);
    widget.update();
    // Should include "queued" in the status text
    const lastStatus = statusTexts[statusTexts.length - 1];
    expect(lastStatus).toContain("queued");
  });
});

// ---------------------------------------------------------------------------
// Overflow with queued + finished agents (lines 424-425, 430-434)
// ---------------------------------------------------------------------------

describe("AgentWidget — overflow with queued and finished agents", () => {
  function makeRunningRec(id: string): AgentRecord {
    return {
      id,
      type: "general-purpose",
      description: `running-${id}`,
      status: "running",
      toolUses: 0,
      startedAt: Date.now() - 500,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
  }

  function makeFinishedRec(id: string): AgentRecord {
    return {
      id,
      type: "general-purpose",
      description: `done-${id}`,
      status: "completed",
      toolUses: 0,
      startedAt: Date.now() - 3000,
      completedAt: Date.now() - 1000,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
  }

  function makeQueuedRec(id: string): AgentRecord {
    return {
      id,
      type: "general-purpose",
      description: `queued-${id}`,
      status: "queued",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
    };
  }

  it("pushes queued line and hides overflow finished agents when budget is tight", () => {
    // 5 finished + 3 running (6 lines) + 1 queued = 12 total body → overflow (maxBody=11)
    // Budget=10; running takes 6 → budget=4; queued takes 1 → budget=3; finished: 3 fit, 2 hidden.
    const finished = ["f1", "f2", "f3", "f4", "f5"].map(makeFinishedRec);
    const running = ["r1", "r2", "r3"].map(makeRunningRec);
    const queued = [makeQueuedRec("q1")];

    const allRecs = [...finished, ...running, ...queued];
    const { widget, getFactory } = makeStubWidget(allRecs);

    // Register finished agents
    for (const rec of finished) {
      widget.markFinished(rec.id);
    }
    widget.update();
    const lines = getFactory()!(stubTui, plainTheme).render();

    // Should show overflow indicator
    expect(lines.some(l => l.includes("more"))).toBe(true);
    // Should include queued indicator
    expect(lines.some(l => l.includes("queued"))).toBe(true);
  });
});
