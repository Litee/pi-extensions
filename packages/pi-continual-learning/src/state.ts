/**
 * Cross-session global state persistence for pi-continual-learning.
 *
 * Mirrors the HOME-resolution pattern from packages/pi-goal/src/state.ts.
 * The path is computed at runtime (not at module load time) so overriding
 * process.env.HOME in tests gives correct isolation.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of the JSON file persisted to <agentDir>/pi-continual-learning.json */
export interface PersistedState {
	/** Epoch ms of the last consolidation run, or null if never run. */
	lastRunAt: number | null;
	/** Number of successful invocations since the last consolidation run. */
	turnsSinceLastRun: number;
	/** sessionId:leafId marker that was processed last (dedup + new-content guard). */
	processedMarker: string | null;
	/** Epoch ms when trial mode was first activated, or null if not started. */
	trialStartedAt: number | null;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_STATE: PersistedState = {
	lastRunAt: null,
	turnsSinceLastRun: 0,
	processedMarker: null,
	trialStartedAt: null,
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function agentDir(): string {
	const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
	return join(home, ".pi", "agent");
}

/** Exported for tests that need to assert on the concrete path. */
export function statePath(): string {
	return join(agentDir(), "pi-continual-learning.json");
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/**
 * Load persisted state from disk.
 * Returns sane defaults on any read or parse error.
 */
export function loadState(): PersistedState {
	try {
		const content = readFileSync(statePath(), "utf-8");
		const parsed = JSON.parse(content) as Partial<PersistedState>;
		return {
			lastRunAt: parsed.lastRunAt ?? null,
			turnsSinceLastRun: parsed.turnsSinceLastRun ?? 0,
			processedMarker: parsed.processedMarker ?? null,
			trialStartedAt: parsed.trialStartedAt ?? null,
		};
	} catch {
		return { ...DEFAULT_STATE };
	}
}

/**
 * Persist state to disk.
 * All errors are swallowed — this must never throw out of an event handler.
 */
export function saveState(state: PersistedState): void {
	try {
		mkdirSync(agentDir(), { recursive: true });
		writeFileSync(statePath(), JSON.stringify(state, null, 2));
	} catch {
		// swallow — never propagate file I/O errors to the extension event loop
	}
}
