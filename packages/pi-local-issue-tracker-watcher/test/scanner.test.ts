import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { scanIssueFiles } from "../src/scanner.js";

/**
 * Filesystem sandbox per test. Each test creates its own `dbRoot` and writes
 * realistic issue JSON files matching the shape that
 * `litee-claude-code-plugins/local-skill-issues-tracker` emits on disk:
 *   <db_root>/<skill-name>/<NNNN>-<slug>.json
 */
describe("scanIssueFiles", () => {
	let dbRoot: string;

	beforeEach(() => {
		dbRoot = mkdtempSync(join(tmpdir(), "pi-issue-watcher-"));
	});

	afterEach(() => {
		rmSync(dbRoot, { recursive: true, force: true });
	});

	it("returns an empty snapshot when dbRoot does not exist", () => {
		const missing = join(dbRoot, "does-not-exist");
		expect(scanIssueFiles(missing)).toEqual({});
	});

	it("returns an empty snapshot when dbRoot is empty", () => {
		expect(scanIssueFiles(dbRoot)).toEqual({});
	});

	it("parses a well-formed issue file into a keyed entry with all metadata", () => {
		const skillDir = join(dbRoot, "my-skill");
		mkdirSync(skillDir, { recursive: true });
		const filePath = join(skillDir, "0007-do-the-thing.json");
		const issue = {
			id: "0007",
			status: "open",
			title: "Do the thing",
			description: "Something is broken",
			comments: [{ text: "first comment" }],
			skill: "my-skill",
			skill_version: "1.2.3",
		};
		writeFileSync(filePath, JSON.stringify(issue), "utf8");

		const snap = scanIssueFiles(dbRoot);
		expect(Object.keys(snap)).toEqual([filePath]);
		const info = snap[filePath]!;
		expect(info.issueId).toBe("0007");
		expect(info.status).toBe("open");
		expect(info.title).toBe("Do the thing");
		expect(info.description).toBe("Something is broken");
		expect(info.comments).toEqual([{ text: "first comment" }]);
		expect(info.skill).toBe("my-skill");
		expect(info.skillVersion).toBe("1.2.3");
		// mtime is taken from `stat` — should be a positive integer number of
		// nanoseconds. We don't pin a value; only shape + positivity.
		expect(typeof info.mtimeNs).toBe("bigint");
		expect(info.mtimeNs > 0n).toBe(true);
	});

	it("ignores files whose name does not match NNNN-slug.json", () => {
		const skillDir = join(dbRoot, "skill-a");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "README.md"), "notes", "utf8");
		writeFileSync(join(skillDir, "1-short.json"), "{}", "utf8"); // missing zero-padding
		writeFileSync(join(skillDir, "0001-UPPER.json"), "{}", "utf8"); // uppercase slug
		writeFileSync(join(skillDir, "0001-ok.json"), JSON.stringify({ id: "0001" }), "utf8");

		const snap = scanIssueFiles(dbRoot);
		expect(Object.keys(snap)).toEqual([join(skillDir, "0001-ok.json")]);
	});

	it("skips unreadable / unparseable JSON files without throwing", () => {
		const skillDir = join(dbRoot, "skill-b");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "0002-bad.json"), "{ not json", "utf8");
		writeFileSync(join(skillDir, "0003-good.json"), JSON.stringify({ id: "0003" }), "utf8");

		// Silence the expected warn for the malformed file.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const snap = scanIssueFiles(dbRoot);
		expect(Object.keys(snap)).toEqual([join(skillDir, "0003-good.json")]);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("ignores non-directory entries at the top level of dbRoot", () => {
		writeFileSync(join(dbRoot, "stray.txt"), "hi", "utf8");
		writeFileSync(join(dbRoot, "0001-root.json"), JSON.stringify({ id: "0001" }), "utf8");
		// Real skill dir in parallel — must still be scanned.
		const skillDir = join(dbRoot, "good-skill");
		mkdirSync(skillDir);
		writeFileSync(join(skillDir, "0009-found.json"), JSON.stringify({ id: "0009" }), "utf8");

		const snap = scanIssueFiles(dbRoot);
		expect(Object.keys(snap)).toEqual([join(skillDir, "0009-found.json")]);
	});

	// -- issue #0003 (H3): carry-forward on transient read/parse failures --
	it("preserves the previous snapshot entry when a file is transiently unparseable (issue #0003)", () => {
		const skillDir = join(dbRoot, "skill-c");
		mkdirSync(skillDir, { recursive: true });
		const filePath = join(skillDir, "0010-transient.json");

		// 1st scan: valid content on disk.
		writeFileSync(filePath, JSON.stringify({ id: "0010", status: "open", title: "t", skill: "skill-c" }), "utf8");
		const first = scanIssueFiles(dbRoot);
		expect(first[filePath]).toBeDefined();
		expect(first[filePath]!.status).toBe("open");

		// 2nd scan: writer caught mid-flush (file exists but is invalid JSON).
		writeFileSync(filePath, "{ incomplete", "utf8");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const second = scanIssueFiles(dbRoot, first);
		warn.mockRestore();

		// We should keep the previous entry — not lose it and emit a spurious
		// `removed` on the next diff.
		expect(second[filePath]).toBeDefined();
		expect(second[filePath]!.status).toBe("open");
	});

	it("without a previous snapshot, still skips unparseable files as before (issue #0003)", () => {
		const skillDir = join(dbRoot, "skill-d");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "0011-bad.json"), "{ bad", "utf8");

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const snap = scanIssueFiles(dbRoot); // no previous arg
		warn.mockRestore();
		expect(snap[join(skillDir, "0011-bad.json")]).toBeUndefined();
	});
});
