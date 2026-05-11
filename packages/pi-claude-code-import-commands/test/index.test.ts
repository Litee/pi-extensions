import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import createExtension from "../src/index.js";

type AnyHandler = (...args: unknown[]) => unknown;

function makeFakePi() {
	const handlers = new Map<string, AnyHandler>();
	return {
		on: vi.fn((event: string, handler: AnyHandler) => {
			handlers.set(event, handler);
		}),
		handlers,
	};
}

function makeCtx(cwd: string) {
	return {
		cwd,
		ui: { notify: vi.fn() },
	};
}

function mkdir(root: string, rel: string): string {
	const p = join(root, rel);
	mkdirSync(p, { recursive: true });
	return p;
}

function writeCommand(dir: string, name: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${name}.md`),
		`---\ndescription: fixture ${name}\n---\n\n# ${name}\n`,
	);
}

describe("extension default export", () => {
	let tmpRoot: string;
	let claudeDir: string;
	const origClaude = process.env["CLAUDE_CONFIG_DIR"];

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "pi-ccci-entry-"));
		claudeDir = mkdir(tmpRoot, "claude");
		process.env["CLAUDE_CONFIG_DIR"] = claudeDir;
	});

	afterEach(() => {
		if (origClaude === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
		else process.env["CLAUDE_CONFIG_DIR"] = origClaude;
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("subscribes to resources_discover", () => {
		const pi = makeFakePi();
		 
		createExtension(pi as any);
		expect(pi.handlers.has("resources_discover")).toBe(true);
	});

	it("resources_discover returns empty promptPaths when no commands dirs exist", async () => {
		const pi = makeFakePi();
		 
		createExtension(pi as any);
		const cwd = mkdir(tmpRoot, "project");
		const handler = pi.handlers.get("resources_discover")!;
		const result = (await handler(
			{ cwd, reason: "startup" },
			makeCtx(cwd),
		)) as { promptPaths: string[] };
		expect(result.promptPaths).toEqual([]);
	});

	it("resources_discover returns user commands dir when it exists", async () => {
		const userCmds = mkdir(tmpRoot, "claude/commands");
		writeCommand(userCmds, "my-cmd");
		const pi = makeFakePi();
		 
		createExtension(pi as any);
		const cwd = mkdir(tmpRoot, "project");
		const handler = pi.handlers.get("resources_discover")!;
		const result = (await handler(
			{ cwd, reason: "startup" },
			makeCtx(cwd),
		)) as { promptPaths: string[] };
		expect(result.promptPaths).toContain(userCmds);
	});

	it("resources_discover returns project commands dir when it exists", async () => {
		const cwd = mkdir(tmpRoot, "project");
		const projectCmds = mkdir(tmpRoot, "project/.claude/commands");
		writeCommand(projectCmds, "local-cmd");
		const pi = makeFakePi();
		 
		createExtension(pi as any);
		const handler = pi.handlers.get("resources_discover")!;
		const result = (await handler(
			{ cwd, reason: "startup" },
			makeCtx(cwd),
		)) as { promptPaths: string[] };
		expect(result.promptPaths).toContain(projectCmds);
	});

	it("resources_discover returns both dirs (user first) when both exist", async () => {
		const userCmds = mkdir(tmpRoot, "claude/commands");
		const cwd = mkdir(tmpRoot, "project");
		const projectCmds = mkdir(tmpRoot, "project/.claude/commands");
		const pi = makeFakePi();
		 
		createExtension(pi as any);
		const handler = pi.handlers.get("resources_discover")!;
		const result = (await handler(
			{ cwd, reason: "startup" },
			makeCtx(cwd),
		)) as { promptPaths: string[] };
		expect(result.promptPaths).toEqual([userCmds, projectCmds]);
	});

	it("resources_discover is a safe no-op when Claude Code is not installed", async () => {
		process.env["CLAUDE_CONFIG_DIR"] = join(tmpRoot, "nonexistent");
		const pi = makeFakePi();
		 
		createExtension(pi as any);
		const cwd = mkdir(tmpRoot, "project");
		const handler = pi.handlers.get("resources_discover")!;
		const result = (await handler(
			{ cwd, reason: "startup" },
			makeCtx(cwd),
		)) as { promptPaths: string[] };
		expect(result.promptPaths).toEqual([]);
	});

	it("resources_discover honors reload reason the same as startup", async () => {
		const userCmds = mkdir(tmpRoot, "claude/commands");
		writeCommand(userCmds, "reload-test");
		const pi = makeFakePi();
		 
		createExtension(pi as any);
		const cwd = mkdir(tmpRoot, "project");
		const handler = pi.handlers.get("resources_discover")!;
		const result = (await handler(
			{ cwd, reason: "reload" },
			makeCtx(cwd),
		)) as { promptPaths: string[] };
		expect(result.promptPaths).toEqual([userCmds]);
	});
});
