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

	// Case sensitivity — regex is lowercase only
	it("does NOT match uppercase FOCUSED.workspace_ref", () => {
		expect(
			containsFocusedWorkspaceRef('cmux new "$FOCUSED.workspace_ref"'),
		).toBe(false);
	});

	it("does NOT match mixed-case Focused.workspace_ref", () => {
		expect(
			containsFocusedWorkspaceRef('cmux new "$Focused.workspace_ref"'),
		).toBe(false);
	});

	it("does NOT match all-lowercase variant with extra prefix", () => {
		// my_focused.workspace_ref should still match — the regex finds the substring
		expect(
			containsFocusedWorkspaceRef('cmux new "$my_focused.workspace_ref"'),
		).toBe(true);
	});

	it("matches focused.workspace_ref embedded in a longer identifier", () => {
		expect(
			containsFocusedWorkspaceRef("ref=focused.workspace_ref; echo $ref"),
		).toBe(true);
	});

	it("matches focused.workspace_ref at the start of a command", () => {
		expect(
			containsFocusedWorkspaceRef("focused.workspace_ref is /path"),
		).toBe(true);
	});

	it("matches focused.workspace_ref at the end of a command", () => {
		expect(
			containsFocusedWorkspaceRef("echo $focused.workspace_ref"),
		).toBe(true);
	});

	it("matches focused.workspace_ref in the middle of a command", () => {
		expect(
			containsFocusedWorkspaceRef("cmd --ref focused.workspace_ref --flag"),
		).toBe(true);
	});

	it("handles a very long command", () => {
		const longCmd = "echo ".repeat(500) + "$focused.workspace_ref";
		expect(containsFocusedWorkspaceRef(longCmd)).toBe(true);
	});

	it("handles a command with special regex characters", () => {
		expect(
			containsFocusedWorkspaceRef('echo "[focused.workspace_ref]"'),
		).toBe(true);
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

	it("includes an empty command verbatim", () => {
		const msg = buildBlockReason("");
		expect(msg).toContain("Command attempted: ");
		expect(msg).toContain("CMUX RULE");
	});

	it("escapes no special characters — raw command in output", () => {
		const msg = buildBlockReason('echo "<$>&"');
		expect(msg).toContain('echo "<$>&"');
	});

	it("includes backtick in command", () => {
		const msg = buildBlockReason("echo `focused.workspace_ref`");
		expect(msg).toContain("echo `focused.workspace_ref`");
	});

	it("returns a multi-line string with structured sections", () => {
		const msg = buildBlockReason("test");
		const lines = msg.split("\n");
		// First line is the header
		expect(lines[0]).toContain("⛔ CMUX RULE");
		// Blank line after header
		expect(lines[2]).toContain("test");
		// Contains step-by-step instructions
		expect(msg).toContain("cmux identify --json");
		expect(msg).toContain("cmux commands");
	});

	it("handles very long commands without truncation", () => {
		const longCmd = "echo ".repeat(100) + "$focused.workspace_ref";
		const msg = buildBlockReason(longCmd);
		expect(msg).toContain(longCmd);
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
// bash tool — non-string commands are allowed through
// ---------------------------------------------------------------------------

describe("cmuxCliGuard — non-string command values", () => {
	it("allows null command", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "10",
				input: { command: null as unknown as string },
			},
			makeFakeCtx(),
		);
		expect(result).toBeUndefined();
	});

	it("allows number command", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "11",
				input: { command: 42 as unknown as string },
			},
			makeFakeCtx(),
		);
		expect(result).toBeUndefined();
	});

	it("allows object command", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "12",
				input: { command: { foo: "bar" } as unknown as string },
			},
			makeFakeCtx(),
		);
		expect(result).toBeUndefined();
	});

	it("allows undefined command", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "13",
				input: { command: undefined as unknown as string },
			},
			makeFakeCtx(),
		);
		expect(result).toBeUndefined();
	});

	it("allows boolean command", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "14",
				input: { command: true as unknown as string },
			},
			makeFakeCtx(),
		);
		expect(result).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// bash tool — empty and edge-case commands
// ---------------------------------------------------------------------------

describe("cmuxCliGuard — edge-case bash commands", () => {
	it("allows empty string command", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "15",
				input: { command: "" },
			},
			makeFakeCtx(),
		);
		expect(result).toBeUndefined();
	});

	it("allows whitespace-only command", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "16",
				input: { command: "   \t\n  " },
			},
			makeFakeCtx(),
		);
		expect(result).toBeUndefined();
	});

	it("blocks command with focused.workspace_ref in a heredoc", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "17",
				input: {
					command:
						"cat <<EOF\n$focused.workspace_ref\nEOF",
				},
			},
			makeFakeCtx(),
		) as { block: boolean; reason: string } | undefined;
		expect(result?.block).toBe(true);
	});

	it("blocks command with focused.workspace_ref in export", async () => {
		const pi = makeFakePi();
		createExtension(pi as never);
		const result = await pi.handlers.get("tool_call")!(
			{
				type: "tool_call",
				toolName: "bash",
				toolCallId: "18",
				input: {
					command: 'export WS_REF=$focused.workspace_ref',
				},
			},
			makeFakeCtx(),
		) as { block: boolean; reason: string } | undefined;
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("Command attempted");
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
