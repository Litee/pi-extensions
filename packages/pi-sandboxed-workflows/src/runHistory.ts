/**
 * In-memory run history for the sandboxed-workflows TUI.
 *
 * Stores the last MAX_RUNS lifecycle events per workflow name so the
 * runs/run-detail screens can display real data instead of the
 * "No run history available" / "No events to display" placeholders.
 *
 * The store is populated by `RunWorkflowDeps.onLifecycleEvent` callbacks
 * wired in `index.ts` and read by the `renderRuns`/`renderRunDetail`
 * helpers in the same file.
 */

/** A single lifecycle or diagnostic event appended to a run. */
export interface RunEvent {
	/**
	 * Semantic kind. Core values are the workflow lifecycle phases;
	 * arbitrary string allowed for future extensibility.
	 */
	kind: string;
	/** Human-readable description of the event. */
	message: string;
	/** `Date.now()` at event time. */
	ts: number;
	/** Optional structured payload (args, result, stack, etc.). */
	details?: Record<string, unknown>;
}

/** A single workflow execution with its lifecycle events. */
export interface RunRecord {
	readonly runId: string;
	readonly name: string;
	readonly startedAt: number;
	finishedAt?: number;
	status: "running" | "completed" | "error" | "aborted";
	readonly events: RunEvent[];
}

/** Maximum number of runs to retain per workflow name. */
const MAX_RUNS = 20;

/**
 * Bounded ring-buffer of workflow runs, keyed by workflow name.
 *
 * Thread-safety: this class is single-threaded (Node.js event loop).
 * All mutations are synchronous; no async concerns.
 */
export class RunHistory {
	/** name → runs, newest first. */
	private readonly _runs = new Map<string, RunRecord[]>();

	/**
	 * Register the start of a new run. Prepends to the per-name list and
	 * drops the oldest entry once the list exceeds MAX_RUNS.
	 */
	startRun(runId: string, name: string, startedAt: number = Date.now()): void {
		const record: RunRecord = {
			runId,
			name,
			startedAt,
			status: "running",
			events: [],
		};
		const existing = this._runs.get(name) ?? [];
		// Newest first; trim to capacity.
		const updated = [record, ...existing].slice(0, MAX_RUNS);
		this._runs.set(name, updated);
	}

	/**
	 * Append an event to the run identified by `runId`.
	 * No-ops if no matching run is found (defensive — caller should call
	 * `startRun` first).
	 */
	appendEvent(runId: string, event: RunEvent): void {
		for (const runs of this._runs.values()) {
			const record = runs.find((r) => r.runId === runId);
			if (record !== undefined) {
				record.events.push(event);
				return;
			}
		}
	}

	/**
	 * Mark a run as finished. Sets `status` and `finishedAt`.
	 * No-ops if no matching run is found.
	 */
	finishRun(
		runId: string,
		status: "completed" | "error" | "aborted",
		finishedAt: number = Date.now(),
	): void {
		for (const runs of this._runs.values()) {
			const record = runs.find((r) => r.runId === runId);
			if (record !== undefined) {
				record.status = status;
				record.finishedAt = finishedAt;
				return;
			}
		}
	}

	/**
	 * Return runs for the given workflow name, newest first.
	 * Returns an empty array when no runs have been recorded.
	 */
	getRunsForName(name: string): ReadonlyArray<RunRecord> {
		return this._runs.get(name) ?? [];
	}

	/** Total number of runs across all workflow names (for diagnostics). */
	get totalRuns(): number {
		let count = 0;
		for (const runs of this._runs.values()) count += runs.length;
		return count;
	}
}
