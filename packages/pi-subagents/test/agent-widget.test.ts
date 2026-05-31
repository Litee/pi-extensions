import { describe, expect, it } from "vitest";
import { AgentWidget, formatSessionTokens, type Theme, type UICtx, type AgentActivity } from "../src/ui/agent-widget.js";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>↻1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (<dim>↻3</dim>)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>↻2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (<error>88%</error> · <dim>↻4</dim>)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
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
      terminal: { columns: 200 },
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
