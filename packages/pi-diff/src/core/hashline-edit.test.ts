import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, beforeAll, describe, expect, it } from "vitest";
import { clearHashlineCache, hashLines, initHashline } from "../hashline.js";
import { applyHashlineEditsToFile } from "./hashline-edit.js";
import { prepareTextForHashlineEdit } from "./text-encoding.js";

beforeAll(async () => {
	await initHashline();
	clearHashlineCache();
});

describe("applyHashlineEditsToFile", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "hashline-edit-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("writes a real edit to disk and returns newContent + finalRaw", async () => {
		const fp = join(tempDir, "a.ts");
		writeFileSync(fp, "a\nb\nc");
		const hashes = hashLines("a\nb\nc");

		const result = await applyHashlineEditsToFile(fp, [
			{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["B"] },
		]);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.newContent).toBe("a\nB\nc");
			expect(result.finalRaw).toBe("a\nB\nc");
			expect(result.changedRange).toEqual([1, 1]);
			expect(result.boundaryWarnings).toEqual([]);
		}
		expect(readFileSync(fp, "utf8")).toBe("a\nB\nc");
	});

	it("dryRun previews the result and leaves the file untouched", async () => {
		const fp = join(tempDir, "a.ts");
		writeFileSync(fp, "a\nb\nc");
		const hashes = hashLines("a\nb\nc");

		const result = await applyHashlineEditsToFile(
			fp,
			[{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["B"] }],
			{ dryRun: true },
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.newContent).toBe("a\nB\nc");
			expect(result.finalRaw).toBe("a\nB\nc");
		}
		expect(readFileSync(fp, "utf8")).toBe("a\nb\nc");
	});

	it("uses rawUtf8 without reading the file when provided", async () => {
		const fp = join(tempDir, "never-read.ts");
		const hashes = hashLines("a\nb\nc");

		const result = await applyHashlineEditsToFile(
			fp,
			[{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["B"] }],
			{ rawUtf8: "a\nb\nc", dryRun: true },
		);

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.newContent).toBe("a\nB\nc");
	});

	it("returns E_READ_FAILED when the file cannot be read", async () => {
		const fp = join(tempDir, "does-not-exist.ts");

		const result = await applyHashlineEditsToFile(fp, [
			{ hash_range_inclusive: ["abc", "abc"], content_lines: [] },
		]);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("E_READ_FAILED");
			expect(result.error).toContain("[E_READ_FAILED]");
			expect(result.error).toContain(fp);
		}
	});

	it("returns E_WRITE_FAILED when the target directory does not exist", async () => {
		const fp = join(tempDir, "no-such-dir-xyz", "f.ts");
		const hashes = hashLines("a\nb\nc");

		const result = await applyHashlineEditsToFile(
			fp,
			[{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["B"] }],
			{ rawUtf8: "a\nb\nc" },
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("E_WRITE_FAILED");
			expect(result.error).toContain("[E_WRITE_FAILED]");
		}
	});

	it("passes through applyHashlineEdits errors (stale anchor)", async () => {
		const fp = join(tempDir, "a.ts");
		writeFileSync(fp, "abc");
		const hashes = hashLines("abc");
		const ref = (hashes[0]![0] === "A" ? "B" : "A") + hashes[0]!.slice(1);

		const result = await applyHashlineEditsToFile(fp, [
			{ hash_range_inclusive: [ref, ref], content_lines: ["X"] },
		]);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.code).toBe("E_STALE_ANCHOR");
			expect(result.error).toContain("[E_STALE_ANCHOR]");
			expect(result.ref).toBe(ref);
			expect(result.suggestions).toEqual([]);
		}
	});

	it("preserves BOM and CRLF when writing back", async () => {
		const fp = join(tempDir, "bom.ts");
		const raw = "\uFEFFa\r\nb\r\nc\r\n";
		writeFileSync(fp, raw);
		const { normalized } = prepareTextForHashlineEdit(raw);
		const hashes = hashLines(normalized);

		const result = await applyHashlineEditsToFile(fp, [
			{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["B"] },
		]);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.newContent).toBe("a\nB\nc\n");
			expect(result.finalRaw).toBe("\uFEFFa\r\nB\r\nc\r\n");
		}
		expect(readFileSync(fp, "utf8")).toBe("\uFEFFa\r\nB\r\nc\r\n");
	});
});
