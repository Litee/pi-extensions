import { describe, expect, it, vi } from "vitest";
import lengthGuardExtension from "../src/index.js";

/**
 * Build a minimal mock of the ExtensionAPI for testing.
 */
function createMockAPI() {
	const registeredHandlers: Record<string, Array<(...args: unknown[]) => unknown>> = {};
	const registeredCommands: Record<string, { description: string; handler: (...args: unknown[]) => unknown }> = {};

	const pi = {
		registerCommand: vi.fn((name: string, spec: { description: string; handler: (...args: unknown[]) => unknown }) => {
			registeredCommands[name] = spec;
		}),
		registerTool: vi.fn(),
		registerMessageRenderer: vi.fn(),
		registerShortcut: vi.fn(),
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			if (!registeredHandlers[event]) {
				registeredHandlers[event] = [];
			}
			registeredHandlers[event].push(handler);
		}),
		events: {
			on: vi.fn(),
			emit: vi.fn(),
		},
		sendMessage: vi.fn(() => {
			(pi as unknown as { sendMessageCalls: number }).sendMessageCalls += 1;
		}),
		sendMessageCalls: 0,
		appendEntry: vi.fn(),
		getAllTools: vi.fn(() => []),
		getActiveTools: vi.fn(() => []),
		setActiveTools: vi.fn(),
		getContextUsage: vi.fn(() => null),
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			setWidget: vi.fn(),
		},
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;

	return {
		pi,
		handlers: registeredHandlers,
		commands: registeredCommands,
	};
}

/**
 * Build a mock assistantMessageEvent for a given type and delta.
 */
function makeAssistantEvent(type: string, delta?: string) {
	const base = {
		type,
		contentIndex: 0,
		partial: { role: "assistant", content: [] } as unknown as import("@earendil-works/pi-ai").AssistantMessage,
	};
	if (type === "thinking_delta" || type === "text_delta") {
		return { ...base, delta: delta ?? "" };
	}
	return base;
}

/**
 * Build a mock message_update event.
 */
function makeMessageUpdateEvent(assistantEvent: unknown) {
	return {
		assistantMessageEvent: assistantEvent,
		message: {
			role: "assistant",
			content: [],
		},
	};
}

/**
 * Build a mock context with abort capability.
 */
