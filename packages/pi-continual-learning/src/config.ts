/**
 * Env-var parsing and threshold resolution for pi-continual-learning.
 *
 * All functions are pure — they take process.env, `now`, and `state` as
 * explicit arguments so tests can be fully deterministic.
 */

import type { PersistedState } from "./state.js";

// ---------------------------------------------------------------------------
// Built-in defaults
// ---------------------------------------------------------------------------

const DEFAULT_MIN_TURNS = 10;
const DEFAULT_MIN_MINUTES = 120;
const DEFAULT_TRIAL_MIN_TURNS = 3;
const DEFAULT_TRIAL_MIN_MINUTES = 15;
const DEFAULT_TRIAL_WINDOW_HOURS = 24;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a non-negative integer from an env-var string.
 * Returns `fallback` if the value is missing, non-numeric, or negative.
 */
function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
	if (!raw) return fallback;
	const n = parseInt(raw, 10);
	if (isNaN(n) || n < 0) return fallback;
	return n;
}

function isTruthy(val: string | undefined): boolean {
	if (!val) return false;
	const lower = val.toLowerCase();
	return lower === "1" || lower === "true";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Resolved threshold pair (minTurns + minMinutes). */
export interface ResolvedThresholds {
	minTurns: number;
	minMinutes: number;
}

/**
 * Returns true when trial mode is requested AND the trial window has not
 * expired. A null `trialStartedAt` means the trial is being activated right
 * now (the caller will set it) — treat as active.
 */
export function isTrialActive(
	env: NodeJS.ProcessEnv,
	now: number,
	state: Pick<PersistedState, "trialStartedAt">,
): boolean {
	if (!isTruthy(env["PI_CONTINUAL_LEARNING_TRIAL"])) return false;
	const windowHours = parseNonNegativeInt(
		env["PI_CONTINUAL_LEARNING_TRIAL_WINDOW_HOURS"],
		DEFAULT_TRIAL_WINDOW_HOURS,
	);
	// null → trial was just activated; treat as active
	if (state.trialStartedAt == null) return true;
	return now - state.trialStartedAt < windowHours * 3_600_000;
}

/**
 * Resolve the effective min-turns and min-minutes thresholds, taking env-var
 * overrides and the trial window into account.
 */
export function resolveThresholds(
	env: NodeJS.ProcessEnv,
	now: number,
	state: Pick<PersistedState, "trialStartedAt">,
): ResolvedThresholds {
	const defaultMinTurns = parseNonNegativeInt(
		env["PI_CONTINUAL_LEARNING_MIN_TURNS"],
		DEFAULT_MIN_TURNS,
	);
	const defaultMinMinutes = parseNonNegativeInt(
		env["PI_CONTINUAL_LEARNING_MIN_MINUTES"],
		DEFAULT_MIN_MINUTES,
	);

	if (isTrialActive(env, now, state)) {
		const trialMinTurns = parseNonNegativeInt(
			env["PI_CONTINUAL_LEARNING_TRIAL_MIN_TURNS"],
			DEFAULT_TRIAL_MIN_TURNS,
		);
		const trialMinMinutes = parseNonNegativeInt(
			env["PI_CONTINUAL_LEARNING_TRIAL_MIN_MINUTES"],
			DEFAULT_TRIAL_MIN_MINUTES,
		);
		return { minTurns: trialMinTurns, minMinutes: trialMinMinutes };
	}

	return { minTurns: defaultMinTurns, minMinutes: defaultMinMinutes };
}
