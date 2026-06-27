/**
 * pi-cmux-cli-guard
 *
 * Enforces the cmux rule: "When using cmux, you MUST use
 * `caller.workspace_ref` from `cmux identify --json` for
 * self-referential operations — never `focused.workspace_ref`."
 *
 * Intercepts `bash` tool calls. When the command contains
 * `focused.workspace_ref`, the tool call is blocked and a clear
 * instruction is returned to the LLM telling it to use
 * `caller.workspace_ref` instead.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const FOCUSED_REF_PATTERN = /focused\.workspace_ref/;

/**
 * Builds the block reason message shown to the LLM when it tries to
 * use `focused.workspace_ref` in a bash command.
 */
export function buildBlockReason(command: string): string {
	return [
		"⛔ CMUX RULE: Use of `focused.workspace_ref` is prohibited.",
		"",
		`Command attempted: ${command}`,
		"",
		"For self-referential cmux operations, you MUST use",
		"`caller.workspace_ref` — obtained from `cmux identify --json`.",
		"",
		"To get the correct reference:",
		'  1. Run: cmux identify --json',
		'  2. Read the `caller.workspace_ref` field from the output',
		"  3. Use that value in subsequent cmux commands",
		"",
		"Never use `focused.workspace_ref` — it refers to the",
		"focused session's workspace, not your own.",
	].join("\n");
}

/**
 * Returns true when `command` contains a reference to `focused.workspace_ref`.
 */
export function containsFocusedWorkspaceRef(command: string): boolean {
	return FOCUSED_REF_PATTERN.test(command);
}

export default function cmuxCliGuard(pi: ExtensionAPI): void {
	pi.on("tool_call", (event, _ctx) => {
		// Only intercept bash tool calls
		if (!isToolCallEventType("bash", event)) {
			return undefined;
		}

		const command = event.input.command;
		if (typeof command !== "string") {
			return undefined;
		}

		if (containsFocusedWorkspaceRef(command)) {
			return { block: true, reason: buildBlockReason(command) };
		}

		return undefined;
	});
}