function makeMockContext() {
	let aborted = false;
	const callHistory: Array<string> = [];
	return {
		signal: {
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			get aborted() {
				return aborted;
			},
		},
		abort: (() => {
			aborted = true;
			callHistory.push("abort");
		}) as ReturnType<typeof vi.fn>,
		isIdle: vi.fn(() => false),
		hasPendingMessages: vi.fn(() => false),
		getContextUsage: vi.fn(() => null),
		shutdown: vi.fn(),
		// Expose call history for tests
		_getCallHistory: () => callHistory,
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext & {
		_getCallHistory: () => Array<string>;
	};
}

describe("pi-llm-response-length-guard", () => {
	it("registers message_update and turn_end handlers", () => {
		const { handlers } = createMockAPI();
		lengthGuardExtension({
			on: (event: string, handler: (...args: unknown[]) => unknown) => {
				if (!handlers[event]) handlers[event] = [];
				handlers[event].push(handler);
			},
			registerCommand: vi.fn(),
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);

		expect(Object.keys(handlers)).toContain("message_update");
		expect(Object.keys(handlers)).toContain("turn_end");
	});

	it("registers the /llm-response-length-guard slash command", () => {
		const { commands } = createMockAPI();
		lengthGuardExtension({
			registerCommand: vi.fn((name: string, spec: { description: string; handler: (...args: unknown[]) => unknown }) => {
				commands[name] = spec;
			}),
			on: vi.fn(),
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);

		expect(commands).toHaveProperty("llm-response-length-guard");
		expect(commands["llm-response-length-guard"]!.description).toContain("length guard statistics");
	});

	it("does not interrupt when output is within limits", async () => {
		const { pi, handlers } = createMockAPI();
		lengthGuardExtension(pi);

		const handler = handlers["message_update"]?.[0];
		const ctx = makeMockContext();

		// Simulate a short thinking block
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("thinking_start")),
			ctx,
		);
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("thinking_delta", "Hello world")),
			ctx,
		);

		// Simulate a short response
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("text_start")),
			ctx,
		);
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("text_delta", "Short response")),
			ctx,
		);

		expect(ctx._getCallHistory()).not.toContain("abort");
		expect((pi as unknown as { sendMessageCalls: number }).sendMessageCalls).toBe(0);
	});

	it("does not call sendMessage on start/text_start/thinking_start events", async () => {
		const { pi, handlers } = createMockAPI();
		lengthGuardExtension(pi);

		const handler = handlers["message_update"]?.[0];
		const ctx = makeMockContext();

		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("thinking_start")),
			ctx,
		);
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("text_start")),
			ctx,
		);

		expect(ctx._getCallHistory()).not.toContain("abort");
		expect((pi as unknown as { sendMessageCalls: number }).sendMessageCalls).toBe(0);
	});

	it("interrupts when thinking exceeds the limit", async () => {
		const { pi, handlers } = createMockAPI();
		lengthGuardExtension(pi);

		const handler = handlers["message_update"]?.[0];
		const ctx = makeMockContext();

		// Simulate a long thinking block (exceeds 8192 chars)
		const longThinking = "x".repeat(16400);
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("thinking_start")),
			ctx,
		);
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("thinking_delta", longThinking)),
			ctx,
		);

		// Should have aborted
		expect(ctx._getCallHistory()).toContain("abort");
		// Should have sent a corrective message
		expect((pi as unknown as { sendMessageCalls: number }).sendMessageCalls).toBe(1);
		// Verify the message content
		const sentCalls = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
		expect(sentCalls.length).toBe(1);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		const sentMsg = sentCalls[0]![0];
		expect(typeof (sentMsg as { content: unknown }).content).toBe("object");
		const contentArr = (sentMsg as { content: Array<{ text: string }> }).content;
		expect(contentArr[0]!.text).toContain("thinking");
	});

	it("interrupts when response exceeds the limit", async () => {
		const { pi, handlers } = createMockAPI();
		lengthGuardExtension(pi);

		const handler = handlers["message_update"]?.[0];
		const ctx = makeMockContext();

		// Simulate a short thinking block
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("thinking_start")),
			ctx,
		);
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("thinking_delta", "Short thinking")),
			ctx,
		);

		// Switch to response
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("text_start")),
			ctx,
		);

		// Simulate a long response (exceeds 32768 chars)
		const longResponse = "y".repeat(32800);
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("text_delta", longResponse)),
			ctx,
		);

		expect(ctx._getCallHistory()).toContain("abort");
		expect((pi as unknown as { sendMessageCalls: number }).sendMessageCalls).toBe(1);
		const sentCalls = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
		expect(sentCalls.length).toBe(1);
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		const sentMsg = sentCalls[0]![0];
		expect(typeof (sentMsg as { content: unknown }).content).toBe("object");
		const contentArr = (sentMsg as { content: Array<{ text: string }> }).content;
		expect(contentArr[0]!.text).toContain("response");
	});

	it("only interrupts once per turn", async () => {
		const { pi, handlers } = createMockAPI();
		lengthGuardExtension(pi);

		const handler = handlers["message_update"]?.[0];
		const ctx = makeMockContext();

		// First chunk exceeds limit — triggers interrupt
		const chunk1 = "z".repeat(16400);
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("thinking_start")),
			ctx,
		);
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("thinking_delta", chunk1)),
			ctx,
		);

		const firstAbortCount = ctx._getCallHistory().filter((c) => c === "abort").length;

		// More chunks arrive — should NOT interrupt again
		const chunk2 = "z".repeat(16400);
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("thinking_delta", chunk2)),
			ctx,
		);

		expect(ctx._getCallHistory().filter((c) => c === "abort").length).toBe(firstAbortCount);
	});

	it("resets state on turn_end", async () => {
		const { pi, handlers } = createMockAPI();
		lengthGuardExtension(pi);

		const messageUpdateHandler = handlers["message_update"]?.[0];
		const turnEndHandler = handlers["turn_end"]?.[0];
		const ctx = makeMockContext();

		// Simulate thinking that exceeds the limit
		const longThinking = "x".repeat(16400);
		await messageUpdateHandler?.(
			makeMessageUpdateEvent(makeAssistantEvent("thinking_start")),
			ctx,
		);
		await messageUpdateHandler?.(
			makeMessageUpdateEvent(makeAssistantEvent("thinking_delta", longThinking)),
			ctx,
		);

		expect(ctx._getCallHistory()).toContain("abort");

		// End the turn — state should reset
		await turnEndHandler?.(undefined, undefined);

		// New thinking block should be able to interrupt again
		const chunk = "a".repeat(16400);
		await messageUpdateHandler?.(
			makeMessageUpdateEvent(makeAssistantEvent("thinking_start")),
			ctx,
		);
		await messageUpdateHandler?.(
			makeMessageUpdateEvent(makeAssistantEvent("thinking_delta", chunk)),
			ctx,
		);

		expect(ctx._getCallHistory().filter((c) => c === "abort").length).toBeGreaterThan(0);
	});

	it("ignores non-assistant messages", async () => {
		const { pi, handlers } = createMockAPI();
		lengthGuardExtension(pi);

		const handler = handlers["message_update"]?.[0];
		const ctx = makeMockContext();

		// User message — should be ignored
		await handler?.(
			{
				role: "user",
				message: {
					role: "user",
					content: [{ type: "text", text: "Hello" }],
				},
			},
			ctx,
		);

		expect(ctx._getCallHistory()).not.toContain("abort");
		expect((pi as unknown as { sendMessageCalls: number }).sendMessageCalls).toBe(0);
	});

	it("tracks interruption count in stats", async () => {
		const { pi, handlers } = createMockAPI();
		lengthGuardExtension(pi);

		const handler = handlers["message_update"]?.[0];
		const ctx = makeMockContext();

		// First interruption
		const chunk1 = "x".repeat(16400);
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("thinking_start")),
			ctx,
		);
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("thinking_delta", chunk1)),
			ctx,
		);
		expect(ctx._getCallHistory()).toContain("abort");

		// End turn and start new one
		const turnEndHandler = handlers["turn_end"]?.[0];
		await turnEndHandler?.(undefined, undefined);

		// Second interruption
		const ctx2 = makeMockContext();
		const chunk2 = "x".repeat(16400);
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("thinking_start")),
			ctx2,
		);
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("thinking_delta", chunk2)),
			ctx2,
		);
		expect(ctx2._getCallHistory()).toContain("abort");
	});

	it("tracks total chars monitored across turns", async () => {
		const { pi, handlers } = createMockAPI();
		lengthGuardExtension(pi);

		const handler = handlers["message_update"]?.[0];
		const turnEndHandler = handlers["turn_end"]?.[0];
		const ctx = makeMockContext();

		// First turn: short thinking + short response
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("thinking_start")),
			ctx,
		);
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("thinking_delta", "100chars".padEnd(100, "a"))),
			ctx,
		);
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("text_start")),
			ctx,
		);
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("text_delta", "200chars".padEnd(200, "b"))),
			ctx,
		);

		// End turn
		await turnEndHandler?.(undefined, undefined);

		// Second turn: another short response
		const ctx2 = makeMockContext();
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("text_start")),
			ctx2,
		);
		await handler?.(
			makeMessageUpdateEvent(makeAssistantEvent("text_delta", "300chars".padEnd(300, "c"))),
			ctx2,
		);
	});

	it("slash command handler calls ui.notify with stats", async () => {
		const { commands } = createMockAPI();
		lengthGuardExtension({
			registerCommand: vi.fn((name: string, spec: { description: string; handler: (...args: unknown[]) => unknown }) => {
				commands[name] = spec;
			}),
			on: vi.fn(),
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI);

		const notifyMock = vi.fn();
		const ctx = {
			ui: { notify: notifyMock },
		} as unknown as import("@earendil-works/pi-coding-agent").ExtensionCommandContext;

		await commands["llm-response-length-guard"]!.handler({}, ctx);

		expect(notifyMock).toHaveBeenCalled();
		const notified = (notifyMock as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
		expect(notified).toContain("LLM Response Length Guard");
		expect(notified).toContain("**Interruptions:** 0");
		expect(notified).toContain("Thresholds:");
		expect(notified).toContain("Corrective message:");
	});
});
