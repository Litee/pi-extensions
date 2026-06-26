/**
 * Integration-style tests for the pi-continual-learning extension wiring.
 *
 * We build a minimal ExtensionAPI stub (makePi) and ExtensionContext stub
 * (makeCtx) so we can drive the agent_end event handler without a live pi
 * runtime.
 *
 * Coverage focus:
 *  - Aborted/errored invocations → no sendMessage, no state change.
 *  - Successful invocations below thresholds → no sendMessage, turn counter incremented.
 *  - Successful invocations meeting all thresholds → sendMessage with correct
 *    customType + triggerTurn:true; state reset.
 *  - Re-firing with the same marker → dedup blocks second trigger.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { CONSOLIDATE_MESSAGE_TYPE } from "../src/message.js";
import { loadState } from "../src/state.js";
import piContinualLearning from "../src/index.js";

// ---------------------------------------------------------------------------
// Temp-home isolation
// ---------------------------------------------------------------------------

const TMP_HOME = join(tmpdir(), `pi-cl-idx-test-${process.pid}`);
let savedHome: string | undefined;
let savedEnvVars: Record<string, string | undefined> = {};

const ENV_KEYS = [
	"PI_CONTINUAL_LEARNING_MIN_TURNS",
	"PI_CONTINUAL_LEARNING_MIN_MINUTES",
	"PI_CONTINUAL_LEARNING_TRIAL",
	"PI_CONTINUAL_LEARNING_TRIAL_MIN_TURNS",
	"PI_CONTINUAL_LEARNING_TRIAL_MIN_MINUTES",
	"PI_CONTINUAL_LEARNING_TRIAL_WINDOW_HOURS",
] as const;

beforeEach(() => {
	savedHome = process.env["HOME"];
	mkdirSync(TMP_HOME, { recursive: true });
	process.env["HOME"] = TMP_HOME;

	// Snapshot + clear all extension env vars
	for (const key of ENV_KEYS) {
		savedEnvVars[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	rmSync(TMP_HOME, { recursive: true, force: true });
	if (savedHome !== undefined) {
		process.env["HOME"] = savedHome;
	} else {
		delete process.env["HOME"];
	}
	for (const key of ENV_KEYS) {
		const saved = savedEnvVars[key];
		if (saved !== undefined) {
			process.env[key] = saved;
		} else {
			delete process.env[key];
		}
	}
	savedEnvVars = {};
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

interface PiHarness {
	pi: ExtensionAPI;
	sendMessageMock: ReturnType<typeof vi.fn>;
	fireEvent: (name: string, event: unknown, ctx: unknown) => Promise<void>;
}

function makePi(): PiHarness {
	const sendMessageMock = vi.fn().mockResolvedValue(undefined);
	const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};

	const pi = {
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
			if (!handlers[name]) handlers[name] = [];
			handlers[name].push(handler);
		},
		sendMessage: sendMessageMock,
	} as unknown as ExtensionAPI;

	const fireEvent = async (name: string, event: unknown, ctx: unknown): Promise<void> => {
		for (const h of handlers[name] ?? []) {
			await h(event, ctx);
		}
	};

	return { pi, sendMessageMock, fireEvent };
}

interface CtxOpts {
	sessionId?: string;
	leafId?: string | null;
}

function makeCtx(opts: CtxOpts = {}): unknown {
	return {
		sessionManager: {
			getSessionId: () => opts.sessionId ?? "test-session",
			getLeafId: () => (opts.leafId !== undefined ? opts.leafId : "test-leaf"),
		},
	};
}

function makeAgentEndEvent(
	stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" = "stop",
): unknown {
	return {
		type: "agent_end",
		messages: [{ role: "assistant", stopReason }],
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set very low thresholds so a single successful turn triggers consolidation. */
function setLowThresholds() {
	process.env["PI_CONTINUAL_LEARNING_MIN_TURNS"] = "1";
	process.env["PI_CONTINUAL_LEARNING_MIN_MINUTES"] = "0";
}

