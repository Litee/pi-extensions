/**
 * Pure event-handler predicates and payload builders for plan mode.
 *
 * Each function takes plain data and returns plain data so it can be
 * unit-tested without spinning up the pi runtime. The thin `index.ts` shell
 * wires these into `pi.on("tool_call" | "context" | "before_agent_start")`.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { TextContent } from "@mariozechner/pi-ai";
import { isSafeCommand } from "./utils.js";

/** Custom-type sentinel used for the plan-mode system message. */
export const PLAN_MODE_CONTEXT_CUSTOM_TYPE = "plan-mode-context";

/** Substring that marks user messages carrying plan-mode context. */
export const PLAN_MODE_ACTIVE_MARKER = "[PLAN MODE ACTIVE]";

/** Minimal shape of the `tool_call` event this handler depends on. */
export interface BashCallEvent {
	toolName: string;
	input: { command?: unknown } & Record<string, unknown>;
}

export interface BashBlockResult {
	block: true;
	reason: string;
}

/**
 * Gate destructive bash commands while plan mode is enabled. Returns the
 * block payload for the pi tool_call interceptor, or `undefined` to allow.
 */
export function shouldBlockBashInPlan(
	event: BashCallEvent,
	enabled: boolean,
): BashBlockResult | undefined {
	if (!enabled) return undefined;
	if (event.toolName !== "bash") return undefined;
	const command = typeof event.input.command === "string" ? event.input.command : "";
	if (isSafeCommand(command)) return undefined;
	return {
		block: true,
		reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
	};
}

/**
 * Drop stale plan-mode context from the message stream when plan mode is off.
 *
 * Two categories are removed:
 *   1. Custom messages authored by `buildPlanModeContextMessage` — identified
 *      by `customType === PLAN_MODE_CONTEXT_CUSTOM_TYPE`.
 *   2. User messages whose content carries the `[PLAN MODE ACTIVE]` marker
 *      injected by `buildPlanModeContextMessage` via the `before_agent_start` handler.
 *
 * Non-user, non-plan-mode-context messages always pass through.
 *
 * The input array is never mutated; a filtered copy is returned.
 */
export function filterContextMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return messages.filter((m) => {
		const msg = m as AgentMessage & { customType?: string };
		if (msg.customType === PLAN_MODE_CONTEXT_CUSTOM_TYPE) return false;
		if (msg.role !== "user") return true;

		const content = msg.content as unknown;
		if (typeof content === "string") {
			return !content.includes(PLAN_MODE_ACTIVE_MARKER);
		}
		if (Array.isArray(content)) {
			return !content.some(
				(c) =>
					c != null &&
					typeof c === "object" &&
					(c as { type?: unknown }).type === "text" &&
					typeof (c as TextContent).text === "string" &&
					(c as TextContent).text.includes(PLAN_MODE_ACTIVE_MARKER),
			);
		}
		return true;
	});
}

/** Payload returned by the `before_agent_start` handler when plan mode is on. */
export interface PlanModeContextMessage {
	customType: string;
	content: string;
	display: boolean;
}

/**
 * Build the system-prompt-like message injected at agent start while plan
 * mode is active. Kept as a pure builder so the wording can be snapshot-pinned.
 */
export function buildPlanModeContextMessage(): PlanModeContextMessage {
	return {
		customType: PLAN_MODE_CONTEXT_CUSTOM_TYPE,
		content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- You can only use: read, bash, grep, find, ls, ask_user_question
- You CANNOT use: edit, write (file modifications are disabled)
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions using the ask_user_question tool.
Use brave-search skill via bash for web research.

Describe the plan as a numbered list under a "Plan:" header.
Do NOT attempt to make changes - just describe what you would do.`,
		display: false,
	};
}
