// ---------------------------------------------------------------------------
// Module mocks — declared before any imports
// ---------------------------------------------------------------------------

import { vi } from "vitest";

vi.mock("@earendil-works/pi-tui", () => ({
	matchesKey: vi.fn(() => false),
	truncateToWidth: vi.fn((s: string) => s),
}));

// ---------------------------------------------------------------------------
// Real imports (after mocks)
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import skillsBrowserExtension from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SkillsHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

/**
 * Registers the extension with a minimal pi mock and returns the /skills
 * command handler, plus a `getCommandsMock` for controlling what skills
 * `pi.getCommands()` returns.
 */
function setup(skillCommands: object[] = []) {
	let capturedHandler: SkillsHandler | undefined;
	const getCommandsMock = vi.fn().mockReturnValue(skillCommands);

	const pi = {
		registerCommand: vi.fn((_name: string, opts: { handler: SkillsHandler }) => {
			capturedHandler = opts.handler;
		}),
		getCommands: getCommandsMock,
	} as unknown as ExtensionAPI;

	skillsBrowserExtension(pi);
	if (!capturedHandler) throw new Error("skills command not registered");
	return { handler: capturedHandler, getCommandsMock };
}

/**
 * Builds a minimal ctx mock.  By default includes a working
 * `getSystemPromptOptions` so tests that don't care about that guard don't
 * need to worry about it.
 */
function makeCtx(overrides: Record<string, unknown> = {}): ExtensionCommandContext {
	return {
		hasUI: true,
		ui: {
			notify: vi.fn(),
			custom: vi.fn().mockResolvedValue(undefined),
		},
		getSystemPromptOptions: vi.fn().mockReturnValue({ skills: [] }),
		...overrides,
	} as unknown as ExtensionCommandContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("skillsBrowserExtension /skills handler", () => {
	// -----------------------------------------------------------------------
	// Guard: no UI
	// -----------------------------------------------------------------------

	it("notifies with 'warning' and returns early when hasUI is false", async () => {
		const { handler } = setup();
		const notify = vi.fn();
		const ctx = makeCtx({ hasUI: false, ui: { notify } });

		await handler("", ctx);

		expect(notify).toHaveBeenCalledWith(
			"Skills browser requires an interactive terminal",
			"warning",
		);
	});

	it("does not open the TUI when hasUI is false", async () => {
		const { handler } = setup();
		const custom = vi.fn().mockResolvedValue(undefined);
		const ctx = makeCtx({ hasUI: false, ui: { notify: vi.fn(), custom } });

		await handler("", ctx);

		expect(custom).not.toHaveBeenCalled();
	});

	// -----------------------------------------------------------------------
	// Guard: getSystemPromptOptions absent (pi < 0.78.0)
	// -----------------------------------------------------------------------

	it("notifies with 'error' when getSystemPromptOptions is absent", async () => {
		const { handler } = setup();
		const notify = vi.fn();
		// Build ctx without getSystemPromptOptions — simulates pi < 0.78.0
		const ctx = {
			hasUI: true,
			ui: { notify, custom: vi.fn().mockResolvedValue(undefined) },
		} as unknown as ExtensionCommandContext;

		await handler("", ctx);

		expect(notify).toHaveBeenCalledWith(
			"This feature requires pi 0.78.0 or later",
			"error",
		);
	});

	it("does not open the TUI when getSystemPromptOptions is absent", async () => {
		const { handler } = setup();
		const custom = vi.fn().mockResolvedValue(undefined);
		const ctx = {
			hasUI: true,
			ui: { notify: vi.fn(), custom },
		} as unknown as ExtensionCommandContext;

		await handler("", ctx);

		expect(custom).not.toHaveBeenCalled();
	});

	it("does not notify with error when getSystemPromptOptions IS present", async () => {
		// No skill commands → will hit the "No skills registered" warning instead,
		// but NOT the "requires pi 0.78.0" error.
		const { handler } = setup([]);
		const notify = vi.fn();
		const ctx = makeCtx({ ui: { notify, custom: vi.fn().mockResolvedValue(undefined) } });

		await handler("", ctx);

		expect(notify).not.toHaveBeenCalledWith(
			"This feature requires pi 0.78.0 or later",
			"error",
		);
	});

	// -----------------------------------------------------------------------
	// Guard: no skills registered
	// -----------------------------------------------------------------------

	it("notifies 'No skills registered' when getCommands returns nothing skill-sourced", async () => {
		const { handler } = setup([]); // no skill commands
		const notify = vi.fn();
		const ctx = makeCtx({ ui: { notify, custom: vi.fn().mockResolvedValue(undefined) } });

		await handler("", ctx);

		expect(notify).toHaveBeenCalledWith("No skills registered in this session", "warning");
	});

	// -----------------------------------------------------------------------
	// Happy path: getSystemPromptOptions influences inPrompt
	// -----------------------------------------------------------------------

	it("opens the TUI when at least one skill is registered", async () => {
		const skillCommand = {
			name: "brainstorming",
			description: "Explore ideas.",
			source: "skill",
			sourceInfo: { path: "/skills/brainstorming/SKILL.md" },
		};
		const { handler } = setup([skillCommand]);
		const custom = vi.fn().mockResolvedValue(undefined);
		const ctx = makeCtx({ ui: { notify: vi.fn(), custom } });

		await handler("", ctx);

		expect(custom).toHaveBeenCalled();
	});
});
