/**
 * Pure decision logic for the pi-continual-learning extension.
 *
 * No pi/runtime imports — fully unit-testable in isolation.
 */

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/**
 * Minimal shape of an agent message that this module needs. The full
 * AgentMessage type from pi-agent-core is a union; callers should cast or
 * use `as unknown as MinimalMessage[]` when passing real messages.
 */
export interface MinimalMessage {
	role: string;
	stopReason?: StopReason;
}

/**
 * Scan messages backward and return the stopReason of the last assistant
 * message, or null if no assistant message is present.
 */
export function lastAssistantStopReason(
	messages: readonly MinimalMessage[],
): StopReason | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg) continue;
		if (msg.role === "assistant") {
			return msg.stopReason ?? null;
		}
	}
	return null;
}

/**
 * An invocation is successful when the last assistant message has a
 * stopReason that is not "error" or "aborted" (and is present at all).
 */
export function isSuccess(messages: readonly MinimalMessage[]): boolean {
	const reason = lastAssistantStopReason(messages);
	if (reason === null || reason === "error" || reason === "aborted") return false;
	return true;
}

/**
 * Build a stable string marker that identifies the current session content
 * state. Different leafIds → different markers → fresh content.
 */
export function buildMarker(sessionId: string, leafId: string | null): string {
	return `${sessionId}:${String(leafId)}`;
}

/** Threshold pair used by decideConsolidation. */
export interface Thresholds {
	minTurns: number;
	minMinutes: number;
}

/** Slice of persisted state that decideConsolidation reads. */
export interface DecisionState {
	turnsSinceLastRun: number;
	lastRunAt: number | null;
	processedMarker: string | null;
}

/** Return value from decideConsolidation. */
export interface DecisionResult {
	trigger: boolean;
	reason: string;
}

/**
 * Pure decision function. Evaluates conditions 2–4 (condition 1 — success —
 * is pre-checked by the caller before invoking this function).
 *
 * Conditions:
 *   2. turnsSinceLastRun >= thresholds.minTurns
 *   3. elapsed minutes since lastRunAt >= thresholds.minMinutes
 *      (null lastRunAt → elapsed treated as ∞, condition always satisfied)
 *   4. currentMarker !== state.processedMarker (new content guard / dedup)
 */
export function decideConsolidation(
	state: DecisionState,
	now: number,
	thresholds: Thresholds,
	currentMarker: string,
): DecisionResult {
	// Condition 4 — new content / dedup guard
	if (state.processedMarker === currentMarker) {
		return { trigger: false, reason: "no new content (same marker)" };
	}

	// Condition 2 — turns threshold
	if (state.turnsSinceLastRun < thresholds.minTurns) {
		return {
			trigger: false,
			reason: `turns below threshold (${state.turnsSinceLastRun} < ${thresholds.minTurns})`,
		};
	}

	// Condition 3 — time threshold
	const elapsedMs = state.lastRunAt == null ? Infinity : now - state.lastRunAt;
	const elapsedMin = elapsedMs / 60_000;
	if (elapsedMin < thresholds.minMinutes) {
		return {
			trigger: false,
			reason: `time below threshold (${elapsedMin.toFixed(1)} min < ${thresholds.minMinutes} min)`,
		};
	}

	return { trigger: true, reason: "all conditions met" };
}
