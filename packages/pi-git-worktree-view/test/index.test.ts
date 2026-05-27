import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Mock the server module before importing the extension
vi.mock("../src/server.js", () => ({
	startServer: vi.fn(),
}));

import { startServer } from "../src/server.js";
import createExtension from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SessionStartHandler = (event: unknown, ctx: unknown) => Promise<void>;
type SessionShutdownHandler = (event: unknown, ctx: unknown) => void;

interface Handlers {
	session_start?: SessionStartHandler;
	session_shutdown?: SessionShutdownHandler;
}

function makePi(): {
	pi: ExtensionAPI;
	handlers: Handlers;
	sendMessage: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
} {
	const handlers: Handlers = {};
	const sendMessage = vi.fn();
	const appendEntry = vi.fn();

	const pi = {
		on: (event: string, handler: (e: unknown, ctx: unknown) => Promise<void> | void) => {
			if (event === "session_start") {
				handlers.session_start = handler as SessionStartHandler;
			} else if (event === "session_shutdown") {
				// Wrap to drop the Promise<void> return so no-misused-promises doesn't fire
				handlers.session_shutdown = (e: unknown, ctx: unknown) => { void handler(e, ctx); };
			}
		},
		sendMessage,
		appendEntry,
	} as unknown as ExtensionAPI;

	return { pi, handlers, sendMessage, appendEntry };
}

const ENTRY_TYPE = "git-worktree-view:port";

function makeCtx(entries: unknown[] = []) {
	return {
		cwd: "/fake/cwd",
		sessionManager: {
			getEntries: () => entries,
		},
	};
}

beforeEach(() => {
	vi.mocked(startServer).mockReset();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pi-git-worktree-view — session_start: server startup", () => {
	it("calls startServer with cwd and port 0 when no persisted port", async () => {
		vi.mocked(startServer).mockResolvedValue({ port: 3456, close: vi.fn() });
		const { pi, handlers } = makePi();
		createExtension(pi);
		await handlers.session_start!({}, makeCtx());
		expect(startServer).toHaveBeenCalledWith("/fake/cwd", 0);
	});

	it("reads preferred port from persisted session entry", async () => {
		vi.mocked(startServer).mockResolvedValue({ port: 8080, close: vi.fn() });
		const { pi, handlers } = makePi();
		createExtension(pi);
		const entries = [
			{ type: "custom", customType: ENTRY_TYPE, data: { port: 8080 } },
		];
		await handlers.session_start!({}, makeCtx(entries));
		expect(startServer).toHaveBeenCalledWith("/fake/cwd", 8080);
	});

	it("ignores entries with non-number port fields", async () => {
		vi.mocked(startServer).mockResolvedValue({ port: 9000, close: vi.fn() });
		const { pi, handlers } = makePi();
		createExtension(pi);
		const entries = [
			{ type: "custom", customType: ENTRY_TYPE, data: { port: "not-a-number" } },
		];
		await handlers.session_start!({}, makeCtx(entries));
		// preferredPort stays 0 because "not-a-number" is not typeof number
		expect(startServer).toHaveBeenCalledWith("/fake/cwd", 0);
	});

	it("persists the bound port via appendEntry on success", async () => {
		vi.mocked(startServer).mockResolvedValue({ port: 7777, close: vi.fn() });
		const { pi, handlers, appendEntry } = makePi();
		createExtension(pi);
		await handlers.session_start!({}, makeCtx());
		expect(appendEntry).toHaveBeenCalledWith(ENTRY_TYPE, { port: 7777 });
	});

	it("sends a display:true message with the URL on success", async () => {
		vi.mocked(startServer).mockResolvedValue({ port: 7777, close: vi.fn() });
		const { pi, handlers, sendMessage } = makePi();
		createExtension(pi);
		await handlers.session_start!({}, makeCtx());
		expect(sendMessage).toHaveBeenCalledOnce();
		const [msg] = sendMessage.mock.calls[0] as [{ content: string; display: boolean; customType: string }];
		expect(msg.display).toBe(true);
		expect(msg.content).toContain("localhost:7777");
		expect(msg.customType).toBe("git-worktree-view");
	});
});

describe("pi-git-worktree-view — session_start: error handling (regression for no-console lint fix)", () => {
	it("sends display:true error message when startServer throws", async () => {
		vi.mocked(startServer).mockRejectedValue(new Error("EADDRINUSE: address already in use"));
		const { pi, handlers, sendMessage } = makePi();
		createExtension(pi);
		await handlers.session_start!({}, makeCtx());
		expect(sendMessage).toHaveBeenCalledOnce();
		const [msg] = sendMessage.mock.calls[0] as [{ content: string; display: boolean }];
		expect(msg.display).toBe(true);
		expect(msg.content).toContain("Failed to start server");
		expect(msg.content).toContain("EADDRINUSE");
	});

	it("does NOT call appendEntry when server fails to start", async () => {
		vi.mocked(startServer).mockRejectedValue(new Error("Port in use"));
		const { pi, handlers, appendEntry } = makePi();
		createExtension(pi);
		await handlers.session_start!({}, makeCtx());
		expect(appendEntry).not.toHaveBeenCalled();
	});

	it("handles non-Error thrown values gracefully", async () => {
		vi.mocked(startServer).mockRejectedValue("a raw string error");
		const { pi, handlers, sendMessage } = makePi();
		createExtension(pi);
		await handlers.session_start!({}, makeCtx());
		const [msg] = sendMessage.mock.calls[0] as [{ content: string }];
		expect(msg.content).toContain("a raw string error");
	});
});

describe("pi-git-worktree-view — session_shutdown", () => {
	it("calls close() on the server handle", async () => {
		const close = vi.fn();
		vi.mocked(startServer).mockResolvedValue({ port: 5000, close });
		const { pi, handlers } = makePi();
		createExtension(pi);
		await handlers.session_start!({}, makeCtx());
		handlers.session_shutdown!({}, makeCtx());
		expect(close).toHaveBeenCalledOnce();
	});

	it("does not throw if session_shutdown fires before any session_start", () => {
		vi.mocked(startServer).mockResolvedValue({ port: 5001, close: vi.fn() });
		const { pi, handlers } = makePi();
		createExtension(pi);
		// session_shutdown without a prior session_start — handle is null
		expect(() => handlers.session_shutdown!({}, makeCtx())).not.toThrow();
	});

	it("sets handle to null after shutdown so a second shutdown is safe", async () => {
		const close = vi.fn();
		vi.mocked(startServer).mockResolvedValue({ port: 5002, close });
		const { pi, handlers } = makePi();
		createExtension(pi);
		await handlers.session_start!({}, makeCtx());
		handlers.session_shutdown!({}, makeCtx());
		handlers.session_shutdown!({}, makeCtx());
		expect(close).toHaveBeenCalledOnce();
	});
});
