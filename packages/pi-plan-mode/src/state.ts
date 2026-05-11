/**
 * Persistent state types and pure helpers for the plan-mode extension.
 *
 * This module is deliberately free of `pi` runtime dependencies so the
 * persistence logic (what gets stored, and how the latest entry is picked on
 * session resume) can be unit-tested without standing up the full extension.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/**
 * Session-persisted plan mode state. Stored as a custom entry under
 * `STATE_CUSTOM_TYPE` so plan mode can be fully rehydrated (including the
 * pre-plan model, thinking level, and tool set) across agent restarts.
 */
export interface PersistedPlanModeState {
	enabled: boolean;
	modelSnapshot?: { id: string; provider: string };
	thinkingLevelSnapshot?: ThinkingLevel;
	toolsSnapshot?: string[];
}

/** Namespaced custom-entry key to avoid collisions with other extensions. */
export const STATE_CUSTOM_TYPE = "pi-plan-mode:state";
/** Legacy key used before snapshot persistence was added; read for backward compat. */
export const LEGACY_STATE_CUSTOM_TYPE = "plan-mode";

/** Shape of `~/.pi/agent/pi-plan-mode.json`. */
export interface PlanModeConfig {
	model?: string;
	provider?: string;
	thinkingLevel?: ThinkingLevel;
}

/**
 * Read `~/.pi/agent/pi-plan-mode.json`; returns `{}` on any read/parse failure.
 * Intentionally tolerant: plan mode must still function without a config file.
 */
export function loadPlanModeConfig(): PlanModeConfig {
	try {
		const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
		const configPath = join(home, ".pi", "agent", "pi-plan-mode.json");
		const content = readFileSync(configPath, "utf-8");
		return JSON.parse(content) as PlanModeConfig;
	} catch {
		return {};
	}
}

/**
 * Minimal shape of a session "custom" entry that this module cares about.
 * The real `SessionEntry` union is richer, but for picking the latest plan
 * state we only need the discriminator + custom key + payload.
 */
export interface PlanStateCandidateEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/**
 * Result of scanning session entries for plan-mode state on resume.
 *
 * `source` tells the caller whether snapshots may be trusted. Legacy entries
 * were written before snapshot persistence existed; their `data` cannot carry
 * model/thinking/tool snapshots, so disabling plan mode after a legacy-resume
 * must warn the user (see §3.9 of the test-config review).
 */
export interface PickedPlanState {
	state: PersistedPlanModeState;
	source: "new" | "legacy";
}

/**
 * Walk session entries newest-last (as `sessionManager.getEntries()` returns
 * them) and return the most recent plan-mode state entry, or `undefined` if
 * none is present.
 *
 * Both the new (`STATE_CUSTOM_TYPE`) and legacy (`LEGACY_STATE_CUSTOM_TYPE`)
 * keys are considered. When the latest entry is the legacy one, snapshot
 * fields are guaranteed absent in the returned `state`.
 */
export function pickLatestPlanState(
	entries: readonly PlanStateCandidateEntry[],
): PickedPlanState | undefined {
	// Iterate in reverse to find the latest candidate without copying the array.
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "custom") continue;
		if (
			entry.customType !== STATE_CUSTOM_TYPE &&
			entry.customType !== LEGACY_STATE_CUSTOM_TYPE
		) {
			continue;
		}
		const data = entry.data as PersistedPlanModeState | undefined;
		if (!data) continue;

		if (entry.customType === STATE_CUSTOM_TYPE) {
			return { state: data, source: "new" };
		}
		// Legacy entries pre-date snapshot persistence. Strip any accidental
		// snapshot fields so callers cannot mistakenly trust them.
		return {
			state: { enabled: Boolean(data.enabled) },
			source: "legacy",
		};
	}
	return undefined;
}
