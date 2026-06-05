/**
 * WorkflowContext / host tests.
 *
 * `buildWorkflowHost(deps)` returns a {@link WorkflowContext} bound to:
 *  - a pi-like `sendMessage` callable (for `publish()`);
 *  - a stable `runId`;
 *  - the runtime args + cwd + AbortSignal handed to the workflow.
 *
 * `publish()` must forward each event through `sendMessage` as a custom-typed
 * message that does NOT trigger an LLM turn.
 */
import { describe, expect, it, vi } from "vitest";

import { buildWorkflowHost, EVENT_CUSTOM_TYPE } from "../src/host.js";
import { createWorktree } from "../src/engine/worktree.js";

interface SentMessage {
	readonly message: {
		readonly customType: string;
		readonly content: string;
		readonly display: boolean;
		readonly details?: Record<string, unknown>;
	};
	readonly options:
		| {
				readonly triggerTurn?: boolean;
				readonly deliverAs?: string;
		  }
		| undefined;
}

function makeSendMessage(): {
	sendMessage: (m: unknown, o?: unknown) => void;
	sent: SentMessage[];
} {
	const sent: SentMessage[] = [];
	const sendMessage = vi.fn((m: unknown, o?: unknown) => {
		sent.push({
			message: m as SentMessage["message"],
			options: o as SentMessage["options"],
		});
	});
	return { sendMessage, sent };
}

function baseOpts(
	sendMessage: (m: unknown, o?: unknown) => void,
	extra: Record<string, unknown> = {},
) {
	return {
		name: "implement",
		args: "make X work",
		cwd: "/some/cwd",
		runId: "run-123",
		signal: new AbortController().signal,
		sendMessage: sendMessage as Parameters<typeof buildWorkflowHost>[0]["sendMessage"],
		...extra,
	};
}

describe("buildWorkflowHost", () => {
	it("exposes a createWorktree wrapper that injects onMergeFailure", () => {
		const { sendMessage } = makeSendMessage();
		const host = buildWorkflowHost(baseOpts(sendMessage));
		// Must be a wrapper function (not the raw import) so it can inject onMergeFailure.
		expect(typeof host.createWorktree).toBe("function");
		expect(host.createWorktree).not.toBe(createWorktree);
	});

	it("exposes the standard runtime fields", () => {
		const ac = new AbortController();
		const { sendMessage } = makeSendMessage();
		const host = buildWorkflowHost({
			name: "implement",
			args: "make X work",
			cwd: "/some/cwd",
			runId: "run-123",
			signal: ac.signal,
			sendMessage,
		});
		expect(host.name).toBe("implement");
		expect(host.args).toBe("make X work");
		expect(host.cwd).toBe("/some/cwd");
		expect(host.runId).toBe("run-123");
		expect(host.signal).toBe(ac.signal);
	});

	it("exposes createSandbox as a top-level function", () => {
		const { sendMessage } = makeSendMessage();
		const host = buildWorkflowHost(baseOpts(sendMessage));
		expect(typeof host.createSandbox).toBe("function");
	});

	it("exposes createNoOpSandbox as a top-level function", () => {
		const { sendMessage } = makeSendMessage();
		const host = buildWorkflowHost(baseOpts(sendMessage));
		expect(typeof host.createNoOpSandbox).toBe("function");
	});

	it("exposes createFakeSandbox as a top-level function", () => {
		const { sendMessage } = makeSendMessage();
		const host = buildWorkflowHost(baseOpts(sendMessage));
		expect(typeof host.createFakeSandbox).toBe("function");
	});

	it("does NOT expose a sandbox namespace on the context", () => {
		const { sendMessage } = makeSendMessage();
		const host = buildWorkflowHost(baseOpts(sendMessage));
		expect((host as unknown as Record<string, unknown>)["sandbox"]).toBeUndefined();
	});

	it("does NOT expose tools or sandcastle on the context", () => {
		const { sendMessage } = makeSendMessage();
		const host = buildWorkflowHost(baseOpts(sendMessage));
		expect((host as unknown as Record<string, unknown>)["tools"]).toBeUndefined();
		expect((host as unknown as Record<string, unknown>)["sandcastle"]).toBeUndefined();
	});

	it("exposes runAgent as a function", () => {
		const { sendMessage } = makeSendMessage();
		const host = buildWorkflowHost(baseOpts(sendMessage));
		expect(typeof host.runAgent).toBe("function");
	});

	it("exposes askUser as a function", () => {
		const { sendMessage } = makeSendMessage();
		const host = buildWorkflowHost(baseOpts(sendMessage));
		expect(typeof host.askUser).toBe("function");
	});
});

