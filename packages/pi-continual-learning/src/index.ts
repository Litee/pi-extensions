/**
 * pi-continual-learning — periodic memory consolidation extension.
 *
 * Wires a single agent_end handler. After each successful agent invocation,
 * evaluates whether enough activity has accumulated to warrant a consolidation
 * pass and, if so, injects a follow-up message that asks the agent to run the
 * continual-learning skill (which updates AGENTS.md).
 */

import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isTrialActive, resolveThresholds } from "./config.js";
import {
	buildMarker,
	decideConsolidation,
	isSuccess,
} from "./decide.js";
import { buildConsolidationMessage, CONSOLIDATE_MESSAGE_TYPE } from "./message.js";
import { loadState, saveState } from "./state.js";

export default function piContinualLearning(pi: ExtensionAPI): void {
	pi.on("agent_end", (event: AgentEndEvent, ctx) => {
		// ----------------------------------------------------------------
		// 1. Success check — abort / error invocations are not counted.
		// ----------------------------------------------------------------
		if (!isSuccess(event.messages)) return;

		// ----------------------------------------------------------------
		// 2. Compute current content marker.
		// ----------------------------------------------------------------
		const sessionId = ctx.sessionManager.getSessionId();
		const leafId = ctx.sessionManager.getLeafId();
		const currentMarker = buildMarker(sessionId, leafId);

		// ----------------------------------------------------------------
		// 3 + 4. Load state; dedup / new-content guard.
		//        Same marker → already processed this exact snapshot → skip.
		// ----------------------------------------------------------------
		const state = loadState();
		if (state.processedMarker === currentMarker) return;

		// ----------------------------------------------------------------
		// 5. Increment turn counter and persist immediately.
		// ----------------------------------------------------------------
		state.turnsSinceLastRun += 1;
		saveState(state);

		// ----------------------------------------------------------------
		// Trial management: set trialStartedAt on first activation so the
		// window timer starts here.  (Pure resolveThresholds / isTrialActive
		// treat null as "just activated" and return trial thresholds, but we
		// persist the actual start time so window expiry works across restarts.)
		// ----------------------------------------------------------------
		const now = Date.now();
		if (isTrialActive(process.env, now, state) && state.trialStartedAt == null) {
			state.trialStartedAt = now;
			saveState(state);
		}

		// ----------------------------------------------------------------
		// 6. Resolve effective thresholds (trial vs default).
		// ----------------------------------------------------------------
		const thresholds = resolveThresholds(process.env, now, state);

		// ----------------------------------------------------------------
		// 7. Evaluate all conditions via the pure decision function.
		// ----------------------------------------------------------------
		const result = decideConsolidation(state, now, thresholds, currentMarker);
		if (!result.trigger) return;

		// ----------------------------------------------------------------
		// 8. Trigger consolidation: reset state, inject follow-up message.
		// ----------------------------------------------------------------
		state.lastRunAt = now;
		state.turnsSinceLastRun = 0;
		state.processedMarker = currentMarker;
		saveState(state);

		void pi.sendMessage(
			{
				customType: CONSOLIDATE_MESSAGE_TYPE,
				content: buildConsolidationMessage(),
				display: true,
			},
			{ triggerTurn: true },
		);
	});
}