/** Set thresholds high enough that a single turn never triggers. */
function setHighThresholds() {
	process.env["PI_CONTINUAL_LEARNING_MIN_TURNS"] = "100";
	process.env["PI_CONTINUAL_LEARNING_MIN_MINUTES"] = "9999";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pi-continual-learning — aborted / errored invocations", () => {
	it('does not sendMessage and does not change state on stopReason "error"', async () => {
		setLowThresholds();
		const { pi, sendMessageMock, fireEvent } = makePi();
		piContinualLearning(pi);

		await fireEvent("agent_end", makeAgentEndEvent("error"), makeCtx());

		expect(sendMessageMock).not.toHaveBeenCalled();
		// State file should not have been written (no turns incremented)
		const state = loadState();
		expect(state.turnsSinceLastRun).toBe(0);
	});

	it('does not sendMessage and does not change state on stopReason "aborted"', async () => {
		setLowThresholds();
		const { pi, sendMessageMock, fireEvent } = makePi();
		piContinualLearning(pi);

		await fireEvent("agent_end", makeAgentEndEvent("aborted"), makeCtx());

		expect(sendMessageMock).not.toHaveBeenCalled();
		const state = loadState();
		expect(state.turnsSinceLastRun).toBe(0);
	});

	it("does not sendMessage when messages array has no assistant message", async () => {
		setLowThresholds();
		const { pi, sendMessageMock, fireEvent } = makePi();
		piContinualLearning(pi);

		await fireEvent(
			"agent_end",
			{ type: "agent_end", messages: [{ role: "user" }] },
			makeCtx(),
		);

		expect(sendMessageMock).not.toHaveBeenCalled();
	});
});

describe("pi-continual-learning — successful invocation below thresholds", () => {
	it("increments turnsSinceLastRun and persists without sending a message", async () => {
		setHighThresholds();
		const { pi, sendMessageMock, fireEvent } = makePi();
		piContinualLearning(pi);

		await fireEvent("agent_end", makeAgentEndEvent("stop"), makeCtx());

		expect(sendMessageMock).not.toHaveBeenCalled();
		const state = loadState();
		expect(state.turnsSinceLastRun).toBe(1);
	});

	it("accumulates turns across multiple invocations (different markers)", async () => {
		setHighThresholds();
		const { pi, sendMessageMock, fireEvent } = makePi();
		piContinualLearning(pi);

		await fireEvent("agent_end", makeAgentEndEvent("stop"), makeCtx({ leafId: "leaf-1" }));
		await fireEvent("agent_end", makeAgentEndEvent("stop"), makeCtx({ leafId: "leaf-2" }));
		await fireEvent("agent_end", makeAgentEndEvent("stop"), makeCtx({ leafId: "leaf-3" }));

		expect(sendMessageMock).not.toHaveBeenCalled();
		const state = loadState();
		expect(state.turnsSinceLastRun).toBe(3);
	});
});

describe("pi-continual-learning — trigger consolidation", () => {
	it("sends exactly one message when all thresholds are met", async () => {
		setLowThresholds();
		const { pi, sendMessageMock, fireEvent } = makePi();
		piContinualLearning(pi);

		await fireEvent("agent_end", makeAgentEndEvent("stop"), makeCtx());

		expect(sendMessageMock).toHaveBeenCalledOnce();
		const [msgArg, optArg] = sendMessageMock.mock.calls[0] as [
			{ customType: string; content: string; display: boolean },
			{ triggerTurn: boolean },
		];
		expect(msgArg.customType).toBe(CONSOLIDATE_MESSAGE_TYPE);
		expect(typeof msgArg.content).toBe("string");
		expect(msgArg.content.length).toBeGreaterThan(0);
		expect(msgArg.display).toBe(true);
		expect(optArg.triggerTurn).toBe(true);
	});

	it("resets turnsSinceLastRun to 0 after triggering", async () => {
		setLowThresholds();
		const { pi, fireEvent } = makePi();
		piContinualLearning(pi);

		await fireEvent("agent_end", makeAgentEndEvent("stop"), makeCtx());

		const state = loadState();
		expect(state.turnsSinceLastRun).toBe(0);
	});

	it("sets lastRunAt to a non-null epoch timestamp after triggering", async () => {
		setLowThresholds();
		const before = Date.now();
		const { pi, fireEvent } = makePi();
		piContinualLearning(pi);

		await fireEvent("agent_end", makeAgentEndEvent("stop"), makeCtx());

		const state = loadState();
		expect(state.lastRunAt).not.toBeNull();
		expect(state.lastRunAt).toBeGreaterThanOrEqual(before);
	});

	it("sets processedMarker to currentMarker after triggering", async () => {
		setLowThresholds();
		const { pi, fireEvent } = makePi();
		piContinualLearning(pi);

		const ctx = makeCtx({ sessionId: "sess-x", leafId: "leaf-y" });
		await fireEvent("agent_end", makeAgentEndEvent("stop"), ctx);

		const state = loadState();
		expect(state.processedMarker).toBe("sess-x:leaf-y");
	});

	it("works with stopReason 'length' (also counts as success)", async () => {
		setLowThresholds();
		const { pi, sendMessageMock, fireEvent } = makePi();
		piContinualLearning(pi);

		await fireEvent("agent_end", makeAgentEndEvent("length"), makeCtx());

		expect(sendMessageMock).toHaveBeenCalledOnce();
	});

	it("works with stopReason 'toolUse' (also counts as success)", async () => {
		setLowThresholds();
		const { pi, sendMessageMock, fireEvent } = makePi();
		piContinualLearning(pi);

		await fireEvent("agent_end", makeAgentEndEvent("toolUse"), makeCtx());

		expect(sendMessageMock).toHaveBeenCalledOnce();
	});
});

