import { describe, expect, it, vi } from "vitest";

import createExtension, { buildBlockReason } from "../src/index.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const SAMPLE_PORCELAIN = [
	"worktree /repo/main",
	"HEAD abc123",
	"branch refs/heads/main",
	"",
	"worktree /repo/main/.worktrees/my-branch",
	"HEAD def456",
	"branch refs/heads/my-branch",
	"",
].join("\n");

function makeExec(impl?: () => Promise<{ code: number; stdout: string }>) {
	return impl
		? vi.fn(impl)
		: vi.fn().mockResolvedValue({ code: 0, stdout: SAMPLE_PORCELAIN });
}

interface StubPi {
	on: ReturnType<typeof vi.fn>;
	exec: ReturnType<typeof vi.fn>;
	readonly handlers: Map<string, (...args: unknown[]) => unknown>;
}

function makeFakePi(execImpl?: () => Promise<{ code: number; stdout: string }>): StubPi {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const on = vi.fn((evt: string, fn: (...a: unknown[]) => unknown) => {
		handlers.set(evt, fn);
	});
	return {
		on,
		exec: makeExec(execImpl),
		handlers,
	};
}

function makeFakeCtx(cwd = "/repo/main") {
	return { cwd };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe("worktreeGuard — wiring", () => {
	it("subscribes to tool_call and session_start", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const subscribed = pi.on.mock.calls.map((c) => c[0] as string);
		expect(subscribed).toContain("tool_call");
		expect(subscribed).toContain("session_start");
	});
});

// ---------------------------------------------------------------------------
// edit tool
// ---------------------------------------------------------------------------

describe("worktreeGuard — edit tool", () => {
	it("allows edit to a worktree path", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{ type: "tool_call", toolName: "edit", toolCallId: "1", input: { path: "/repo/main/.worktrees/my-branch/src/foo.ts" } },
			makeFakeCtx(),
		);
		expect(result).toBeUndefined();
	});

	it("blocks edit to a main-repo path", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{ type: "tool_call", toolName: "edit", toolCallId: "2", input: { path: "/repo/main/src/foo.ts" } },
			makeFakeCtx(),
		) as { block: boolean; reason: string } | undefined;
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("WORKTREE GUARD");
		expect(result?.reason).toContain("/repo/main/src/foo.ts");
	});
});

// ---------------------------------------------------------------------------
// write tool
// ---------------------------------------------------------------------------

describe("worktreeGuard — write tool", () => {
	it("blocks write to a main-repo path", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{ type: "tool_call", toolName: "write", toolCallId: "3", input: { path: "/repo/main/src/foo.ts" } },
			makeFakeCtx(),
		) as { block: boolean; reason: string } | undefined;
		expect(result?.block).toBe(true);
	});

	it("allows write to a worktree path", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{ type: "tool_call", toolName: "write", toolCallId: "4", input: { path: "/repo/main/.worktrees/branch/bar.ts" } },
			makeFakeCtx(),
		);
		expect(result).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Fail-open when exec throws
// ---------------------------------------------------------------------------

describe("worktreeGuard — fail open", () => {
	it("allows edit to main-repo path when exec throws (fail open)", async () => {
		const pi = makeFakePi(() => { throw new Error("git not found"); });
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{ type: "tool_call", toolName: "edit", toolCallId: "5", input: { path: "/repo/main/src/foo.ts" } },
			makeFakeCtx(),
		);
		expect(result).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Cache reset on session_start
// ---------------------------------------------------------------------------

describe("worktreeGuard — cache reset", () => {
	it("re-runs exec after session_start resets the cache", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);

		// First tool_call triggers exec
		await pi.handlers.get("tool_call")!(
			{ type: "tool_call", toolName: "edit", toolCallId: "6", input: { path: "/repo/main/src/foo.ts" } },
			makeFakeCtx(),
		);
		expect(pi.exec).toHaveBeenCalledTimes(1);

		// Second tool_call uses cache — no new exec call
		await pi.handlers.get("tool_call")!(
			{ type: "tool_call", toolName: "edit", toolCallId: "7", input: { path: "/repo/main/src/foo.ts" } },
			makeFakeCtx(),
		);
		expect(pi.exec).toHaveBeenCalledTimes(1);

		// session_start resets cache
		await pi.handlers.get("session_start")!({}, makeFakeCtx());

		// Third tool_call triggers exec again
		await pi.handlers.get("tool_call")!(
			{ type: "tool_call", toolName: "edit", toolCallId: "8", input: { path: "/repo/main/src/foo.ts" } },
			makeFakeCtx(),
		);
		expect(pi.exec).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// Non-mutating tools are never blocked
// ---------------------------------------------------------------------------

describe("worktreeGuard — non-mutating tools", () => {
	it("never blocks bash tool calls", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{ type: "tool_call", toolName: "bash", toolCallId: "9", input: { command: "rm -rf /repo/main/src" } },
			makeFakeCtx(),
		);
		expect(result).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Non-string path is allowed through (guard clause)
// ---------------------------------------------------------------------------

describe("worktreeGuard — non-string path", () => {
	it("allows edit when path is null", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{ type: "tool_call", toolName: "edit", toolCallId: "10", input: { path: null } },
			makeFakeCtx(),
		);
		expect(result).toBeUndefined();
	});

	it("allows edit when path is a number", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{ type: "tool_call", toolName: "edit", toolCallId: "11", input: { path: 42 } },
			makeFakeCtx(),
		);
		expect(result).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// buildBlockReason
// ---------------------------------------------------------------------------

describe("buildBlockReason", () => {
	it("includes the file path and main root in the message", () => {
		const msg = buildBlockReason("/repo/main/src/index.ts", "/repo/main");
		expect(msg).toContain("/repo/main/src/index.ts");
		expect(msg).toContain("/repo/main");
		expect(msg).toContain("WORKTREE GUARD");
		expect(msg).toContain("git worktree add");
	});
});
