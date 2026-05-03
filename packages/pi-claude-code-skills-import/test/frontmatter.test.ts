import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractSkillName } from "../src/frontmatter.js";

describe("extractSkillName", () => {
	let tmpRoot: string;

	beforeEach(() => {
		tmpRoot = mkdtempSync(join(tmpdir(), "pi-ccsi-frontmatter-"));
		mkdirSync(tmpRoot, { recursive: true });
	});

	afterEach(() => {
		rmSync(tmpRoot, { recursive: true, force: true });
	});

	function writeFile(contents: string): string {
		const p = join(tmpRoot, "SKILL.md");
		writeFileSync(p, contents);
		return p;
	}

	it("returns the name from valid frontmatter", () => {
		const p = writeFile("---\nname: my-skill\ndescription: does things\n---\n\n# body\n");
		expect(extractSkillName(p)).toBe("my-skill");
	});

	it("strips surrounding double quotes", () => {
		const p = writeFile(`---\nname: "quoted-skill"\ndescription: x\n---\n`);
		expect(extractSkillName(p)).toBe("quoted-skill");
	});

	it("strips surrounding single quotes", () => {
		const p = writeFile(`---\nname: 'quoted-skill'\ndescription: x\n---\n`);
		expect(extractSkillName(p)).toBe("quoted-skill");
	});

	it("trims surrounding whitespace around the value", () => {
		const p = writeFile("---\nname:    padded-name   \ndescription: x\n---\n");
		expect(extractSkillName(p)).toBe("padded-name");
	});

	it("returns undefined when file does not start with frontmatter fence", () => {
		const p = writeFile("# Not frontmatter\nname: decoy\n");
		expect(extractSkillName(p)).toBeUndefined();
	});

	it("returns undefined when closing fence is missing", () => {
		const p = writeFile("---\nname: unfinished\ndescription: x\n");
		expect(extractSkillName(p)).toBeUndefined();
	});

	it("returns undefined when name key is absent", () => {
		const p = writeFile("---\ndescription: x\n---\n");
		expect(extractSkillName(p)).toBeUndefined();
	});

	it("returns undefined when the file does not exist", () => {
		expect(extractSkillName(join(tmpRoot, "nope.md"))).toBeUndefined();
	});

	it("returns the first name when multiple are present (top-level wins)", () => {
		// Two top-level scalars would be YAML-invalid; parser is lenient and returns the first match.
		const p = writeFile("---\nname: first\nname: second\n---\n");
		expect(extractSkillName(p)).toBe("first");
	});

	// -- issue #0003 (N3): CRLF frontmatter must not leak \r --
	it("handles CRLF line endings without trailing \\r in the returned name (issue #0003)", () => {
		const p = writeFile("---\r\nname: crlf-skill\r\ndescription: x\r\n---\r\n\r\n# body\r\n");
		const got = extractSkillName(p);
		expect(got).toBe("crlf-skill");
		expect(got).not.toMatch(/\r/);
	});

	it("handles CRLF frontmatter with quoted name (issue #0003)", () => {
		const p = writeFile(`---\r\nname: "crlf-quoted"\r\ndescription: x\r\n---\r\n`);
		expect(extractSkillName(p)).toBe("crlf-quoted");
	});
});
