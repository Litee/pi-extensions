/**
 * Pure state + render logic for the workflow agent widget.
 * No TUI or pi imports — fully unit-testable.
 */

const SPINNER_FRAMES = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"] as const;

/** Narrow theme slice we use — matches the real pi theme structurally. */
export interface WidgetTheme {
	fg(colorName: string, text: string): string;
	dim(text: string): string;
	bold(text: string): string;
}

export interface WidgetTui {
	requestRender(): void;
}

export interface WidgetComponent {
	render(width: number): string[];
	invalidate(): void;
	dispose?(): void;
}

/** Tool name → human-readable verb (matches @tintinweb/pi-subagents). */
const TOOL_DISPLAY: Record<string, string> = {
	read:  "reading",
	bash:  "running command",
	edit:  "editing",
	write: "writing",
	grep:  "searching",
	find:  "finding files",
	ls:    "listing",
};

interface AgentEntry {
	agentRunId: string;
	label: string;
	model: string;
	sandbox?: string;
	status: "running" | "completed" | "failed" | "blocked";
	startedAt: number;
	endedAt?: number;
	turns?: number;
	totalTokens: number;
	retries: number;
	toolCalls: number;
	timeoutMinutes?: number;
	/** Currently-running tools, keyed by toolCallId. */
	activeTools: Map<string, string>;
	latestResponseText?: string;
	sessionId?: string;
}

/**
 * Build a human-readable activity string from currently-running tools or
 * the last response preview.
 *
 *   activeTools = { id1: "read", id2: "read", id3: "grep" }
 *   → "reading 2 files, searching…"
 */
export function describeActivity(
	activeTools: Map<string, string>,
	latestResponseText: string | undefined,
): string {
	if (activeTools.size > 0) {
		const groups = new Map<string, number>();
		for (const toolName of activeTools.values()) {
			const action = TOOL_DISPLAY[toolName] ?? toolName;
			groups.set(action, (groups.get(action) ?? 0) + 1);
		}
		const parts: string[] = [];
		for (const [action, count] of groups) {
			if (count > 1) {
				const noun = action === "searching" ? "patterns" : "files";
				parts.push(`${action} ${String(count)} ${noun}`);
			} else {
				parts.push(action);
			}
		}
		return parts.join(", ") + "…";
	}
	if (latestResponseText !== undefined && latestResponseText.trim().length > 0) {
		return latestResponseText;
	}
	return "thinking…";
}

export class WorkflowWidgetState {
	readonly workflowName: string;
	private readonly agents = new Map<string, AgentEntry>();

	constructor(workflowName: string) {
		this.workflowName = workflowName;
	}

	update(event: {
		kind: string;
		agentRunId?: string;
		label?: string;
		model?: string;
		sandbox?: string;
		timeoutMinutes?: number;
		usage?: { inputTokens: number; outputTokens: number };
		turns?: number;
		attempt?: number;
		ts?: number;
		toolName?: string;
		toolCallId?: string;
		inputPreview?: string;
		preview?: string;
		sessionId?: string;
	}): void {
		const id = event.agentRunId;
		if (!id) return;

		if (event.kind === "agent.started") {
			this.agents.set(id, {
				agentRunId: id,
				label: event.label ?? id,
				model: event.model ?? "?",
				...(event.sandbox !== undefined ? { sandbox: event.sandbox } : {}),
				...(event.timeoutMinutes !== undefined ? { timeoutMinutes: event.timeoutMinutes } : {}),
				status: "running",
				startedAt: event.ts ?? Date.now(),
				totalTokens: 0,
				retries: 0,
				toolCalls: 0,
				activeTools: new Map(),
			});
			return;
		}

		const entry = this.agents.get(id);
		if (!entry) return;

		if (event.kind === "agent.completed") {
			entry.status = "completed";
			entry.endedAt = event.ts ?? Date.now();
			if (event.turns !== undefined) entry.turns = event.turns;
			if (event.usage) {
				entry.totalTokens =
					(event.usage.inputTokens ?? 0) +
					(event.usage.outputTokens ?? 0);
			}
		} else if (event.kind === "agent.failed") {
			entry.status = "failed";
			entry.endedAt = event.ts ?? Date.now();
		} else if (event.kind === "agent.retried") {
			entry.retries = event.attempt ?? entry.retries + 1;
			entry.status = "running";
			entry.activeTools = new Map();
			delete entry.latestResponseText;
		} else if (event.kind === "agent.tool_call") {
			entry.toolCalls++;
			const toolCallId = event.toolCallId ?? "";
			const toolName = event.toolName ?? "tool";
			if (toolCallId.length > 0) {
				entry.activeTools.set(toolCallId, toolName);
			}
		} else if (event.kind === "agent.tool_end") {
			const toolCallId = event.toolCallId ?? "";
			if (toolCallId.length > 0) {
				entry.activeTools.delete(toolCallId);
			}
		} else if (event.kind === "agent.usage") {
			if (event.usage) {
				entry.totalTokens =
					(event.usage.inputTokens ?? 0) +
					(event.usage.outputTokens ?? 0);
			}
		} else if (event.kind === "agent.output") {
			const preview = event.preview ?? "";
			if (preview.length > 0) entry.latestResponseText = preview;
		} else if (event.kind === "agent.session") {
			entry.sessionId = event.sessionId ?? "";
		}
	}

