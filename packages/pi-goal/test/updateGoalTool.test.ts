/**
 * Tests for the `update_goal` pi tool (issue #0004).
 *
 * `update_goal({summary})` is a blocked-only signal. The agent calls it
 * when it has hit a genuine, persistent impasse it cannot resolve without
 * external input. Completion is handled by the verifier after each turn —
 * this tool is not involved in the success path.
 *
 * These tests exercise:
 *   1. Schema validation — only `summary` is required; no status field.
 *   2. Every call routes to `onBlocked` with the summary verbatim.
 *   3. The tool result content + details are shaped consistently with other
 *      pi tools (so the TUI renders them sensibly).
 */

import { describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";

import {
	handleUpdateGoal,
	UpdateGoalParams,
	type UpdateGoalCallbacks,
} from "../src/updateGoalTool.js";

function makeCallbacks(): UpdateGoalCallbacks & {
	blockedMock: ReturnType<typeof vi.fn>;
} {
	const blockedMock = vi.fn();
	return { blockedMock, onBlocked: blockedMock };
}

describe("UpdateGoalParams schema (#0004)", () => {
	it("accepts status=blocked with a summary", () => {
		expect(Value.Check(UpdateGoalParams, { status: "blocked", summary: "missing credentials" })).toBe(true);
	});

	it("requires status", () => {
		expect(Value.Check(UpdateGoalParams, { summary: "missing credentials" })).toBe(false);
	});

	it("rejects status values other than blocked", () => {
		expect(Value.Check(UpdateGoalParams, { status: "complete", summary: "x" })).toBe(false);
		expect(Value.Check(UpdateGoalParams, { status: "done", summary: "x" })).toBe(false);
	});

	it("requires summary", () => {
		expect(Value.Check(UpdateGoalParams, { status: "blocked" })).toBe(false);
	});

	it("rejects non-string summary", () => {
		expect(Value.Check(UpdateGoalParams, { status: "blocked", summary: 42 })).toBe(false);
	});
});

describe("handleUpdateGoal (#0004)", () => {
	it("routes to onBlocked with the summary verbatim", async () => {
		const cbs = makeCallbacks();
		const result = await handleUpdateGoal(
			{ status: "blocked", summary: "missing IAM role to deploy" },
			cbs,
		);

		expect(cbs.blockedMock).toHaveBeenCalledOnce();
		expect(cbs.blockedMock).toHaveBeenCalledWith("missing IAM role to deploy");

		expect(result.details.ok).toBe(true);
		expect(result.content[0]?.type).toBe("text");
		expect(result.content[0]?.text).toContain("missing IAM role to deploy");
	});

	it("trims whitespace from summary before passing to the callback", async () => {
		const cbs = makeCallbacks();
		await handleUpdateGoal({ status: "blocked", summary: "  service is down  " }, cbs);
		expect(cbs.blockedMock).toHaveBeenCalledWith("service is down");
	});

	it("handles an empty summary gracefully", async () => {
		const cbs = makeCallbacks();
		const result = await handleUpdateGoal({ status: "blocked", summary: "" }, cbs);
		expect(cbs.blockedMock).toHaveBeenCalledWith("");
		expect(result.details.ok).toBe(true);
	});
});
