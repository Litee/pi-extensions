/**
 * Tests for the config module that backs
 * `~/.pi/agent/pi-sandboxed-workflows.json`.
 *
 * Behaviour under test:
 *  - First-run bootstrap: creates the file with a single default directory.
 *  - Existing file: reads the directories array, expands `~`.
 *  - Bad JSON / bad shape: surfaces a useful error.
 *  - Empty directories array: surfaces a useful error.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	CONFIG_FILE_NAME,
	defaultConfigPath,
	expandTilde,
	loadOrInitConfig,
	projectWorkflowsDir,
} from "../src/config.js";

describe("expandTilde", () => {
	it("returns the input unchanged when it does not start with ~", () => {
		expect(expandTilde("/abs/path", "/Users/me")).toBe("/abs/path");
		expect(expandTilde("relative/path", "/Users/me")).toBe("relative/path");
	});

	it("expands a bare ~ to the home directory", () => {
		expect(expandTilde("~", "/Users/me")).toBe("/Users/me");
	});

	it("expands ~/foo to <home>/foo", () => {
		expect(expandTilde("~/foo/bar", "/Users/me")).toBe("/Users/me/foo/bar");
	});

	it("does NOT expand ~user/foo (we do not support per-user expansion)", () => {
		expect(expandTilde("~bob/foo", "/Users/me")).toBe("~bob/foo");
	});
});

describe("defaultConfigPath", () => {
	it("returns <home>/.pi/agent/<file>", () => {
		const out = defaultConfigPath("/Users/me");
		expect(out).toBe(`/Users/me/.pi/agent/${CONFIG_FILE_NAME}`);
	});

	it("uses the canonical file name pi-sandboxed-workflows.json", () => {
		expect(CONFIG_FILE_NAME).toBe("pi-sandboxed-workflows.json");
	});
});

describe("loadOrInitConfig", () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "pi-sw-cfg-"));
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("creates the config file with a default directories array on first run", () => {
		const out = loadOrInitConfig({ homedir: home });
		expect(out.directories).toEqual([
			`${home}/.pi/agent/sandboxed-workflows`,
		]);
		// File must exist on disk after first call.
		const path = `${home}/.pi/agent/${CONFIG_FILE_NAME}`;
		expect(existsSync(path)).toBe(true);
		const written = JSON.parse(readFileSync(path, "utf8")) as { directories: string[] };
		// Stored with `~` for readability.
		expect(written.directories).toEqual(["~/.pi/agent/sandboxed-workflows"]);
	});

	it("reads existing config and expands tildes", () => {
		const dir = `${home}/.pi/agent`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			`${dir}/${CONFIG_FILE_NAME}`,
			JSON.stringify({
				directories: ["~/.pi/agent/sandboxed-workflows", "/abs/path", "~/extra"],
			}),
		);
		const out = loadOrInitConfig({ homedir: home });
		expect(out.directories).toEqual([
			`${home}/.pi/agent/sandboxed-workflows`,
			"/abs/path",
			`${home}/extra`,
		]);
	});

	it("does NOT overwrite an existing config file even if it has different content", () => {
		const dir = `${home}/.pi/agent`;
		mkdirSync(dir, { recursive: true });
		const path = `${dir}/${CONFIG_FILE_NAME}`;
		writeFileSync(path, JSON.stringify({ directories: ["/custom"] }));
		const before = readFileSync(path, "utf8");
		loadOrInitConfig({ homedir: home });
		const after = readFileSync(path, "utf8");
		expect(after).toBe(before);
	});

	it("throws a clear error when the JSON is malformed, naming the path", () => {
		const dir = `${home}/.pi/agent`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(`${dir}/${CONFIG_FILE_NAME}`, "{ this is not json");
		expect(() => loadOrInitConfig({ homedir: home })).toThrow(/pi-sandboxed-workflows\.json/);
	});

	it("throws a clear error when directories is missing", () => {
		const dir = `${home}/.pi/agent`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(`${dir}/${CONFIG_FILE_NAME}`, JSON.stringify({ foo: "bar" }));
		expect(() => loadOrInitConfig({ homedir: home })).toThrow(/directories/);
	});

	it("throws a clear error when directories is empty", () => {
		const dir = `${home}/.pi/agent`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(`${dir}/${CONFIG_FILE_NAME}`, JSON.stringify({ directories: [] }));
		expect(() => loadOrInitConfig({ homedir: home })).toThrow(/empty/i);
	});

	it("throws a clear error when directories contains non-strings", () => {
		const dir = `${home}/.pi/agent`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			`${dir}/${CONFIG_FILE_NAME}`,
			JSON.stringify({ directories: ["/ok", 42] }),
		);
		expect(() => loadOrInitConfig({ homedir: home })).toThrow(/string/i);
	});
});

describe("projectWorkflowsDir", () => {
	it("returns <cwd>/.pi/sandboxed-workflows", () => {
		expect(projectWorkflowsDir("/my/project")).toBe(
			"/my/project/.pi/sandboxed-workflows",
		);
	});

	it("works with an arbitrary tmpdir path", () => {
		const cwd = join(tmpdir(), "some-project");
		expect(projectWorkflowsDir(cwd)).toBe(join(cwd, ".pi", "sandboxed-workflows"));
	});
});

describe("loadOrInitConfig — cwd option (project-local dir)", () => {
	let home: string;
	let cwd: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "pi-sw-cfg-cwd-"));
		cwd = mkdtempSync(join(tmpdir(), "pi-sw-project-"));
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
	});

	it("prepends the project-local dir to the directories list", () => {
		const out = loadOrInitConfig({ homedir: home, cwd });
		const projectDir = join(cwd, ".pi", "sandboxed-workflows");
		expect(out.directories[0]).toBe(projectDir);
	});

	it("project-local dir comes before the global default dir (higher priority)", () => {
		const out = loadOrInitConfig({ homedir: home, cwd });
		const projectDir = join(cwd, ".pi", "sandboxed-workflows");
		const globalDir = join(home, ".pi", "agent", "sandboxed-workflows");
		expect(out.directories.indexOf(projectDir)).toBeLessThan(
			out.directories.indexOf(globalDir),
		);
	});

	it("does NOT duplicate the project-local dir if it is already listed in the JSON", () => {
		const projectDir = join(cwd, ".pi", "sandboxed-workflows");
		const agentDir = join(home, ".pi", "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, CONFIG_FILE_NAME),
			JSON.stringify({ directories: [projectDir, "/abs/extra"] }),
		);
		const out = loadOrInitConfig({ homedir: home, cwd });
		const count = out.directories.filter((d) => d === projectDir).length;
		expect(count).toBe(1);
		// And it must still be first.
		expect(out.directories[0]).toBe(projectDir);
	});

	it("without cwd the project-local dir is NOT prepended (legacy behaviour)", () => {
		const out = loadOrInitConfig({ homedir: home });
		const projectDir = join(cwd, ".pi", "sandboxed-workflows");
		expect(out.directories).not.toContain(projectDir);
		expect(out.directories).toHaveLength(1);
	});
});
