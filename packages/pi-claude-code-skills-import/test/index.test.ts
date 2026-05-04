import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import createExtension, { defaultStateFile, handleCcSkills } from "../src/index.js";
import type { DiscoveredSkill } from "../src/types.js";

type AnyHandler = (...args: unknown[]) => unknown;

interface FakeCommand {
	description?: string;
	handler: AnyHandler;
}

function makeFakePi() {
	const handlers = new Map<string, AnyHandler>();
	const commands = new Map<string, FakeCommand>();
	return {
		on: vi.fn((event: string, handler: AnyHandler) => {
			handlers.set(event, handler);
		}),
		registerCommand: vi.fn((name: string, spec: FakeCommand) => {
			commands.set(name, spec);
		}),
		handlers,
		commands,
	};
}

function makeCtx(cwd: string, reload = vi.fn()) {
	const notify = vi.fn();
	return {
		cwd,
		ui: {
			notify,
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
			custom: vi.fn(),
		},
		reload,
		_notify: notify,
		_reload: reload,
	};
}

function mkdir(root: string, rel: string): string {
	const p = join(root, rel);
	mkdirSync(p, { recursive: true });
	return p;
}

function writeSkill(dir: string, name: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: fixture ${name}.\n---\n\n# ${name}\n`,
	);
}

describe("defaultStateFile", () => {
	it("returns <home>/.pi/agent/extensions-data/pi-claude-code-skills-import.json when no env override", () => {
		expect(defaultStateFile({}, "/home/user")).toBe(
			"/home/user/.pi/agent/extensions-data/pi-claude-code-skills-import.json",
		);
	});

	it("returns the $PI_CLAUDE_SKILLS_STATE override when set to a non-empty string", () => {
		expect(
			defaultStateFile({ PI_CLAUDE_SKILLS_STATE: "/tmp/custom.json" }, "/home/user"),
		).toBe("/tmp/custom.json");
	});

	it("falls back to the default when the env override is the empty string", () => {
		expect(defaultStateFile({ PI_CLAUDE_SKILLS_STATE: "" }, "/home/user")).toBe(
			"/home/user/.pi/agent/extensions-data/pi-claude-code-skills-import.json",
		);
	});
});

