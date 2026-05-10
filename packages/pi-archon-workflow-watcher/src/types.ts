export interface ArchonRun {
	id: string;
	status: string;
	workflowName?: string;
	/** Full filesystem path of the working directory (archon's working_path). */
	workingPath?: string;
	startedAt?: string;
	lastActivityAt?: string;
	[key: string]: unknown;
}

export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
export const SHOULD_TRIGGER_STATUSES = new Set(["paused", "completed", "failed", "cancelled"]);

/** Map of runId -> ArchonRun */
export type RunSnapshot = Record<string, ArchonRun>;

export type ArchonEventType = "new_run" | "status_changed" | "run_removed";

export interface ArchonEvent {
	runId: string;
	eventType: ArchonEventType;
	workflowName: string;
	workingPath: string;
	previousStatus: string;
	newStatus: string;
	summary: string;
	formatted: string;
	isTerminal: boolean;
	shouldTriggerTurn: boolean;
}