describe("WorkflowContext.publishStatusUpdate", () => {
	it("emits a custom-typed message that does NOT trigger an LLM turn", () => {
		const { sendMessage, sent } = makeSendMessage();
		const host = buildWorkflowHost(baseOpts(sendMessage));

		host.publishStatusUpdate({ kind: "started", message: "Started implement" });

		expect(sent).toHaveLength(1);
		const [first] = sent;
		expect(first?.message.customType).toBe(EVENT_CUSTOM_TYPE);
		expect(first?.message.display).toBe(false);
		expect(first?.message.content).toBe("Started implement");
		expect(first?.options?.triggerTurn).toBe(false);
		expect(first?.options?.deliverAs).toBeUndefined();
	});

	it("fires notify for kind:'error' events", () => {
		const { sendMessage } = makeSendMessage();
		const notify = vi.fn();
		const host = buildWorkflowHost({
			...baseOpts(sendMessage),
			notify,
		});
		host.publishStatusUpdate({ kind: "error", message: "plan step failed" });
		expect(notify).toHaveBeenCalledWith("plan step failed", "error");
	});

	it("does NOT call notify for non-error events", () => {
		const { sendMessage } = makeSendMessage();
		const notify = vi.fn();
		const host = buildWorkflowHost({ ...baseOpts(sendMessage), notify });
		host.publishStatusUpdate({ kind: "step", message: "step 1" });
		host.publishStatusUpdate({ kind: "completed", message: "done" });
		expect(notify).not.toHaveBeenCalled();
	});

	it("stamps runId, name, and details onto the payload", () => {
		const { sendMessage, sent } = makeSendMessage();
		const host = buildWorkflowHost({
			name: "implement",
			args: "x",
			cwd: "/cwd",
			runId: "run-42",
			signal: new AbortController().signal,
			sendMessage,
		});
		host.publishStatusUpdate({
			kind: "planner-done",
			message: "Plan ready",
			details: { plan: "1. foo" },
		});
		const details = sent[0]?.message.details;
		expect(details?.["runId"]).toBe("run-42");
		expect(details?.["name"]).toBe("implement");
		expect(details?.["kind"]).toBe("planner-done");
		expect(details?.["plan"]).toBe("1. foo");
	});

	it("supports events without a details payload", () => {
		const { sendMessage, sent } = makeSendMessage();
		const host = buildWorkflowHost(baseOpts(sendMessage));
		host.publishStatusUpdate({ kind: "completed", message: "done" });
		expect(sent[0]?.message.details?.["runId"]).toBe("run-123");
	});

	it("swallows errors from sendMessage so workflows never crash on UI failure", () => {
		const sendMessage = vi.fn(() => {
			throw new Error("UI down");
		});
		const host = buildWorkflowHost(baseOpts(sendMessage));
		expect(() => host.publishStatusUpdate({ kind: "started", message: "x" })).not.toThrow();
	});
});