describe("pi-continual-learning — deduplication (same marker)", () => {
	it("does not trigger again when re-fired with the same marker", async () => {
		setLowThresholds();
		const { pi, sendMessageMock, fireEvent } = makePi();
		piContinualLearning(pi);
		const ctx = makeCtx({ sessionId: "sess-1", leafId: "leaf-1" });

		// First invocation → triggers
		await fireEvent("agent_end", makeAgentEndEvent("stop"), ctx);
		expect(sendMessageMock).toHaveBeenCalledOnce();

		sendMessageMock.mockClear();

		// Second invocation with same context → dedup blocks it
		await fireEvent("agent_end", makeAgentEndEvent("stop"), ctx);
		expect(sendMessageMock).not.toHaveBeenCalled();
	});

	it("does not increment turnsSinceLastRun when marker is unchanged", async () => {
		setLowThresholds();
		const { pi, fireEvent } = makePi();
		piContinualLearning(pi);
		const ctx = makeCtx({ sessionId: "sess-1", leafId: "leaf-same" });

		// First call: triggers, resets turns to 0, sets processedMarker
		await fireEvent("agent_end", makeAgentEndEvent("stop"), ctx);

		// Second call with same marker: should skip entirely (dedup)
		await fireEvent("agent_end", makeAgentEndEvent("stop"), ctx);

		const state = loadState();
		// After first call state.turnsSinceLastRun was reset to 0.
		// Second call was deduped → turnsSinceLastRun stays 0.
		expect(state.turnsSinceLastRun).toBe(0);
	});

	it("triggers again when the marker changes after a dedup skip", async () => {
		setLowThresholds();
		const { pi, sendMessageMock, fireEvent } = makePi();
		piContinualLearning(pi);

		// First invocation with leaf-A → trigger, processedMarker = "s:leaf-A"
		await fireEvent("agent_end", makeAgentEndEvent("stop"), makeCtx({ leafId: "leaf-A" }));
		expect(sendMessageMock).toHaveBeenCalledOnce();

		sendMessageMock.mockClear();

		// New leaf → new marker → triggers again
		await fireEvent("agent_end", makeAgentEndEvent("stop"), makeCtx({ leafId: "leaf-B" }));
		expect(sendMessageMock).toHaveBeenCalledOnce();
	});
});

describe("pi-continual-learning — trial mode activation", () => {
	it("sets trialStartedAt when trial is requested and not yet initialised", async () => {
		process.env["PI_CONTINUAL_LEARNING_TRIAL"] = "1";
		// Set trial thresholds to 1 turn / 0 min so consolidation triggers immediately
		process.env["PI_CONTINUAL_LEARNING_TRIAL_MIN_TURNS"] = "1";
		process.env["PI_CONTINUAL_LEARNING_TRIAL_MIN_MINUTES"] = "0";

		const { pi, fireEvent } = makePi();
		piContinualLearning(pi);

		await fireEvent("agent_end", makeAgentEndEvent("stop"), makeCtx());

		const state = loadState();
		expect(state.trialStartedAt).not.toBeNull();
	});
});
