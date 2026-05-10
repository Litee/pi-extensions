import type { ArchonEvent, RunSnapshot } from "./types.js";

function header(date: Date): string {
	return `archon-workflow-watcher — ${date.toISOString()}`;
}

export function buildChangeChatMessage(events: ArchonEvent[], date: Date): string {
	const lines = [
		header(date),
		"",
		`${events.length === 1 ? "1 change" : `${events.length} changes`} detected:`,
		"",
		...events.map((e) => e.formatted),
	];
	return lines.join("\n");
}

export function buildStartupChatMessage(snapshot: RunSnapshot, date: Date): string {
	const runs = Object.values(snapshot);
	if (runs.length === 0) {
		return [header(date), "", "No active workflow runs."].join("\n");
	}
	const lines = [header(date), "", `${runs.length} active workflow run(s):`, ""];
	for (const run of runs) {
		const name = run.workflowName ?? run.id;
		const loc = run.workingPath
			? ` (${run.workingPath.replace(/\/+$/, "").split("/").pop() ?? run.workingPath})`
			: "";
		lines.push(`• ${name}${loc}: ${run.status}`);
	}
	return lines.join("\n");
}

export function buildStatusLine(state: {
	paused: boolean;
	runCount: number;
	activeCount: number;
}): string {
	const mode = state.paused ? "paused" : "active";
	return `archon-watcher: ${mode} (${state.activeCount} running, ${state.runCount} total)`;
}
