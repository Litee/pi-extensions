import { describe, expect, it } from "vitest";

import { buildCheckerTranscript } from "../src/helpers.js";
import { GOAL_CONTEXT_MARKER } from "../src/prompt.js";

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
