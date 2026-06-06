import type { BuildSystemPromptOptions, ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import toolInfoExtension from "../src/index.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function mkTool(name: string): ToolInfo {
	return {
		name,
		description: `Description for ${name}`,
		parameters: {},
		sourceInfo: {
			source: "builtin",
			path: `<builtin:${name}>`,
			scope: "temporary",
			origin: "top-level",
		},
	} as ToolInfo;
}

interface FakeCommandSpec {
	description: string;
	handler: (args: string, ctx: unknown) => Promise<void>;
	getArgumentCompletions?: (prefix: string) => unknown;
}

function makeFakePi(tools: ToolInfo[] = [mkTool("read"), mkTool("write")]) {
	const commands = new Map<string, FakeCommandSpec>();
	const handlers = new Map<string, (...args: unknown[]) => unknown>();

	const pi = {
		getAllTools: vi.fn(() => tools),
		getActiveTools: vi.fn(() => tools.map((t) => t.name)),
		setActiveTools: vi.fn(),
		appendEntry: vi.fn(),
		registerCommand: vi.fn((name: string, spec: FakeCommandSpec) => {
			commands.set(name, spec);
		}),
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			handlers.set(event, handler);
		}),
		commands,
		handlers,
	};

	return pi;
}

function makeFakeCtx(overrides: Record<string, unknown> = {}) {
	return {
		hasUI: false,
		ui: {
			notify: vi.fn(),
			theme: {
				fg: (_: string, s: string) => s,
				bold: (s: string) => s,
			},
			custom: vi.fn().mockResolvedValue(null),
		},
		sessionManager: {
			getBranch: vi.fn(() => []),
		},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pi-tools /tools command — getSystemPromptOptions guard", () => {
	it("shows error notification and returns when getSystemPromptOptions is absent", async () => {
		const pi = makeFakePi();
		toolInfoExtension(pi as unknown as ExtensionAPI);

		const toolsCmd = pi.commands.get("tools");
		expect(toolsCmd).toBeDefined();

		const ctx = makeFakeCtx();
		// ctx does NOT have getSystemPromptOptions
		await toolsCmd!.handler("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"This command requires pi 0.78.0 or later",
			"error",
		);
	});

	it("does not show the version error when getSystemPromptOptions is present", async () => {
		const pi = makeFakePi();
		toolInfoExtension(pi as unknown as ExtensionAPI);

		const toolsCmd = pi.commands.get("tools");
		expect(toolsCmd).toBeDefined();

		const getSystemPromptOptions = vi.fn(
			(): BuildSystemPromptOptions => ({ cwd: "/", selectedTools: ["read"] }),
		);
		const ctx = makeFakeCtx({ getSystemPromptOptions });

		// The command will proceed past the guard and reach ctx.ui.custom (the
		// interactive selector). We let it resolve to null (user cancels) via
		// the mock, so the handler exits cleanly without further side-effects.
		await toolsCmd!.handler("", ctx);

		expect(ctx.ui.notify).not.toHaveBeenCalledWith(
			"This command requires pi 0.78.0 or later",
			"error",
		);
		expect(getSystemPromptOptions).toHaveBeenCalled();
	});
});
