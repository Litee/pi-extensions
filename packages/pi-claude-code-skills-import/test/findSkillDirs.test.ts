import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findSkillDirs } from "../src/findSkillDirs.js";

function writeSkill(dir: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), "---\nname: x\ndescription: x\n---\n");
}

describe("findSkillDirs", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "pi-ccsi-find-"));
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	it("returns [] when root does not exist", () => {
		expect(findSkillDirs(join(tmpRoot, "missing"))).toEqual([]);
	});

	it("returns [] when root is empty", () => {
		const root = join(tmpRoot, "empty");
		mkdirSync(root);
		expect(findSkillDirs(root)).toEqual([]);
	});

	it("finds a top-level directory containing SKILL.md", () => {
		const root = join(tmpRoot, "r");
		writeSkill(join(root, "one"));
		expect(findSkillDirs(root).sort()).toEqual([join(root, "one")]);
	});

	it("finds multiple top-level skill dirs", () => {
		const root = join(tmpRoot, "r");
		writeSkill(join(root, "a"));
		writeSkill(join(root, "b"));
		writeSkill(join(root, "c"));
		expect(findSkillDirs(root).sort()).toEqual([
			join(root, "a"),
			join(root, "b"),
			join(root, "c"),
		]);
	});

	it("recurses into subdirectories when they do not themselves contain SKILL.md", () => {
		const root = join(tmpRoot, "r");
		// r/group/deep-skill/SKILL.md — group is a container, deep-skill is the skill.
		writeSkill(join(root, "group", "deep-skill"));
		expect(findSkillDirs(root)).toEqual([join(root, "group", "deep-skill")]);
	});

	it("does not descend into a directory that already contains SKILL.md", () => {
		const root = join(tmpRoot, "r");
		// r/outer/SKILL.md + r/outer/inner/SKILL.md  — only outer is reported.
		writeSkill(join(root, "outer"));
		writeSkill(join(root, "outer", "inner"));
		expect(findSkillDirs(root)).toEqual([join(root, "outer")]);
	});

	it("ignores non-directory children", () => {
		const root = join(tmpRoot, "r");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "README.md"), "# not a skill");
		writeSkill(join(root, "real"));
		expect(findSkillDirs(root)).toEqual([join(root, "real")]);
	});

	it("returns [] when root is a file, not a directory (readdirSync throws)", () => {
		// existsSync passes (the path exists as a file), so the code falls through
		// to readdirSync, which throws ENOTDIR — exercises the inner try/catch.
		const file = join(tmpRoot, "file.txt");
		writeFileSync(file, "not a dir");
		expect(findSkillDirs(file)).toEqual([]);
	});

	it("follows symlinks to directories that contain SKILL.md", () => {
		const root = join(tmpRoot, "r");
		mkdirSync(root, { recursive: true });
		// Real skill lives outside `root`; a symlink inside `root` points at it.
		const real = join(tmpRoot, "real-skill");
		writeSkill(real);
		const link = join(root, "linked");
		symlinkSync(real, link, "dir");
		expect(findSkillDirs(root)).toEqual([link]);
	});

	it("follows symlinks into nested skill containers", () => {
		const root = join(tmpRoot, "r");
		mkdirSync(root, { recursive: true });
		// Symlink points to a *container* directory whose child has SKILL.md.
		const real = join(tmpRoot, "real-container");
		writeSkill(join(real, "nested-skill"));
		const link = join(root, "linked-container");
		symlinkSync(real, link, "dir");
		expect(findSkillDirs(root)).toEqual([join(link, "nested-skill")]);
	});

	// -- issue #0001 (H4): symlink cycle must not recurse unbounded --
	it("terminates on a self-referential symlink cycle (issue #0001)", () => {
		const root = join(tmpRoot, "r");
		mkdirSync(root, { recursive: true });
		// Create a self-loop: r/loop -> r  (symlink to ancestor).
		symlinkSync(root, join(root, "loop"), "dir");
		// And a legitimate skill alongside to make sure we still find it.
		writeSkill(join(root, "real"));

		// If the cycle guard is missing, this call would recurse forever or
		// stack-overflow. Vitest's default timeout (5s) backstops an infinite
		// loop; we additionally assert the expected output.
		const dirs = findSkillDirs(root);
		expect(dirs).toContain(join(root, "real"));
		// No path from the loop should leak back into the results.
		for (const d of dirs) {
			expect(d.split("/loop/").length).toBeLessThanOrEqual(2);
		}
	});

	it("terminates on mutual symlink cycles between two dirs (issue #0001)", () => {
		const root = join(tmpRoot, "r");
		mkdirSync(join(root, "a"), { recursive: true });
		mkdirSync(join(root, "b"), { recursive: true });
		// a/x -> b, b/y -> a — loops back and forth.
		symlinkSync(join(root, "b"), join(root, "a", "x"), "dir");
		symlinkSync(join(root, "a"), join(root, "b", "y"), "dir");

		const dirs = findSkillDirs(root);
		// No crash, no hang — and since there's no SKILL.md anywhere in the
		// graph, the result is [].
		expect(dirs).toEqual([]);
	});
});