describe("WorkflowContext.askUser", () => {
	it("throws when ui is absent (non-interactive mode)", async () => {
		const { sendMessage } = makeSendMessage();
		const host = buildWorkflowHost(baseOpts(sendMessage)); // no ui dep
		await expect(
			host.askUser({ kind: "confirm", text: "proceed?" }),
		).rejects.toThrow(/interactive/i);
	});

	it("throws when hasUI is false", async () => {
		const { sendMessage } = makeSendMessage();
		const host = buildWorkflowHost({
			...baseOpts(sendMessage),
			ui: {
				hasUI: false,
				input: vi.fn(),
				select: vi.fn(),
				confirm: vi.fn(),
			},
		});
		await expect(
			host.askUser({ kind: "input", text: "name?" }),
		).rejects.toThrow(/interactive/i);
	});

	it("dispatches input question via ui.input", async () => {
		const { sendMessage } = makeSendMessage();
		const uiInput = vi.fn().mockResolvedValue("alice");
		const host = buildWorkflowHost({
			...baseOpts(sendMessage),
			ui: { hasUI: true, input: uiInput, select: vi.fn(), confirm: vi.fn() },
		});
		const answer = await host.askUser({ kind: "input", text: "Your name?" });
		expect(answer).toEqual({ kind: "input", value: "alice" });
		expect(uiInput).toHaveBeenCalledWith("Your name?", undefined);
	});

	it("dispatches confirm question via ui.confirm", async () => {
		const { sendMessage } = makeSendMessage();
		const uiConfirm = vi.fn().mockResolvedValue(true);
		const host = buildWorkflowHost({
			...baseOpts(sendMessage),
			ui: { hasUI: true, input: vi.fn(), select: vi.fn(), confirm: uiConfirm },
		});
		const answer = await host.askUser({ kind: "confirm", text: "Continue?" });
		expect(answer).toEqual({ kind: "confirm", value: true });
	});

	it("dispatches select question via ui.select", async () => {
		const { sendMessage } = makeSendMessage();
		const uiSelect = vi.fn().mockResolvedValue("option-b");
		const host = buildWorkflowHost({
			...baseOpts(sendMessage),
			ui: { hasUI: true, input: vi.fn(), select: uiSelect, confirm: vi.fn() },
		});
		const answer = await host.askUser({
			kind: "select",
			text: "Pick:",
			options: ["option-a", "option-b"],
		});
		expect(answer).toEqual({ kind: "select", value: "option-b" });
	});

	it("throws when already aborted before the call", async () => {
		const { sendMessage } = makeSendMessage();
		const ac = new AbortController();
		ac.abort();
		const host = buildWorkflowHost({
			name: "n",
			args: "",
			cwd: ".",
			runId: "r",
			signal: ac.signal,
			sendMessage,
			ui: { hasUI: true, input: vi.fn(), select: vi.fn(), confirm: vi.fn() },
		});
		await expect(
			host.askUser({ kind: "confirm", text: "?" }),
		).rejects.toThrow(/Abort/i);
	});
});

describe("WorkflowContext.askUser — Esc cancel (regression: Bug 11)", () => {
	it("throws an AbortError (not a plain Error) when ui.select returns null (Esc)", async () => {
		const { sendMessage } = makeSendMessage();
		const host = buildWorkflowHost({
			...baseOpts(sendMessage),
			ui: {
				hasUI: true,
				input: vi.fn(),
				// Simulate Esc: return null from select
				select: vi.fn().mockResolvedValue(null),
				confirm: vi.fn(),
			},
		});

		let caught: unknown;
		try {
			await host.askUser({ kind: "select", text: "Pick one:", options: ["a", "b"] });
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeDefined();
		expect((caught as Error).name).toBe("AbortError");
	});

	it("uses the select default when ui.select returns null and a default is provided", async () => {
		const { sendMessage } = makeSendMessage();
		const host = buildWorkflowHost({
			...baseOpts(sendMessage),
			ui: {
				hasUI: true,
				input: vi.fn(),
				select: vi.fn().mockResolvedValue(null),
				confirm: vi.fn(),
			},
		});

		const answer = await host.askUser({
			kind: "select",
			text: "Pick one:",
			options: ["a", "b"],
			default: "a",
		});
		expect(answer).toEqual({ kind: "select", value: "a" });
	});

	it("uses q.default when ui.input returns null (Esc on input question, Bug #10)", async () => {
		const { sendMessage } = makeSendMessage();
		const host = buildWorkflowHost({
			...baseOpts(sendMessage),
			ui: {
				hasUI: true,
				input: vi.fn().mockResolvedValue(null),
				select: vi.fn(),
				confirm: vi.fn(),
			},
		});
		const answer = await host.askUser({ kind: "input", text: "Branch?", default: "main" });
		expect(answer).toEqual({ kind: "input", value: "main" });
	});

	it("returns empty string when ui.input returns null and no default (Bug #10)", async () => {
		const { sendMessage } = makeSendMessage();
		const host = buildWorkflowHost({
			...baseOpts(sendMessage),
			ui: {
				hasUI: true,
				input: vi.fn().mockResolvedValue(null),
				select: vi.fn(),
				confirm: vi.fn(),
			},
		});
		const answer = await host.askUser({ kind: "input", text: "Branch?" });
		expect(answer).toEqual({ kind: "input", value: "" });
	});
});
