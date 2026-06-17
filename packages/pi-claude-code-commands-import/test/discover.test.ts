import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverCommandDirs } from "../src/discover.js";

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

describe("discoverCommandDirs", () => {
	let tmpRoot: string;
	let claudeDir: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "pi-ccci-discover-"));
		claudeDir = mkdir(tmpRoot, "claude");
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("returns [] when neither user nor project commands dir exists", () => {
		expect(discoverCommandDirs({ claudeDir })).toEqual([]);
	});

	it("returns [] when claudeDir does not exist at all", () => {
		expect(discoverCommandDirs({ claudeDir: join(tmpRoot, "nope") })).toEqual([]);
	});

	it("returns the user-level commands dir when it exists", () => {
		const userCmds = mkdir(tmpRoot, "claude/commands");
		expect(discoverCommandDirs({ claudeDir })).toEqual([userCmds]);
	});

	it("returns the project-level commands dir when cwd is supplied and the dir exists", () => {
		const cwd = mkdir(tmpRoot, "project");
		const projectCmds = mkdir(tmpRoot, "project/.claude/commands");
		expect(discoverCommandDirs({ claudeDir, cwd })).toEqual([projectCmds]);
	});

	it("returns both dirs (user first) when both exist", () => {
		const userCmds = mkdir(tmpRoot, "claude/commands");
		const cwd = mkdir(tmpRoot, "project");
		const projectCmds = mkdir(tmpRoot, "project/.claude/commands");
		expect(discoverCommandDirs({ claudeDir, cwd })).toEqual([userCmds, projectCmds]);
	});

	it("omits the project commands dir when cwd is undefined even if the dir exists on disk", () => {
		const cwd = mkdir(tmpRoot, "project");
		mkdir(tmpRoot, "project/.claude/commands");
		void cwd;
		expect(discoverCommandDirs({ claudeDir })).toEqual([]);
	});

	it("omits the project commands dir when it does not exist on disk", () => {
		const userCmds = mkdir(tmpRoot, "claude/commands");
		const cwd = mkdir(tmpRoot, "project");
		expect(discoverCommandDirs({ claudeDir, cwd })).toEqual([userCmds]);
	});

	it("omits the user commands dir when it does not exist on disk", () => {
		const cwd = mkdir(tmpRoot, "project");
		const projectCmds = mkdir(tmpRoot, "project/.claude/commands");
		expect(discoverCommandDirs({ claudeDir, cwd })).toEqual([projectCmds]);
	});

	it("works correctly when both dirs contain .md command files", () => {
		const userCmds = mkdir(tmpRoot, "claude/commands");
		writeCommand(userCmds, "global-cmd");
		const cwd = mkdir(tmpRoot, "project");
		const projectCmds = mkdir(tmpRoot, "project/.claude/commands");
		writeCommand(projectCmds, "local-cmd");
		expect(discoverCommandDirs({ claudeDir, cwd })).toEqual([userCmds, projectCmds]);
	});

	it("does not include subdirectories of the commands dirs as additional entries", () => {
		const userCmds = mkdir(tmpRoot, "claude/commands");
		mkdir(tmpRoot, "claude/commands/git");
		expect(discoverCommandDirs({ claudeDir })).toEqual([userCmds]);
	});
});
