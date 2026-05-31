import { describe, expect, it } from "vitest";

import {
	buildCheckerTranscript,
	formatBlockedNotify,
	formatBlockedStatus,
	formatSuccessNotify,
	formatTerminationNotify,
	formatTerminationStatus,
} from "../src/helpers.js";
import { GOAL_CONTEXT_MARKER } from "../src/prompt.js";

// -- issue #0003: termination messages must include turns AND tokens --
describe("formatSuccessNotify (#0003)", () => {
	it("includes turns and locale-formatted tokens", () => {
		const out = formatSuccessNotify(5, 28104);
		expect(out).toContain("5 turn(s)");
		expect(out).toMatch(/28[,\u202f\u00a0]104 tokens used/);
	});
});

describe("formatTerminationNotify (#0003)", () => {
	it("appends turns and locale-formatted tokens to the reason", () => {
		const out = formatTerminationNotify(
			"Goal mode cancelled (user typed input).",
			3,
			14231,
		);
		expect(out).toContain("Goal mode cancelled (user typed input).");
		expect(out).toContain("3 turn(s)");
		expect(out).toMatch(/14[,\u202f\u00a0]231 tokens used/);
	});

	it("works with zero turns (cancel before first agent_end)", () => {
		const out = formatTerminationNotify("Goal mode cancelled.", 0, 0);
		expect(out).toContain("0 turn(s)");
		expect(out).toContain("0 tokens used");
	});
});

describe("formatTerminationStatus (#0003)", () => {
	it("includes objective, turns, tokens, and reason", () => {
		const out = formatTerminationStatus(
			"write tests",
			"Max turns reached (20/20).",
			20,
			87402,
		);
		expect(out).toContain(`"write tests"`);
		expect(out).toContain("20 turn(s)");
		expect(out).toMatch(/87[,\u202f\u00a0]402 tokens used/);
		expect(out).toContain("Max turns reached (20/20).");
	});
});

// -- issue #0004: blocked-path formatters mirror the success/termination shape --
//
// `update_goal({status:"blocked", summary})` exits the loop on a third path
// (alongside complete + abort). The notify and follow-up messages must look
// and feel like the existing two so the user sees a consistent goal-mode
// epilogue regardless of which exit was taken.
describe("formatBlockedNotify (#0004)", () => {
	it("clearly labels the message as blocked (not just terminated)", () => {
		const out = formatBlockedNotify(2, 1234, "waiting on credentials");
		expect(out).toMatch(/blocked/i);
	});

	it("includes turns and locale-formatted tokens (mirrors #0003)", () => {
		const out = formatBlockedNotify(7, 28104, "network down");
		expect(out).toContain("7 turn(s)");
		expect(out).toMatch(/28[,\u202f\u00a0]104 tokens used/);
	});

	it("surfaces the blocker summary so the user sees what stopped progress", () => {
		const out = formatBlockedNotify(1, 0, "waiting on credentials");
		expect(out).toContain("waiting on credentials");
	});
});

describe("formatBlockedStatus (#0004)", () => {
	it("includes the objective, turns, tokens, and the blocker summary", () => {
		const out = formatBlockedStatus("deploy the service", "missing IAM role", 4, 12345);
		expect(out).toContain(`"deploy the service"`);
		expect(out).toContain("4 turn(s)");
		expect(out).toMatch(/12[,\u202f\u00a0]345 tokens used/);
		expect(out).toContain("missing IAM role");
		expect(out).toMatch(/blocked/i);
	});
});

describe("buildCheckerTranscript", () => {
	it("renders user/assistant turns into a labelled transcript", () => {
		const out = buildCheckerTranscript(
			[
				{ role: "user", content: "hello" },
				{ role: "assistant", content: "hi" },
			],
			GOAL_CONTEXT_MARKER,
		);
		expect(out).toContain("USER:\nhello");
		expect(out).toContain("ASSISTANT:\nhi");
	});

	it("strips goal-mode injected user messages so the checker sees only the agent's own work", () => {
		// Critical: if we left the kickoff/continue prompts in, the checker
		// would judge against our own loop language ("Make concrete progress
		// on this goal") instead of the agent's actual output, producing
		// garbage verdicts.
		const out = buildCheckerTranscript(
			[
				{
					role: "user",
					content: `${GOAL_CONTEXT_MARKER}\nGoal: x\n\nMake progress.`,
				},
				{ role: "assistant", content: "I did the thing." },
			],
			GOAL_CONTEXT_MARKER,
		);
		expect(out).not.toContain("Make progress");
		expect(out).toContain("I did the thing.");
	});

	it("handles array-shaped content (TextContent[]) by concatenating text parts", () => {
		const out = buildCheckerTranscript(
			[
				{
					role: "assistant",
					content: [
						{ type: "text", text: "part one" },
						{ type: "text", text: "part two" },
					],
				},
			],
			GOAL_CONTEXT_MARKER,
		);
		expect(out).toContain("part one\npart two");
	});

	it("ignores non-text content blocks (e.g. tool_use, image)", () => {
		const out = buildCheckerTranscript(
			[
				{
					role: "assistant",
					content: [
						{ type: "tool_use", name: "bash", input: { cmd: "ls" } },
						{ type: "text", text: "ran ls" },
					],
				},
			],
			GOAL_CONTEXT_MARKER,
		);
		expect(out).toContain("ran ls");
		expect(out).not.toContain("bash");
		expect(out).not.toContain("tool_use");
	});

	it("drops messages with empty rendered text", () => {
		const out = buildCheckerTranscript(
			[
				{ role: "assistant", content: [] },
				{ role: "assistant", content: "real text" },
			],
			GOAL_CONTEXT_MARKER,
		);
		// Only one ASSISTANT label; the empty one was dropped.
		expect(out.match(/ASSISTANT:/g)?.length).toBe(1);
	});

	it("keeps only the most recent N exchanges (sliding window)", () => {
		const messages = Array.from({ length: 20 }, (_, i) => ({
			role: i % 2 === 0 ? "user" : ("assistant" as const),
			content: `msg-${i}`,
		}));
		const out = buildCheckerTranscript(messages, GOAL_CONTEXT_MARKER, 2);
		// maxTurns=2 → window of 4 messages → last 4 of 20.
		expect(out).toContain("msg-19");
		expect(out).toContain("msg-16");
		expect(out).not.toContain("msg-15");
		expect(out).not.toContain("msg-0");
	});

	it("tolerates non-string non-array content silently (returns empty for that turn)", () => {
		const out = buildCheckerTranscript(
			[
				{ role: "assistant", content: 42 },
				{ role: "assistant", content: "real" },
			],
			GOAL_CONTEXT_MARKER,
		);
		expect(out.match(/ASSISTANT:/g)?.length).toBe(1);
		expect(out).toContain("real");
	});
});

describe("buildCheckerTranscript — system and unknown roles", () => {
	it("labels system messages as SYSTEM:", () => {
		const out = buildCheckerTranscript(
			[{ role: "system", content: "system instruction" }],
			"",
		);
		expect(out).toContain("SYSTEM:");
		expect(out).toContain("system instruction");
	});

	it("labels unknown roles as MESSAGE:", () => {
		const out = buildCheckerTranscript(
			[{ role: "tool", content: "tool output" }],
			"",
		);
		expect(out).toContain("MESSAGE:");
	});
});
