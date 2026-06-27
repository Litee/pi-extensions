import { describe, expect, it, vi } from "vitest";

import createExtension, {
	buildBlockReason,
	containsFocusedWorkspaceRef,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface StubPi {
	on: ReturnType<typeof vi.fn>;
	readonly handlers: Map<string, (...args: unknown[]) => unknown>;
}

function makeFakePi(): StubPi {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const on = vi.fn((evt: string, fn: (...a: unknown[]) => unknown) => {
		handlers.set(evt, fn);
	});
	return { on, handlers };
}

function makeFakeCtx(cwd = "/repo") {
	return { cwd };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe("cmuxCliGuard — wiring", () => {
	it("subscribes to tool_call", () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const subscribed = pi.on.mock.calls.map((c) => c[0] as string);
		expect(subscribed).toContain("tool_call");
	});
});

// ---------------------------------------------------------------------------
// containsFocusedWorkspaceRef
// ---------------------------------------------------------------------------

describe("containsFocusedWorkspaceRef", () => {
	it("detects focused.workspace_ref in a simple command", () => {
		expect(
			containsFocusedWorkspaceRef(
				'cmux new --workspace $(echo "$focused.workspace_ref")',
			),
		).toBe(true);
	});

	it("detects focused.workspace_ref with double quotes", () => {
		expect(
			containsFocusedWorkspaceRef(
				'cmux switch "$focused.workspace_ref"',
			),
		).toBe(true);
	});

	it("detects focused.workspace_ref with single quotes", () => {
		expect(
			containsFocusedWorkspaceRef(
				"cmux switch '$focused.workspace_ref'",
			),
		).toBe(true);
	});

	it("detects multiple occurrences", () => {
		expect(
			containsFocusedWorkspaceRef(
				'echo "$focused.workspace_ref" | grep "$focused.workspace_ref"',
			),
		).toBe(true);
	});

	it("returns false for a plain command", () => {
		expect(containsFocusedWorkspaceRef("ls -la")).toBe(false);
	});

	it("returns false for a command with caller.workspace_ref", () => {
		expect(
			containsFocusedWorkspaceRef(
				'cmux switch "$caller.workspace_ref"',
			),
		).toBe(false);
	});

	it("returns false for an empty string", () => {
		expect(containsFocusedWorkspaceRef("")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// buildBlockReason
// ---------------------------------------------------------------------------

describe("buildBlockReason", () => {
	it("includes the command and guidance", () => {
		const msg = buildBlockReason('cmux new "$focused.workspace_ref"');
		expect(msg).toContain("CMUX RULE");
		expect(msg).toContain("focused.workspace_ref");
		expect(msg).toContain("caller.workspace_ref");
		expect(msg).toContain("cmux identify --json");
		expect(msg).toContain('cmux new "$focused.workspace_ref"');
	});
});

// ---------------------------------------------------------------------------
// bash tool — focused.workspace_ref blocked
// ---------------------------------------------------------------------------

describe("cmuxCliGuard — bash with focused.workspace_ref", () => {
	it("blocks bash command containing focused.workspace_ref", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "1",
				input: {
					command: 'cmux new --workspace "$focused.workspace_ref"',
				},
			},
			makeFakeCtx(),
		) as { block: boolean; reason: string } | undefined;
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("CMUX RULE");
		expect(result?.reason).toContain("caller.workspace_ref");
	});

	it("blocks when focused.workspace_ref appears in a pipeline", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "2",
				input: {
					command: 'echo "$focused.workspace_ref" | cmux switch',
				},
			},
			makeFakeCtx(),
		) as { block: boolean; reason: string } | undefined;
		expect(result?.block).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// bash tool — allowed through
// ---------------------------------------------------------------------------

describe("cmuxCliGuard — allowed commands", () => {
	it("allows bash command with caller.workspace_ref", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "3",
				input: {
					command: 'cmux switch "$caller.workspace_ref"',
				},
			},
			makeFakeCtx(),
		);
		expect(result).toBeUndefined();
	});

	it("allows plain bash commands", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "4",
				input: { command: "ls -la /tmp" },
			},
			makeFakeCtx(),
		);
		expect(result).toBeUndefined();
	});

	it("allows cmux identify --json (which outputs both refs)", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "5",
				input: { command: "cmux identify --json" },
			},
			makeFakeCtx(),
		);
		expect(result).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Non-bash tools are never blocked
// ---------------------------------------------------------------------------

describe("cmuxCliGuard — non-bash tools", () => {
	it("never blocks edit tool calls", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "edit",
				toolCallId: "6",
				input: {
					path: "/repo/src/file.ts",
					oldText: "hello",
					newText: "world",
				},
			},
			makeFakeCtx(),
		);
		expect(result).toBeUndefined();
	});

	it("never blocks read tool calls", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "read",
				toolCallId: "7",
				input: { path: "/repo/README.md" },
			},
			makeFakeCtx(),
		);
		expect(result).toBeUndefined();
	});
});
