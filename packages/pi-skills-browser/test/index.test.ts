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
 * Builds a minimal ctx mock.
 */
function makeCtx(overrides: Record<string, unknown> = {}): ExtensionCommandContext {
	return {
		hasUI: true,
		ui: {
			notify: vi.fn(),
			custom: vi.fn().mockResolvedValue(undefined),
		},
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
	// Happy path: opens the TUI
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

// ---------------------------------------------------------------------------
// SkillEntry name: "skill:" prefix stripping
// ---------------------------------------------------------------------------

/**
 * Extract the render function from the callback that was passed to
 * `ctx.ui.custom`.  Calls the callback with a passthrough theme stub so the
 * rendered lines contain only plain text (no ANSI escapes), making assertions
 * straightforward.
 */
function captureRender(
	custom: ReturnType<typeof vi.fn>,
): (width: number) => string[] {
	const cb = custom.mock.calls[0]![0] as (
		tui: { requestRender: () => void },
		theme: { fg: (c: string, s: string) => string; bold: (s: string) => string },
		kb: unknown,
		done: () => void,
	) => { render: (w: number) => string[] };
	const theme = {
		fg: (_c: string, s: string) => s,
		bold: (s: string) => s,
	};
	const controller = cb({ requestRender: vi.fn() }, theme, undefined, vi.fn());
	return controller.render;
}

describe("SkillEntry name: 'skill:' prefix stripping", () => {
	it("strips 'skill:' prefix so the display name does not start with 'skill:'", async () => {
		const skillCommand = {
			name: "skill:my-skill",
			description: "A prefixed skill.",
			source: "skill",
			sourceInfo: { path: "/home/user/.pi/agent/skills/my-skill/SKILL.md" },
		};
		const { handler } = setup([skillCommand]);
		const custom = vi.fn().mockResolvedValue(undefined);
		const ctx = makeCtx({ ui: { notify: vi.fn(), custom } });

		await handler("", ctx);

		const render = captureRender(custom);
		const output = render(120).join("\n");

		expect(output).toContain("my-skill");
		expect(output).not.toMatch(/skill:my-skill/);
	});

	it("uses name as-is when there is no 'skill:' prefix", async () => {
		const skillCommand = {
			name: "my-skill",
			description: "An unprefixed skill.",
			source: "skill",
			sourceInfo: { path: "/home/user/.pi/agent/skills/my-skill/SKILL.md" },
		};
		const { handler } = setup([skillCommand]);
		const custom = vi.fn().mockResolvedValue(undefined);
		const ctx = makeCtx({ ui: { notify: vi.fn(), custom } });

		await handler("", ctx);

		const render = captureRender(custom);
		const output = render(120).join("\n");

		expect(output).toContain("my-skill");
	});

});

// ---------------------------------------------------------------------------
// Scope grouping: USER-SKILLS vs PROJECT sections
// ---------------------------------------------------------------------------

describe("scope grouping: USER-SKILLS and PROJECT sections", () => {
	it("groups skills into USER-SKILLS and PROJECT sections in order", async () => {
		const userSkillCommand = {
			name: "alpha",
			description: "A user skill.",
			source: "skill",
			sourceInfo: { path: "/home/user/.pi/agent/skills/alpha/SKILL.md" },
		};
		const projectSkillCommand = {
			name: "beta",
			description: "An agents skill.",
			source: "skill",
			sourceInfo: { path: "/home/user/.agents/skills/beta/SKILL.md" },
		};
		const { handler } = setup([userSkillCommand, projectSkillCommand]);
		const custom = vi.fn().mockResolvedValue(undefined);
		const ctx = makeCtx({ ui: { notify: vi.fn(), custom } });

		await handler("", ctx);

		const render = captureRender(custom);
		const output = render(120).join("\n");

		expect(output).toContain("USER-SKILLS");
		expect(output).toContain("PROJECT");
		expect(output.indexOf("USER-SKILLS")).toBeLessThan(output.indexOf("PROJECT"));
	});

	it("renders a project skill from an imported/non-standard path under PROJECT", async () => {
		const importedSkillCommand = {
			name: "imported",
			description: "A Claude Code imported skill.",
			source: "skill",
			sourceInfo: { path: "/home/user/.claude/skills/imported/SKILL.md" },
		};
		const { handler } = setup([importedSkillCommand]);
		const custom = vi.fn().mockResolvedValue(undefined);
		const ctx = makeCtx({ ui: { notify: vi.fn(), custom } });

		await handler("", ctx);

		const render = captureRender(custom);
		const output = render(120).join("\n");

		expect(output).toContain("PROJECT");
		expect(output).toContain("imported");
		expect(output).not.toContain("USER-SKILLS");
	});

	it("never renders a USER-AGENTS section, even for skills under ~/.pi/agent/agents/", async () => {
		const agentSkillCommand = {
			name: "agentish",
			description: "A skill living under the agents path.",
			source: "skill",
			sourceInfo: { path: "/home/user/.pi/agent/agents/some-agent/SKILL.md" },
		};
		const { handler } = setup([agentSkillCommand]);
		const custom = vi.fn().mockResolvedValue(undefined);
		const ctx = makeCtx({ ui: { notify: vi.fn(), custom } });

		await handler("", ctx);

		const render = captureRender(custom);
		const output = render(120).join("\n");

		expect(output).not.toContain("USER-AGENTS");
		expect(output).toContain("PROJECT");
		expect(output).toContain("agentish");
	});
});
