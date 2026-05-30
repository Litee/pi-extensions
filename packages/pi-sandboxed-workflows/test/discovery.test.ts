/**
 * Discovery tests — find user-authored workflow scripts in a directory and
 * return `{ name, path }[]`.
 *
 * Discovery is fs-only: no `import()` of the workflow files at this stage,
 * so any side effects in the workflow source don't run during scanning.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findWorkflowScripts, discoverWorkflows } from "../src/discovery.js";

describe("findWorkflowScripts", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-sw-discovery-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writeWorkflow(name: string, contents = "export default async () => {};\n"): string {
		const path = join(dir, name);
		writeFileSync(path, contents);
		return path;
	}

	it("returns an empty list when the workflows dir is missing", () => {
		const missing = join(dir, "does-not-exist");
		const result = findWorkflowScripts(missing);
		expect(result.scripts).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	it("returns an empty list when the workflows dir is empty", () => {
		const result = findWorkflowScripts(dir);
		expect(result.scripts).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	it("discovers .ts files with valid names and returns absolute paths", () => {
		const p1 = writeWorkflow("implement.workflow.ts");
		const p2 = writeWorkflow("fix-bug.workflow.ts");
		const result = findWorkflowScripts(dir);
		const byName = new Map(result.scripts.map((s) => [s.name, s.path]));
		expect(byName.get("implement")).toBe(p1);
		expect(byName.get("fix-bug")).toBe(p2);
		expect(result.scripts).toHaveLength(2);
		// Sorted alphabetically for deterministic command-registration order.
		expect(result.scripts.map((s) => s.name)).toEqual(["fix-bug", "implement"]);
		expect(result.warnings).toEqual([]);
		// Absolute paths.
		for (const s of result.scripts) {
			expect(s.path.startsWith(sep)).toBe(true);
		}
	});

	it("ignores non-.ts files", () => {
		writeWorkflow("implement.workflow.ts");
		writeWorkflow("notes.md", "# notes\n");
		writeWorkflow("config.json", "{}\n");
		const result = findWorkflowScripts(dir);
		expect(result.scripts.map((s) => s.name)).toEqual(["implement"]);
		expect(result.warnings).toEqual([]);
	});

	it("ignores .d.ts type-declaration files", () => {
		writeWorkflow("implement.workflow.ts");
		writeWorkflow("types.d.ts", "export {};\n");
		const result = findWorkflowScripts(dir);
		expect(result.scripts.map((s) => s.name)).toEqual(["implement"]);
	});

	it("warns on filenames that cannot map to a /workflow:<name> command", () => {
		writeWorkflow("implement.workflow.ts");
		writeWorkflow("Bad.workflow.ts");
		writeWorkflow("9starts-with-digit.workflow.ts");
		writeWorkflow("has_underscore.workflow.ts");
		writeWorkflow("has space.workflow.ts");
		writeWorkflow(".dotfile.workflow.ts");
		const result = findWorkflowScripts(dir);
		expect(result.scripts.map((s) => s.name)).toEqual(["implement"]);
		expect(result.warnings).toHaveLength(5);
		// Each warning names the offending file.
		const offenders = result.warnings.map((w) => w.file).sort();
		expect(offenders).toEqual([
			".dotfile.workflow.ts",
			"9starts-with-digit.workflow.ts",
			"Bad.workflow.ts",
			"has space.workflow.ts",
			"has_underscore.workflow.ts",
		]);
	});

	it("does not recurse into subdirectories", () => {
		writeWorkflow("implement.workflow.ts");
		const subdir = join(dir, "nested");
		mkdirSync(subdir);
		writeFileSync(join(subdir, "nested.workflow.ts"), "export default async () => {};\n");
		const result = findWorkflowScripts(dir);
		expect(result.scripts.map((s) => s.name)).toEqual(["implement"]);
	});

	it("tags every script with its sourceDir", () => {
		writeWorkflow("implement.workflow.ts");
		const result = findWorkflowScripts(dir);
		expect(result.scripts).toHaveLength(1);
		expect(result.scripts[0]?.sourceDir).toBe(dir);
	});
});

describe("discoverWorkflows (multi-directory)", () => {
	let a: string;
	let b: string;
	let c: string;

	beforeEach(() => {
		a = mkdtempSync(join(tmpdir(), "pi-sw-disc-a-"));
		b = mkdtempSync(join(tmpdir(), "pi-sw-disc-b-"));
		c = mkdtempSync(join(tmpdir(), "pi-sw-disc-c-"));
	});

	afterEach(() => {
		rmSync(a, { recursive: true, force: true });
		rmSync(b, { recursive: true, force: true });
		rmSync(c, { recursive: true, force: true });
	});

	it("merges scripts from every directory and tags sourceDir", () => {
		writeFileSync(join(a, "alpha.workflow.ts"), "export default async () => {};\n");
		writeFileSync(join(b, "bravo.workflow.ts"), "export default async () => {};\n");
		writeFileSync(join(c, "charlie.workflow.ts"), "export default async () => {};\n");
		const result = discoverWorkflows([a, b, c]);
		expect(result.scripts.map((s) => s.name)).toEqual(["alpha", "bravo", "charlie"]);
		const byName = new Map(result.scripts.map((s) => [s.name, s.sourceDir]));
		expect(byName.get("alpha")).toBe(a);
		expect(byName.get("bravo")).toBe(b);
		expect(byName.get("charlie")).toBe(c);
		expect(result.warnings).toEqual([]);
	});

	it("earlier directories win on name collision and emit a warning naming both files", () => {
		writeFileSync(join(a, "hello.workflow.ts"), "export default async () => {};\n");
		writeFileSync(join(b, "hello.workflow.ts"), "export default async () => {};\n");
		const result = discoverWorkflows([a, b]);
		expect(result.scripts).toHaveLength(1);
		expect(result.scripts[0]?.sourceDir).toBe(a);
		expect(result.warnings).toHaveLength(1);
		const w = result.warnings[0]!;
		expect(w.reason).toMatch(/duplicate|collision|conflict|shadow/i);
		expect(w.reason).toContain(a);
		expect(w.reason).toContain(b);
	});

	it("propagates per-directory bad-name warnings", () => {
		writeFileSync(join(a, "ok.workflow.ts"), "export default async () => {};\n");
		writeFileSync(join(b, "Bad.workflow.ts"), "export default async () => {};\n");
		const result = discoverWorkflows([a, b]);
		expect(result.scripts.map((s) => s.name)).toEqual(["ok"]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]?.file).toBe("Bad.workflow.ts");
	});

	it("missing directories are silently empty (already-tested per-dir behavior)", () => {
		writeFileSync(join(a, "ok.workflow.ts"), "export default async () => {};\n");
		const result = discoverWorkflows([a, "/nope/never"]);
		expect(result.scripts.map((s) => s.name)).toEqual(["ok"]);
		expect(result.warnings).toEqual([]);
	});

	it("is deterministic across runs (sorted by name)", () => {
		writeFileSync(join(a, "zeta.workflow.ts"), "export default async () => {};\n");
		writeFileSync(join(b, "alpha.workflow.ts"), "export default async () => {};\n");
		writeFileSync(join(c, "middle.workflow.ts"), "export default async () => {};\n");
		const r1 = discoverWorkflows([a, b, c]);
		const r2 = discoverWorkflows([a, b, c]);
		expect(r1.scripts.map((s) => s.name)).toEqual(["alpha", "middle", "zeta"]);
		expect(r1.scripts.map((s) => s.name)).toEqual(r2.scripts.map((s) => s.name));
	});
});
