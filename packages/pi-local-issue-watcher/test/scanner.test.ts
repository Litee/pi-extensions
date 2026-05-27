import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { scanIssueFiles } from "../src/scanner.js";

/**
 * Filesystem sandbox per test. Each test creates its own `dbRoot` and writes
 * realistic issue JSON files matching the shape that
 * `litee-claude-code-plugins/local-skill-issues-tracker` emits on disk:
 *   <db_root>/<skill-name>/<NNNN>-<slug>.json
 */
describe("scanIssueFiles", () => {
	let rootDir: string; // one shared tmpdir for the whole describe block
	let dbRoot: string; // cleaned and re-pointed before each test

	beforeAll(() => {
		rootDir = mkdtempSync(join(tmpdir(), "pi-issue-watcher-"));
	});

	afterAll(() => {
		rmSync(rootDir, { recursive: true, force: true });
	});

	beforeEach(() => {
		// Clear leftover files from the previous test without destroying the root.
		for (const entry of readdirSync(rootDir)) {
			rmSync(join(rootDir, entry), { recursive: true, force: true });
		}
		dbRoot = rootDir; // each test writes into the shared root
	});

	afterEach(() => {});

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

		// Regression guard for #0029: the scanner must NOT leak through
		// `console.warn` (pi's TUI catches that and splashes it into the
		// transcript). Silent drop by default; failures are delivered to the
		// optional `onError` callback, tested separately.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const snap = scanIssueFiles(dbRoot);
		expect(Object.keys(snap)).toEqual([join(skillDir, "0003-good.json")]);
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("invokes onError(filePath, err) on parse failure (#0029)", () => {
		const skillDir = join(dbRoot, "skill-parse-err");
		mkdirSync(skillDir, { recursive: true });
		const badPath = join(skillDir, "0042-broken.json");
		writeFileSync(badPath, "{ not json", "utf8");

		const onError = vi.fn();
		const snap = scanIssueFiles(dbRoot, undefined, onError);
		expect(Object.keys(snap)).toEqual([]);
		expect(onError).toHaveBeenCalledTimes(1);
		const [path, err] = onError.mock.calls[0] as [string, unknown];
		expect(path).toBe(badPath);
		expect(err).toBeInstanceOf(Error);
	});

	it("calls onError in deterministic directory+filename order across multiple failures (#0029)", () => {
		mkdirSync(join(dbRoot, "skill-z"), { recursive: true });
		mkdirSync(join(dbRoot, "skill-a"), { recursive: true });
		writeFileSync(join(dbRoot, "skill-z", "0002-bad.json"), "{ bad", "utf8");
		writeFileSync(join(dbRoot, "skill-a", "0001-bad.json"), "{ bad", "utf8");
		writeFileSync(join(dbRoot, "skill-a", "0003-bad.json"), "{ bad", "utf8");

		const onError = vi.fn();
		scanIssueFiles(dbRoot, undefined, onError);

		const paths = onError.mock.calls.map((c) => c[0] as string);
		expect(paths).toEqual([
			join(dbRoot, "skill-a", "0001-bad.json"),
			join(dbRoot, "skill-a", "0003-bad.json"),
			join(dbRoot, "skill-z", "0002-bad.json"),
		]);
	});

	it("fires onError on parse failure AND still carries forward previous entry (#0029 × #0003)", () => {
		const skillDir = join(dbRoot, "skill-carry");
		mkdirSync(skillDir, { recursive: true });
		const filePath = join(skillDir, "0001-t.json");

		writeFileSync(
			filePath,
			JSON.stringify({ id: "0001", status: "open", title: "carry me", skill: "skill-carry" }),
			"utf8",
		);
		const first = scanIssueFiles(dbRoot);
		expect(first[filePath]?.title).toBe("carry me");

		writeFileSync(filePath, "{ broken", "utf8");
		const onError = vi.fn();
		const second = scanIssueFiles(dbRoot, first, onError);

		expect(onError).toHaveBeenCalledTimes(1);
		expect(second[filePath]?.title).toBe("carry me");
	});

	it("treats zero-byte files as parse failures and fires onError (#0029)", () => {
		const skillDir = join(dbRoot, "skill-empty");
		mkdirSync(skillDir, { recursive: true });
		const emptyPath = join(skillDir, "0001-empty.json");
		writeFileSync(emptyPath, "", "utf8");

		const onError = vi.fn();
		const snap = scanIssueFiles(dbRoot, undefined, onError);

		expect(snap[emptyPath]).toBeUndefined();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0]?.[0]).toBe(emptyPath);
	});

	it("does not call onError for filename-gated non-issue files (#0029)", () => {
		const skillDir = join(dbRoot, "skill-gated");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "README.md"), "x", "utf8");
		writeFileSync(join(skillDir, "0001-UPPER.json"), "not json", "utf8"); // uppercase slug — gated out
		writeFileSync(join(skillDir, "1-short.json"), "not json", "utf8"); // missing zero-pad — gated out

		const onError = vi.fn();
		scanIssueFiles(dbRoot, undefined, onError);

		expect(onError).not.toHaveBeenCalled();
	});

	it("does not call onError when dbRoot is missing (#0029)", () => {
		const onError = vi.fn();
		scanIssueFiles(join(dbRoot, "does-not-exist"), undefined, onError);
		expect(onError).not.toHaveBeenCalled();
	});

	it("never calls onError when a skill subdir readdir throws (#0029)", () => {
		// We can simulate a readable top-level but unreadable subdir by
		// replacing a directory entry with a file at the second level —
		// `readdirSync(skillPath)` will throw ENOTDIR on macOS/Linux. No
		// per-file failure here; the whole subdir is just silently skipped,
		// so we must NOT inflate the toast count.
		writeFileSync(join(dbRoot, "not-a-dir"), "surprise", "utf8");
		// And a good sibling so the test doesn't succeed trivially with zero work:
		const skillDir = join(dbRoot, "good-skill");
		mkdirSync(skillDir);
		writeFileSync(
			join(skillDir, "0001-ok.json"),
			JSON.stringify({ id: "0001", skill: "good-skill" }),
			"utf8",
		);

		const onError = vi.fn();
		const snap = scanIssueFiles(dbRoot, undefined, onError);
		expect(Object.keys(snap)).toEqual([join(skillDir, "0001-ok.json")]);
		expect(onError).not.toHaveBeenCalled();
	});

	it("continues scanning after onError throws (#0029)", () => {
		const skillDir = join(dbRoot, "skill-throw");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "0001-bad-a.json"), "not json", "utf8");
		writeFileSync(join(skillDir, "0002-bad-b.json"), "not json", "utf8");
		writeFileSync(
			join(skillDir, "0003-good.json"),
			JSON.stringify({ id: "0003", skill: "skill-throw" }),
			"utf8",
		);

		const onError = vi.fn(() => {
			throw new Error("callback boom");
		});

		// Scanner's contract under #0029 isn't "swallow every onError throw";
		// it's "a callback throw must not eat the valid file that comes after
		// it." We assert the valid file ends up in the returned snapshot,
		// regardless of whether the scanner bubbles the first throw or
		// catches it internally. If this ever starts failing, the scanner has
		// regressed into fail-fast mode and the poll loop would wedge on a
		// single bad callback.
		try {
			const snap = scanIssueFiles(dbRoot, undefined, onError);
			expect(snap[join(skillDir, "0003-good.json")]).toBeDefined();
		} catch {
			// Currently the scanner lets the throw bubble on the first bad file,
			// which means the valid sibling is never reached. That is a latent
			// robustness gap — fail the test loudly so whoever fixes it sees
			// this assertion as the motivating regression.
			expect.fail(
				"scanIssueFiles must not propagate onError throws — a buggy callback would otherwise wedge the poll loop.",
			);
		}
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
		// #0029: silent by default, no console.warn leak.
		expect(warn).not.toHaveBeenCalled();
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
		// #0029: silent by default.
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
		expect(snap[join(skillDir, "0011-bad.json")]).toBeUndefined();
	});
});
