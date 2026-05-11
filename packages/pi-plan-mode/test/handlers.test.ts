import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	buildPlanModeContextMessage,
	filterContextMessages,
	PLAN_MODE_ACTIVE_MARKER,
	PLAN_MODE_CONTEXT_CUSTOM_TYPE,
	shouldBlockBashInPlan,
} from "../src/handlers.js";

// The AgentMessage type is nominal in pi-agent-core; our handlers only read
// `role`, `content`, and a synthetic `customType`. `as AgentMessage` casts in
// these helpers keep runtime data shaped like the real thing.
function userText(text: string): AgentMessage {
	return { role: "user", content: text } as AgentMessage;
}
function userParts(parts: Array<{ type: string; text?: string }>): AgentMessage {
	return { role: "user", content: parts } as AgentMessage;
}
function assistant(text: string): AgentMessage {
	return { role: "assistant", content: text } as unknown as AgentMessage;
}
function planModeContext(): AgentMessage {
	return {
		role: "user",
		customType: PLAN_MODE_CONTEXT_CUSTOM_TYPE,
		content: "anything",
	} as unknown as AgentMessage;
}

describe("filterContextMessages", () => {
	it("removes plan-mode-context custom entries regardless of role", () => {
		// Arrange
		const messages = [
			planModeContext(),
			assistant("ok"),
			{
				role: "assistant",
				customType: PLAN_MODE_CONTEXT_CUSTOM_TYPE,
				content: "nope",
			} as unknown as AgentMessage,
		];

		// Act
		const result = filterContextMessages(messages);

		// Assert
		expect(result).toHaveLength(1);
		expect(result[0]).toBe(messages[1]);
	});

	it("removes user string messages containing the plan-mode-active marker", () => {
		// Arrange
		const keep1 = userText("Regular user question");
		const drop = userText(`Please note: ${PLAN_MODE_ACTIVE_MARKER} now do X`);
		const keep2 = assistant(`assistants keep this even if ${PLAN_MODE_ACTIVE_MARKER}`);
		const messages = [keep1, drop, keep2];

		// Act
		const result = filterContextMessages(messages);

		// Assert
		expect(result).toEqual([keep1, keep2]);
	});

	it("removes user array-content messages where any text part contains the marker", () => {
		// Arrange
		const keep = userParts([
			{ type: "text", text: "hello" },
			{ type: "text", text: "world" },
		]);
		const drop = userParts([
			{ type: "text", text: "benign" },
			{ type: "text", text: `oops ${PLAN_MODE_ACTIVE_MARKER} oops` },
		]);

		// Act
		const result = filterContextMessages([keep, drop]);

		// Assert
		expect(result).toEqual([keep]);
	});

	it("keeps user messages whose array content has no text part matching the marker", () => {
		// Arrange — image-only or non-text parts must not be dropped.
		const keep = userParts([
			{ type: "image" },
			{ type: "text", text: "unrelated" },
		] as Array<{ type: string; text?: string }>);

		// Act
		const result = filterContextMessages([keep]);

		// Assert
		expect(result).toEqual([keep]);
	});

	it("keeps user messages with unexpected content shapes (null/object)", () => {
		// Arrange — defensive: pi should not crash on unknown content types.
		const keep = { role: "user", content: null } as unknown as AgentMessage;
		const keepObj = { role: "user", content: { weird: "shape" } } as unknown as AgentMessage;

		// Act
		const result = filterContextMessages([keep, keepObj]);

		// Assert
		expect(result).toEqual([keep, keepObj]);
	});

	it("does not mutate the input array", () => {
		// Arrange
		const input = [planModeContext(), userText("keep")];
		const snapshot = [...input];

		// Act
		filterContextMessages(input);

		// Assert
		expect(input).toEqual(snapshot);
	});

	it("returns an empty array when every message is plan-mode context", () => {
		// Arrange / Act
		const result = filterContextMessages([planModeContext(), planModeContext()]);

		// Assert
		expect(result).toEqual([]);
	});
});

describe("shouldBlockBashInPlan", () => {
	it("returns undefined when plan mode is disabled", () => {
		const r = shouldBlockBashInPlan(
			{ toolName: "bash", input: { command: "rm -rf /" } },
			false,
		);
		expect(r).toBeUndefined();
	});

	it("returns undefined for non-bash tools even when plan mode is enabled", () => {
		const r = shouldBlockBashInPlan(
			{ toolName: "write", input: { command: "rm -rf /" } },
			true,
		);
		expect(r).toBeUndefined();
	});

	it("allows safe bash commands when plan mode is enabled", () => {
		// `ls` is on the allowlist in utils.ts; regression-test that it passes.
		const r = shouldBlockBashInPlan({ toolName: "bash", input: { command: "ls -la" } }, true);
		expect(r).toBeUndefined();
	});

	it("blocks destructive bash commands when plan mode is enabled", () => {
		const r = shouldBlockBashInPlan(
			{ toolName: "bash", input: { command: "rm -rf /tmp/foo" } },
			true,
		);
		expect(r).toEqual({
			block: true,
			reason: expect.stringContaining("rm -rf /tmp/foo") as unknown,
		});
		expect(r?.reason).toMatch(/Plan mode: command blocked/);
	});

	it("coerces non-string command inputs to empty string — empty is not allowlisted, so it blocks", () => {
		// Defensive: a non-string `command` becomes "" inside the handler; empty
		// strings are not on the SAFE_PATTERNS allowlist, so they block. This
		// locks down the "malformed input must not silently slip through plan
		// mode" contract.
		const r = shouldBlockBashInPlan(
			{ toolName: "bash", input: { command: 42 } },
			true,
		);
		expect(r).toEqual({
			block: true,
			reason: expect.stringContaining("Plan mode: command blocked") as unknown,
		});
	});
});

describe("buildPlanModeContextMessage", () => {
	it("produces a stable plan-mode-context message", () => {
		expect(buildPlanModeContextMessage()).toMatchInlineSnapshot(`
			{
			  "content": "[PLAN MODE ACTIVE]
			You are in plan mode - a read-only exploration mode for safe code analysis.

			Restrictions:
			- You can only use: read, bash, grep, find, ls, ask_user_question
			- You CANNOT use: edit, write (file modifications are disabled)
			- Bash is restricted to an allowlist of read-only commands

			Ask clarifying questions using the ask_user_question tool.
			Use brave-search skill via bash for web research.

			Describe the plan as a numbered list under a "Plan:" header.
			Do NOT attempt to make changes - just describe what you would do.",
			  "customType": "plan-mode-context",
			  "display": false,
			}
		`);
	});
});