	abortRunning(): void {
		for (const entry of this.agents.values()) {
			if (entry.status === "running") {
				entry.status = "failed";
				entry.endedAt = Date.now();
			}
		}
	}

	isEmpty(): boolean {
		return this.agents.size === 0;
	}

	renderLines(width: number, spinnerFrame: number, theme: WidgetTheme): string[] {
		const entries = [...this.agents.values()];
		if (entries.length === 0) return [];

		const lines: string[] = [];
		const headerText = `◉  workflow:${this.workflowName}`;
		lines.push(theme.bold(theme.fg("accent", headerText)));

		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i]!;
			const isLast = i === entries.length - 1;
			const branch = isLast ? "└─" : "├─";

			const icon = spinnerIcon(entry.status, spinnerFrame, theme);
			const displayLabel = formatLabel(entry.label);
			const label = displayLabel.length > 24
				? displayLabel.slice(0, 23) + "…"
				: displayLabel.padEnd(24);
			const model = theme.dim(entry.model);
			const sandboxBadge = formatSandboxBadge(entry.sandbox, theme);

			const parts: string[] = [icon, label, model];
			if (sandboxBadge !== undefined) parts.push(sandboxBadge);
			if (entry.timeoutMinutes !== undefined) parts.push(theme.dim(`⏱${String(entry.timeoutMinutes)}m`));
			if (entry.turns !== undefined) parts.push(theme.dim(`⟳${String(entry.turns)}`));
			if (entry.totalTokens > 0) {
				parts.push(theme.dim(`${(entry.totalTokens / 1000).toFixed(1)}k tok`));
			}
			if (entry.toolCalls > 0) parts.push(theme.dim(`${String(entry.toolCalls)} tools`));
			if (entry.retries > 0) parts.push(theme.dim(`retry×${String(entry.retries)}`));

			// Duration only shown for finished agents (final execution time).
			if (entry.endedAt !== undefined) {
				const durationMs = entry.endedAt - entry.startedAt;
				const dur = `${(durationMs / 1000).toFixed(0)}s`;
				parts.push(theme.dim(dur));
			}

			const row = `${branch} ${parts.join("  ·  ")}`;
			lines.push(row.slice(0, width));

			// Activity line — always shown for running agents (falls back to "thinking…").
			if (entry.status === "running") {
				const activity = describeActivity(entry.activeTools, entry.latestResponseText);
				const indent = isLast ? "     " : "│    ";
				const actionLine = `${indent}${theme.dim(`⎿  ${activity}`)}`;
				lines.push(actionLine.slice(0, width));
			}
		}

		return lines;
	}
}

/**
 * Render a one-character badge indicating whether the agent runs sandboxed.
 *
 *   srt        → 🔒 sandboxed
 *   noSandbox  → 🔓 host        (dim, since it's the unsafe default)
 *   fake       → (omitted   — test sandbox)
 *   undefined  → (omitted)
 */
export function formatSandboxBadge(
	sandbox: string | undefined,
	theme: WidgetTheme,
): string | undefined {
	if (sandbox === undefined || sandbox === "fake") return undefined;
	if (sandbox === "noSandbox") return theme.dim("🔓");
	return theme.fg("success", "🔒");
}

/**
 * Strip a trailing `-r<N>` suffix and replace it with `, retry <N-1>` for
 * N>=2. `-r1` is the first call so the suffix is dropped entirely.
 */
export function formatLabel(label: string): string {
	const m = /^(.+)-r(\d+)$/.exec(label);
	if (m === null) return label;
	const base = m[1]!;
	const n = Number.parseInt(m[2]!, 10);
	if (n <= 1) return base;
	return `${base}, retry ${String(n - 1)}`;
}

function spinnerIcon(
	status: AgentEntry["status"],
	frame: number,
	theme: WidgetTheme,
): string {
	switch (status) {
		case "running":
			return theme.fg("accent", SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!);
		case "completed":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "blocked":
			return theme.fg("warning", "⊘");
	}
}
