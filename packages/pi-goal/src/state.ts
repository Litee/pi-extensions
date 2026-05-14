/**
 * Persistent state types and pure helpers for the pi-goal extension.
 *
 * This module is free of pi runtime dependencies so the persistence logic
 * (what gets stored, and how the latest entry is picked on session resume)
 * can be unit-tested without standing up the full extension.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Session-persisted goal state. */
export interface PersistedGoalState {
	enabled: boolean;
	/** The goal objective string set by the user. */
	objective: string;
	/** Iteration count — turns observed since the goal was enabled (safety net). */
	iterations: number;
	/** Hard safety cap on iterations. The loop also stops when tokens exceed budget. */
	maxIterations: number;
	/** Token budget for the goal. When exceeded, budget_limit prompt is injected. */
	tokenBudget: number;
	/** Baseline `ctx.getContextUsage().tokens` captured when the goal was enabled. */
	tokenBaseline: number;
}

/** Namespaced custom-entry key to avoid collisions with other extensions. */
export const STATE_CUSTOM_TYPE = "pi-goal:state";

/** Default safety cap for autonomous iterations. */
export const DEFAULT_MAX_ITERATIONS = 100;

/** Default token budget. Codex defaults are model-dependent; 200k is a generous default. */
export const DEFAULT_TOKEN_BUDGET = 200_000;

/** Shape of `~/.pi/agent/pi-goal.json`. */
export interface GoalConfig {
	maxIterations?: number;
	tokenBudget?: number;
	/**
	 * Provider/id spec for the completion-checker model, e.g.
	 * `"amazon-bedrock/global.anthropic.claude-haiku-4-5"` or
	 * `"anthropic/claude-haiku-4-5-20251201"`. When unset, the checker falls
	 * back to whatever the primary agent is using — functional but expensive.
	 */
	checkerModel?: string;
	/** Max characters of recent transcript to send to the checker per turn. */
	checkerTranscriptChars?: number;
}

/**
 * Read `~/.pi/agent/pi-goal.json`; returns `{}` on any read/parse failure.
 * Intentionally tolerant: goal mode must still function without a config file.
 */
export function loadGoalConfig(): GoalConfig {
	try {
		const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
		const configPath = join(home, ".pi", "agent", "pi-goal.json");
		const content = readFileSync(configPath, "utf-8");
		return JSON.parse(content) as GoalConfig;
	} catch {
		return {};
	}
}

/**
 * Minimal shape of a session "custom" entry that this module cares about.
 */
export interface GoalStateCandidateEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/**
 * Walk session entries newest-last and return the most recent goal-state
 * entry, or `undefined` if none is present.
 */
export function pickLatestGoalState(
	entries: readonly GoalStateCandidateEntry[],
): PersistedGoalState | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "custom") continue;
		if (entry.customType !== STATE_CUSTOM_TYPE) continue;
		const data = entry.data as PersistedGoalState | undefined;
		if (!data) continue;
		return data;
	}
	return undefined;
}
