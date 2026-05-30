import { describe, expect, it } from "vitest";
import { WorkflowWidgetState } from "../src/widgetState.js";

const passthrough = {
	fg: (_: string, t: string) => t,
	dim: (t: string) => t,
	bold: (t: string) => t,
};

const NOW = 1_700_000_000_000;

function started(agentRunId: string, label = "myAgent", model = "claude:fast") {
	return {
		kind: "agent.started" as const,
		agentRunId,
		label,
		model,
		ts: NOW,
	};
}

function completed(agentRunId: string, turns = 3, tokens = 5000) {
	return {
		kind: "agent.completed" as const,
		agentRunId,
		turns,
		usage: { inputTokens: tokens, outputTokens: tokens },
		ts: NOW + 18_000,
	};
}

describe("WorkflowWidgetState", () => {
	it("isEmpty() returns true when no events received", () => {
		const state = new WorkflowWidgetState("plan");
		expect(state.isEmpty()).toBe(true);
	});

	it("agent.started adds a running entry; isEmpty becomes false", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1"));
		expect(state.isEmpty()).toBe(false);
	});

	it("agent.completed transitions status to completed, stores turns + tokens", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1"));
		state.update(completed("ar-1", 5, 7000));

		const lines = state.renderLines(200, 0, passthrough);
		// completed → ✓
		expect(lines.some((l) => l.includes("✓"))).toBe(true);
		// turns shown
		expect(lines.some((l) => l.includes("⟳5"))).toBe(true);
		// tokens shown: 7000 + 7000 = 14000 → 14.0k tok
		expect(lines.some((l) => l.includes("14.0k tok"))).toBe(true);
	});

	it("agent.failed transitions status to failed", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1"));
		state.update({ kind: "agent.failed", agentRunId: "ar-1", ts: NOW + 1000 });

		const lines = state.renderLines(200, 0, passthrough);
		expect(lines.some((l) => l.includes("✗"))).toBe(true);
	});

	it("agent.retried sets retries count", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1"));
		state.update({ kind: "agent.retried", agentRunId: "ar-1", attempt: 2, ts: NOW + 500 });

		const lines = state.renderLines(200, 0, passthrough);
		expect(lines.some((l) => l.includes("retry×2"))).toBe(true);
	});

	it("renderLines first line contains workflow:name", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1"));

		const lines = state.renderLines(200, 0, passthrough);
		expect(lines[0]).toContain("workflow:plan");
	});

	it("renderLines uses └─ for last entry and ├─ for non-last", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1", "scout"));
		state.update(started("ar-2", "planner"));

		const lines = state.renderLines(200, 0, passthrough);
		const headerLines = lines.filter((l) => l.includes("├─") || l.includes("└─"));
		expect(headerLines[0]).toContain("├─");
		expect(headerLines[1]).toContain("└─");
	});

	it("renderLines includes ✓ for completed and a spinner char for running", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1", "scout"));
		state.update(completed("ar-1"));
		state.update(started("ar-2", "planner"));

		const lines = state.renderLines(200, 0, passthrough);
		expect(lines.some((l) => l.includes("✓"))).toBe(true);
		// spinner frame 0 → "⠋"
		expect(lines.some((l) => l.includes("⠋"))).toBe(true);
	});

	it("renderLines includes token count when totalTokens > 0", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1"));
		state.update(completed("ar-1", 3, 7100));

		const lines = state.renderLines(200, 0, passthrough);
		// 7100 + 7100 = 14200 → 14.2k tok
		expect(lines.some((l) => l.includes("14.2k tok"))).toBe(true);
	});

	it("agent.usage updates token count for the running agent", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1"));
		state.update({
			kind: "agent.usage",
			agentRunId: "ar-1",
			usage: { inputTokens: 1000, outputTokens: 500 },
			ts: NOW + 100,
		});

		const lines = state.renderLines(200, 0, passthrough);
		// 1000 + 500 = 1500 → 1.5k tok
		expect(lines.some((l) => l.includes("1.5k tok"))).toBe(true);

		// Subsequent agent.usage replaces the running total (cumulative).
		state.update({
			kind: "agent.usage",
			agentRunId: "ar-1",
			usage: { inputTokens: 3200, outputTokens: 800 },
			ts: NOW + 200,
		});
		const lines2 = state.renderLines(200, 0, passthrough);
		expect(lines2.some((l) => l.includes("4.0k tok"))).toBe(true);
	});

	it("abortRunning changes running entries to failed", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1", "scout"));
		state.update(started("ar-2", "planner"));
		state.update(completed("ar-1")); // scout finishes

		state.abortRunning(); // planner still running → failed

		const lines = state.renderLines(200, 0, passthrough);
		// scout: ✓, planner: ✗
		const agentLines = lines.slice(1);
		expect(agentLines[0]).toContain("✓");
		expect(agentLines[1]).toContain("✗");
	});

	it("toolCalls increments on each agent.tool_call event", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1", "scout"));
		state.update({ kind: "agent.tool_call", agentRunId: "ar-1", toolName: "bash", inputPreview: "ls .", ts: NOW + 1000 });
		state.update({ kind: "agent.tool_call", agentRunId: "ar-1", toolName: "read", inputPreview: "src/foo.ts", ts: NOW + 2000 });

		const lines = state.renderLines(200, 0, passthrough);
		expect(lines.some((l) => l.includes("2 tools"))).toBe(true);
	});

	it("agent.tool_call shows grouped activity (single tool → verb only)", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1", "scout"));
		state.update({ kind: "agent.tool_call", agentRunId: "ar-1", toolName: "bash", toolCallId: "t1", inputPreview: "ls -la", ts: NOW + 1000 });

		const lines = state.renderLines(200, 0, passthrough);
		expect(lines.some((l) => l.includes("running command…"))).toBe(true);
	});

	it("agent.tool_call groups duplicates: 2x read → 'reading 2 files'", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1", "scout"));
		state.update({ kind: "agent.tool_call", agentRunId: "ar-1", toolName: "read", toolCallId: "t1", inputPreview: "a.ts", ts: NOW + 1000 });
		state.update({ kind: "agent.tool_call", agentRunId: "ar-1", toolName: "read", toolCallId: "t2", inputPreview: "b.ts", ts: NOW + 1100 });

		const lines = state.renderLines(200, 0, passthrough);
		expect(lines.some((l) => l.includes("reading 2 files"))).toBe(true);
	});

	it("agent.tool_call groups grep duplicates as 'searching N patterns'", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1", "scout"));
		state.update({ kind: "agent.tool_call", agentRunId: "ar-1", toolName: "grep", toolCallId: "t1", inputPreview: "foo", ts: NOW + 1000 });
		state.update({ kind: "agent.tool_call", agentRunId: "ar-1", toolName: "grep", toolCallId: "t2", inputPreview: "bar", ts: NOW + 1100 });
		state.update({ kind: "agent.tool_call", agentRunId: "ar-1", toolName: "grep", toolCallId: "t3", inputPreview: "baz", ts: NOW + 1200 });

		const lines = state.renderLines(200, 0, passthrough);
		expect(lines.some((l) => l.includes("searching 3 patterns"))).toBe(true);
	});

	it("agent.tool_end removes the tool from active set", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1", "scout"));
		state.update({ kind: "agent.tool_call", agentRunId: "ar-1", toolName: "read", toolCallId: "t1", inputPreview: "a.ts", ts: NOW + 1000 });
		state.update({ kind: "agent.tool_call", agentRunId: "ar-1", toolName: "read", toolCallId: "t2", inputPreview: "b.ts", ts: NOW + 1100 });
		state.update({ kind: "agent.tool_end", agentRunId: "ar-1", toolCallId: "t1", ts: NOW + 1200 });

		const lines = state.renderLines(200, 0, passthrough);
		// Only one read remaining → bare "reading…" (not "reading 2 files")
		expect(lines.some((l) => l.includes("reading…"))).toBe(true);
		expect(lines.some((l) => l.includes("reading 2 files"))).toBe(false);
	});

	it("falls back to 'thinking…' when no active tools and no response text", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1", "scout"));

		const lines = state.renderLines(200, 0, passthrough);
		expect(lines.some((l) => l.includes("thinking…"))).toBe(true);
	});

	it("latestAction is updated by agent.output event", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1", "scout"));
		state.update({ kind: "agent.tool_call", agentRunId: "ar-1", toolName: "bash", inputPreview: "ls .", ts: NOW + 1000 });
		state.update({ kind: "agent.output", agentRunId: "ar-1", preview: "Here is my analysis of the codebase", ts: NOW + 2000 });

		const lines = state.renderLines(200, 0, passthrough);
		expect(lines.some((l) => l.includes("Here is my analysis of the codebase"))).toBe(true);
		// tool call line should no longer be latest action
		expect(lines.some((l) => l.includes("bash: ls ."))).toBe(false);
	});

	it("renderLines includes 'tools' in the output when toolCalls > 0", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1", "scout"));
		state.update({ kind: "agent.tool_call", agentRunId: "ar-1", toolName: "find", inputPreview: "*.ts in .", ts: NOW + 1000 });

		const lines = state.renderLines(200, 0, passthrough);
		expect(lines.some((l) => l.includes("tools"))).toBe(true);
	});

	it("renderLines includes '⎿' sub-line when latestAction is set", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1", "scout"));
		state.update({ kind: "agent.tool_call", agentRunId: "ar-1", toolName: "bash", inputPreview: "find . -name *.ts", ts: NOW + 1000 });

		const lines = state.renderLines(200, 0, passthrough);
		expect(lines.some((l) => l.includes("⎿"))).toBe(true);
	});

	it("agent.retried resets status to running", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1"));
		state.update({ kind: "agent.failed", agentRunId: "ar-1", ts: NOW + 1000 });
		// Simulate retry: agent.retried should flip status back to "running"
		state.update({ kind: "agent.retried", agentRunId: "ar-1", attempt: 1, ts: NOW + 1500 });

		const lines = state.renderLines(200, 0, passthrough);
		// status should now be running → spinner char, not ✗
		expect(lines.some((l) => l.includes("⠋"))).toBe(true);
		expect(lines.some((l) => l.includes("✗"))).toBe(false);
	});

	it("agent.retried clears active tools", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1"));
		state.update({ kind: "agent.tool_call", agentRunId: "ar-1", toolName: "bash", toolCallId: "t1", inputPreview: "ls .", ts: NOW + 1000 });
		expect(state.renderLines(200, 0, passthrough).some((l) => l.includes("running command…"))).toBe(true);

		state.update({ kind: "agent.retried", agentRunId: "ar-1", attempt: 1, ts: NOW + 1500 });
		// After retry: active tools cleared, falls back to "thinking…"
		const after = state.renderLines(200, 0, passthrough);
		expect(after.some((l) => l.includes("running command…"))).toBe(false);
		expect(after.some((l) => l.includes("thinking…"))).toBe(true);
	});

	it("renderLines uses '│    ' indent for non-last entries and '     ' for last", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1", "scout"));
		state.update(started("ar-2", "planner"));
		state.update({ kind: "agent.tool_call", agentRunId: "ar-1", toolName: "bash", inputPreview: "ls -la .worktrees", ts: NOW + 1000 });
		state.update({ kind: "agent.tool_call", agentRunId: "ar-2", toolName: "bash", inputPreview: "find . -name *.ts", ts: NOW + 2000 });

		const lines = state.renderLines(200, 0, passthrough);
		const actionLines = lines.filter((l) => l.includes("⎿"));
		expect(actionLines).toHaveLength(2);
		// scout is non-last → pipe indent
		expect(actionLines[0]).toMatch(/^│    /);
		// planner is last → space indent
		expect(actionLines[1]).toMatch(/^     /);
	});

	it("agent.session stores sessionId but does not set latestAction", () => {
		const state = new WorkflowWidgetState("plan");
		state.update(started("ar-1", "scout"));
		state.update({ kind: "agent.session", agentRunId: "ar-1", label: "scout", sessionId: "sess-xyz", ts: NOW + 10 });

		const lines = state.renderLines(200, 0, passthrough);
		// Session ID is surfaced in chat (display:true), not in the widget sub-line.
		expect(lines.some((l) => l.includes("session: sess-xyz"))).toBe(false);
	});
});
