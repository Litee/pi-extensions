/**
 * notifySink unit tests — verify the queue → flush handshake against a
 * stub ExtensionAPI, with and without `ctx.ui`.
 */
import { describe, expect, it, vi } from "vitest";

import { createDefaultNotifySink } from "../src/notifySink.js";

interface CapturedHandlers {
	readonly handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
	readonly pi: { on: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> };
}

function makePi(): CapturedHandlers {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		on: vi.fn((name: string, h: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(name, h);
		}),
		sendMessage: vi.fn(),
	};
	return { handlers, pi };
}

describe("createDefaultNotifySink", () => {
	it("queues warnings before session_start, then both notifies the user AND publishes a chat message the LLM can see", async () => {
		const { handlers, pi } = makePi();
		const sink = createDefaultNotifySink(pi as never);
		// Two warnings queued before any session_start fires.
		sink("first", "warning");
		sink("second", "warning");
		expect(handlers.has("session_start")).toBe(true);

		const notify = vi.fn();
		const ctx = { cwd: "/", ui: { notify } };
		const handler = handlers.get("session_start");
		if (handler === undefined) throw new Error("no session_start handler");
		await handler({}, ctx);

		// Toast for the human.
		expect(notify).toHaveBeenCalledTimes(2);
		expect(notify).toHaveBeenNthCalledWith(1, "first", "warning");
		expect(notify).toHaveBeenNthCalledWith(2, "second", "warning");

		// Custom message for the LLM. Same payload, but on the session log so
		// the next user prompt's context will include the warnings.
		expect(pi.sendMessage).toHaveBeenCalledTimes(2);
		const calls = pi.sendMessage.mock.calls as Array<[
			{ customType: string; content: string; display: boolean; details?: Record<string, unknown> },
			{ triggerTurn?: boolean; deliverAs?: string },
		]>;
		for (const [msg, opts] of calls) {
			expect(msg.customType).toBe("pi-sandboxed-workflows:event");
			expect(msg.display).toBe(true);
			expect(msg.details?.["kind"]).toBe("startup-warning");
			expect(msg.details?.["name"]).toBe("framework");
			expect(opts.triggerTurn).toBe(false);
			expect(opts.deliverAs).toBeUndefined();
		}
		expect(calls[0]?.[0].content).toBe("first");
		expect(calls[1]?.[0].content).toBe("second");
	});

	it("still publishes warnings to the session log when ctx.ui is missing (non-interactive runtime), so the LLM sees them", async () => {
		const { handlers, pi } = makePi();
		const sink = createDefaultNotifySink(pi as never);
		sink("ignored-by-toast", "warning");
		const handler = handlers.get("session_start");
		if (handler === undefined) throw new Error("no session_start handler");
		await handler({}, { cwd: "/", ui: undefined });
		// No throw. sendMessage is still called so the warning hits the
		// session log even when there is no TUI to toast it.
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
		const [msg] = pi.sendMessage.mock.calls[0] as [
			{ content: string; details?: Record<string, unknown> },
		];
		expect(msg.content).toBe("ignored-by-toast");
		// Queue must be drained so a second session_start is a no-op.
		await handler({}, { cwd: "/", ui: undefined });
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("still publishes warnings to the session log when ctx.ui has no notify method", async () => {
		const { handlers, pi } = makePi();
		const sink = createDefaultNotifySink(pi as never);
		sink("x", "warning");
		const handler = handlers.get("session_start");
		if (handler === undefined) throw new Error("no session_start handler");
		await handler({}, { cwd: "/", ui: {} });
		expect(pi.sendMessage).toHaveBeenCalledTimes(1);
	});
});
