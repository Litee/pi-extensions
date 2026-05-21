import { describe, expect, it } from "vitest";

import {
	buildBudgetLimitMessage,
	buildCheckerUserPrompt,
	buildContinuationMessage,
	buildKickoffMessage,
	CHECKER_SYSTEM_PROMPT,
	GOAL_CONTEXT_MARKER,
} from "../src/prompt.js";

describe("buildKickoffMessage", () => {
	it("starts with the goal-context marker so the context filter can strip it later", () => {
		const msg = buildKickoffMessage("ship the feature");
		expect(msg.startsWith(`${GOAL_CONTEXT_MARKER}\n`)).toBe(true);
	});

	it("embeds the objective verbatim", () => {
		expect(buildKickoffMessage("ship the feature")).toContain("Goal: ship the feature");
	});

	it("tells the agent a separate checker decides completion", () => {
		// Critical: without this, Opus-class models often refuse to act on a
		// goal because they expect to declare completion themselves. Surface a
		// regression if the wording disappears.
		expect(buildKickoffMessage("x")).toMatch(/separate completion-checker/i);
	});
});

describe("buildContinuationMessage", () => {
	it("starts with the marker and embeds objective + iteration + token usage", () => {
		const out = buildContinuationMessage("write tests", 3, 100, 12345, 200000);
		expect(out.startsWith(`${GOAL_CONTEXT_MARKER}\n`)).toBe(true);
		expect(out).toContain("write tests");
		expect(out).toContain("turn 3/100");
		// Numbers are formatted with locale separators so callers see a
		// human-readable status instead of "12345/200000".
		expect(out).toContain("12,345");
		expect(out).toContain("200,000");
	});

	it("explains why we are continuing (checker said incomplete)", () => {
		expect(buildContinuationMessage("x", 1, 10, 0, 100)).toMatch(
			/checker .* not yet satisfied/i,
		);
	});

	// -- issue #0004: "Blocked audit" rules ported from upstream codex commit
	// 0d344ac (2026-05-18). The continuation prompt is the LLM-facing surface
	// where these rules live, so the model knows when calling
	// `update_goal({status:"blocked"})` is permitted.
	describe("Blocked audit rules (#0004)", () => {
		const sample = buildContinuationMessage("x", 1, 10, 0, 100);

		it("introduces a labelled Blocked audit section", () => {
			expect(sample).toMatch(/blocked audit/i);
		});

		it("references the update_goal tool", () => {
			expect(sample).toMatch(/update_goal/);
		});

		it("requires the same blocking condition for 3+ consecutive turns before blocking", () => {
			expect(sample).toMatch(/3\+? consecutive turns|three consecutive turns|3 consecutive turns/i);
		});

		it("warns the agent NOT to use blocked for hard, uncertain, or slow work", () => {
			expect(sample).toMatch(/hard/i);
			expect(sample).toMatch(/uncertain/i);
			expect(sample).toMatch(/slow/i);
			expect(sample).toMatch(/genuine impasse/i);
		});

		it("explains the blocked-counter resets on resume", () => {
			expect(sample).toMatch(/resume/i);
			expect(sample).toMatch(/reset/i);
		});

		it("explains that blocked pauses the loop and surfaces the blocker to the user", () => {
			expect(sample).toMatch(/pause/i);
			expect(sample).toMatch(/(surface|surfac)/i);
		});
	});
});

describe("buildBudgetLimitMessage", () => {
	it("flags this as the FINAL turn and tells the agent not to start new work", () => {
		const out = buildBudgetLimitMessage("refactor module", 200000, 200000);
		expect(out.startsWith(`${GOAL_CONTEXT_MARKER}\n`)).toBe(true);
		expect(out).toContain("refactor module");
		expect(out).toContain("FINAL");
		expect(out).toMatch(/do not start new work/i);
	});

	it("does NOT mention update_goal — the budget-limit turn is the wrap-up turn, not a completion-signal turn", () => {
		// Regression guard: even though `update_goal` is registered (#0004),
		// the budget_limit message is meant as a clean hand-off after the
		// budget is exhausted; we do NOT want the agent to call
		// `update_goal({summary})` purely because the budget ran
		// out, nor `blocked` simply because resources are tight.
		expect(buildBudgetLimitMessage("x", 1, 1)).not.toMatch(/update_goal/i);
	});
});

describe("buildCheckerUserPrompt", () => {
	it("frames the objective and transcript clearly for the checker", () => {
		const out = buildCheckerUserPrompt("answer the question", "ASSISTANT:\n42");
		expect(out).toContain("GOAL: answer the question");
		expect(out).toContain("--- recent transcript ---");
		expect(out).toContain("--- end transcript ---");
		expect(out).toContain("ASSISTANT:\n42");
		expect(out).toMatch(/strict JSON/i);
	});
});

describe("CHECKER_SYSTEM_PROMPT", () => {
	it("specifies the JSON schema the checker must emit", () => {
		expect(CHECKER_SYSTEM_PROMPT).toContain('"verdict"');
		expect(CHECKER_SYSTEM_PROMPT).toContain('"complete"');
		expect(CHECKER_SYSTEM_PROMPT).toContain('"incomplete"');
		expect(CHECKER_SYSTEM_PROMPT).toContain('"confidence"');
		expect(CHECKER_SYSTEM_PROMPT).toContain('"reason"');
	});

	it("carves out the trivial-Q&A case so calculations don't loop forever", () => {
		// Lesson learned from Codex's audit prompt being too strict for
		// "Calculate 2+2+2+2": demanding command output for pure-reasoning
		// goals trapped the loop. The checker explicitly accepts a stated
		// answer as evidence.
		expect(CHECKER_SYSTEM_PROMPT).toMatch(/trivial Q&A|stated answer/i);
	});

	it("rejects goal-shrinking", () => {
		expect(CHECKER_SYSTEM_PROMPT).toMatch(/do not shrink|do not paraphrase|judge against the goal as written/i);
	});
});
