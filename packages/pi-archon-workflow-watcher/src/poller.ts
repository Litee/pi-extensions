import {
	TERMINAL_STATUSES,
	SHOULD_TRIGGER_STATUSES,
	type ArchonEvent,
	type ArchonRun,
	type RunSnapshot,
} from "./types.js";

function makeLabel(run: ArchonRun): string {
	const name = run.workflowName ?? run.id;
	// Show just the last path segment of working_path as location context,
	// e.g. "/Volumes/work/my-repo" → "my-repo".
	const loc = run.workingPath
		? ` (${run.workingPath.replace(/\/+$/, "").split("/").pop() ?? run.workingPath})`
		: "";
	return `${name}${loc}`;
}

export function detectChanges(
	baseline: RunSnapshot,
	current: RunSnapshot,
): ArchonEvent[] {
	const events: ArchonEvent[] = [];

	// New runs (in current, not in baseline)
	for (const [id, run] of Object.entries(current)) {
		if (id in baseline) continue;
		const label = makeLabel(run);
		events.push({
			runId: id,
			eventType: "new_run",
			workflowName: run.workflowName ?? id,
			workingPath: run.workingPath ?? "",
			previousStatus: "",
			newStatus: run.status,
			summary: `${label}: new run — ${run.status}`,
			formatted: `• ${label}: new run — ${run.status}`,
			isTerminal: TERMINAL_STATUSES.has(run.status),
			shouldTriggerTurn: false,
		});
	}

	// Status changes
	for (const [id, run] of Object.entries(current)) {
		const prev = baseline[id];
		if (!prev || prev.status === run.status) continue;
		const label = makeLabel(run);
		const isTerminal = TERMINAL_STATUSES.has(run.status);
		const shouldTriggerTurn = SHOULD_TRIGGER_STATUSES.has(run.status);
		events.push({
			runId: id,
			eventType: "status_changed",
			workflowName: run.workflowName ?? id,
			workingPath: run.workingPath ?? "",
			previousStatus: prev.status,
			newStatus: run.status,
			summary: `${label}: ${prev.status} → ${run.status}`,
			formatted: `• ${label}: ${prev.status} → ${run.status}${isTerminal ? (run.status === "completed" ? " ✓" : " ✗") : ""}`,
			isTerminal,
			shouldTriggerTurn,
		});
	}

	// Removed runs (in baseline, not in current) — only non-terminal ones are notable
	for (const [id, run] of Object.entries(baseline)) {
		if (id in current) continue;
		if (TERMINAL_STATUSES.has(run.status)) continue; // terminal runs disappearing is expected
		const label = makeLabel(run);
		events.push({
			runId: id,
			eventType: "run_removed",
			workflowName: run.workflowName ?? id,
			workingPath: run.workingPath ?? "",
			previousStatus: run.status,
			newStatus: "",
			summary: `${label}: run disappeared (was ${run.status})`,
			formatted: `• ${label}: run disappeared (was ${run.status})`,
			isTerminal: true,
			shouldTriggerTurn: true,
		});
	}

	return events;
}