describe("extension default export", () => {
	let tmpRoot: string;
	let claudeDir: string;
	let stateFile: string;
	const origClaude = process.env["CLAUDE_CONFIG_DIR"];
	const origState = process.env["PI_CLAUDE_SKILLS_STATE"];

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "pi-ccsi-entry-"));
		claudeDir = mkdir(tmpRoot, "claude");
		stateFile = join(tmpRoot, "state.json");
		process.env["CLAUDE_CONFIG_DIR"] = claudeDir;
		process.env["PI_CLAUDE_SKILLS_STATE"] = stateFile;
	});

	afterEach(() => {
		if (origClaude === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
		else process.env["CLAUDE_CONFIG_DIR"] = origClaude;
		if (origState === undefined) delete process.env["PI_CLAUDE_SKILLS_STATE"];
		else process.env["PI_CLAUDE_SKILLS_STATE"] = origState;
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("subscribes to resources_discover and registers /cc-skills-info", () => {
		const pi = makeFakePi();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake shape
		createExtension(pi as any);
		expect(pi.handlers.has("resources_discover")).toBe(true);
		expect(pi.commands.has("cc-skills-info")).toBe(true);
	});

	it("resources_discover returns all discovered paths when nothing is disabled", async () => {
		writeSkill(join(claudeDir, "skills", "alpha"), "alpha");
		const pi = makeFakePi();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake shape
		createExtension(pi as any);
		const ctx = makeCtx(mkdir(tmpRoot, "project"));
		const handler = pi.handlers.get("resources_discover")!;
		const result = (await handler({ cwd: ctx.cwd, reason: "startup" }, ctx)) as {
			skillPaths: string[];
		};
		expect(result.skillPaths).toEqual([join(claudeDir, "skills", "alpha")]);
		expect(ctx._notify).toHaveBeenCalledWith(
			expect.stringContaining("Claude Code skills: 1 loaded"),
			"info",
		);
	});

	it("resources_discover filters out disabled skills", async () => {
		writeSkill(join(claudeDir, "skills", "alpha"), "alpha");
		writeSkill(join(claudeDir, "skills", "beta"), "beta");
		writeFileSync(stateFile, JSON.stringify({ disabled: ["@user/alpha"] }));

		const pi = makeFakePi();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake shape
		createExtension(pi as any);
		const ctx = makeCtx(mkdir(tmpRoot, "project"));
		const handler = pi.handlers.get("resources_discover")!;
		const result = (await handler({ cwd: ctx.cwd, reason: "startup" }, ctx)) as {
			skillPaths: string[];
		};
		expect(result.skillPaths).toEqual([join(claudeDir, "skills", "beta")]);
		const summary = ctx._notify.mock.calls.find((c) =>
			String(c[0]).includes("Claude Code skills:"),
		);
		expect(String(summary?.[0])).toContain("1 disabled");
	});

	it("resources_discover emits a warning notify when there are name collisions", async () => {
		writeSkill(join(claudeDir, "skills", "dup"), "dup");
		const installPath = mkdir(tmpRoot, "claude/plugins/cache/owner/p/1.0.0");
		writeSkill(join(installPath, "skills", "dup"), "dup");
		writeFileSync(
			join(claudeDir, "plugins", "installed_plugins.json"),
			JSON.stringify({
				plugins: {
					"p@owner": [{ scope: "user", installPath, lastUpdated: "2025-01-01T00:00:00Z" }],
				},
			}),
		);
		const pi = makeFakePi();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake shape
		createExtension(pi as any);
		const ctx = makeCtx(mkdir(tmpRoot, "project"));
		const handler = pi.handlers.get("resources_discover")!;
		await handler({ cwd: ctx.cwd, reason: "startup" }, ctx);
		const warning = ctx._notify.mock.calls.find((c) => c[1] === "warning");
		expect(warning).toBeDefined();
		expect(String(warning?.[0])).toContain("collision");
		expect(String(warning?.[0])).toContain("dup");
	});

	it("resources_discover does not warn when there are no collisions", async () => {
		writeSkill(join(claudeDir, "skills", "unique"), "unique");
		const pi = makeFakePi();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake shape
		createExtension(pi as any);
		const ctx = makeCtx(mkdir(tmpRoot, "project"));
		const handler = pi.handlers.get("resources_discover")!;
		await handler({ cwd: ctx.cwd, reason: "startup" }, ctx);
		expect(ctx._notify.mock.calls.filter((c) => c[1] === "warning")).toHaveLength(0);
	});
});

describe("handleCcSkills (injectable picker)", () => {
	let tmpRoot: string;
	let claudeDir: string;
	let stateFile: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "pi-ccsi-cmd-"));
		claudeDir = mkdir(tmpRoot, "claude");
		stateFile = join(tmpRoot, "state.json");
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("passes discovered skills and current disabled set to the picker", async () => {
		writeSkill(join(claudeDir, "skills", "a"), "a");
		writeSkill(join(claudeDir, "skills", "b"), "b");
		writeFileSync(stateFile, JSON.stringify({ disabled: ["@user/a"] }));

		const ctx = makeCtx(mkdir(tmpRoot, "project"));
		let capturedArgs: { skills: DiscoveredSkill[]; disabled: Set<string> } | undefined;
		const picker = vi.fn(async (args: { skills: DiscoveredSkill[]; disabled: Set<string> }) => {
			capturedArgs = args;
		});

		await handleCcSkills({
			ctx: ctx as never,
			claudeDir,
			stateFile,
			picker,
		});

		expect(picker).toHaveBeenCalledTimes(1);
		expect(capturedArgs).toBeDefined();
		expect(capturedArgs!.skills.map((s) => s.qualifiedName).sort()).toEqual([
			"@user/a",
			"@user/b",
		]);
		expect([...capturedArgs!.disabled]).toEqual(["@user/a"]);
	});

	it("persists and reloads when the picker toggles a skill to disabled", async () => {
		writeSkill(join(claudeDir, "skills", "alpha"), "alpha");
		const reload = vi.fn();
		const ctx = makeCtx(mkdir(tmpRoot, "project"), reload);

		await handleCcSkills({
			ctx: ctx as never,
			claudeDir,
			stateFile,
			picker: async ({ onToggle }) => {
				onToggle("@user/alpha", "disabled");
			},
		});

		expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual({
			disabled: ["@user/alpha"],
		});
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it("does not reload when picker makes no change", async () => {
		writeSkill(join(claudeDir, "skills", "alpha"), "alpha");
		const reload = vi.fn();
		const ctx = makeCtx(mkdir(tmpRoot, "project"), reload);

		await handleCcSkills({
			ctx: ctx as never,
			claudeDir,
			stateFile,
			picker: async () => undefined,
		});

		expect(reload).not.toHaveBeenCalled();
	});

	it("does not reload when picker toggles to the already-current value (no-op)", async () => {
		writeSkill(join(claudeDir, "skills", "alpha"), "alpha");
		// alpha starts enabled; picker redundantly toggles it to "enabled".
		const reload = vi.fn();
		const ctx = makeCtx(mkdir(tmpRoot, "project"), reload);

		await handleCcSkills({
			ctx: ctx as never,
			claudeDir,
			stateFile,
			picker: async ({ onToggle }) => {
				onToggle("@user/alpha", "enabled");
			},
		});

		expect(reload).not.toHaveBeenCalled();
	});

	it("reloads when picker re-enables a previously disabled skill", async () => {
		writeSkill(join(claudeDir, "skills", "alpha"), "alpha");
		writeFileSync(stateFile, JSON.stringify({ disabled: ["@user/alpha"] }));

		const reload = vi.fn();
		const ctx = makeCtx(mkdir(tmpRoot, "project"), reload);

		await handleCcSkills({
			ctx: ctx as never,
			claudeDir,
			stateFile,
			picker: async ({ onToggle }) => {
				onToggle("@user/alpha", "enabled");
			},
		});

		expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual({ disabled: [] });
		expect(reload).toHaveBeenCalledTimes(1);
	});

	// -- issue #0004 (N4): debounce persistence until picker closes --
	it("persist is invoked exactly once per handleCcSkills even when the picker toggles many times (issue #0004)", async () => {
		writeSkill(join(claudeDir, "skills", "a"), "a");
		writeSkill(join(claudeDir, "skills", "b"), "b");
		writeSkill(join(claudeDir, "skills", "c"), "c");

		const ctx = makeCtx(mkdir(tmpRoot, "project"));
		const persist = vi.fn();

		await handleCcSkills({
			ctx: ctx as never,
			claudeDir,
			stateFile,
			persist,
			picker: async ({ onToggle }) => {
				onToggle("@user/a", "disabled");
				onToggle("@user/b", "disabled");
				onToggle("@user/c", "disabled");
				onToggle("@user/b", "enabled"); // flip back
			},
		});

		expect(persist).toHaveBeenCalledTimes(1);
		const [writtenFile, writtenSet] = persist.mock.calls[0] as [string, Set<string>];
		expect(writtenFile).toBe(stateFile);
		expect([...writtenSet].sort()).toEqual(["@user/a", "@user/c"]);
	});

	it("persist is NOT invoked when no toggle results in a net change (issue #0004)", async () => {
		writeSkill(join(claudeDir, "skills", "a"), "a");

		const ctx = makeCtx(mkdir(tmpRoot, "project"));
		const persist = vi.fn();

		await handleCcSkills({
			ctx: ctx as never,
			claudeDir,
			stateFile,
			persist,
			picker: async ({ onToggle }) => {
				onToggle("@user/a", "disabled");
				onToggle("@user/a", "enabled"); // net: no change
			},
		});

		expect(persist).not.toHaveBeenCalled();
	});
});
