import type { ArchonEvent, RunSnapshot } from "./types.js";
import { formatShortTime } from "pi-watcher-core/time";
import { statusLineColorAlias, type StatusLineColorAlias } from "pi-watcher-core/status-line";
export type { StatusLineColorAlias } from "pi-watcher-core/status-line";

function header(date: Date): string {
	return `[${formatShortTime(date)}] archon-workflow-watcher`;
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

export interface StatusLineResult {
	text: string;
	colorAlias: StatusLineColorAlias;
}

export function buildStatusLine(state: {
	runCount: number;
	activeCount: number;
}): StatusLineResult {
	const text = `archon: ${state.runCount}`;
	return { text, colorAlias: statusLineColorAlias() };
}
