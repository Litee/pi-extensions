import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, beforeAll, describe, expect, it, vi } from "vitest";
import { clearHashlineCache, hashLines, initHashline } from "../hashline.js";
import type { ParsedDiff } from "./diff.js";
import { executeHashlineRead, runHashlineEdit } from "./hashline-execute.js";

beforeAll(async () => {
	await initHashline();
	clearHashlineCache();
});

describe("executeHashlineRead", () => {
	it("returns annotated lines for an explicit range", () => {
		const result = executeHashlineRead("/tmp/a.ts", "a\nb\nc\nd\ne", 2, 4);

		expect(result.isError).toBeUndefined();
		expect(result.content[0]!.type).toBe("text");
		expect(result.details["_type"]).toBe("hashlineReadInfo");
		expect(result.details["path"]).toBe("/tmp/a.ts");
		expect(result.details["lineCount"]).toBe(3);
		expect(result.details["startLine"]).toBe(2);
		expect(result.details["endLine"]).toBe(4);
		const lines = result.content[0]!.text.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]!).toMatch(/^\s*2│[A-Za-z0-9_-]{3}│b$/);
		expect(lines[2]!).toMatch(/^\s*4│[A-Za-z0-9_-]{3}│d$/);
	});

	it("clamps an out-of-range endLine to the last line", () => {
		const result = executeHashlineRead("/tmp/a.ts", "a\nb\nc", 1, 100);

		expect(result.details["lineCount"]).toBe(3);
		expect(result.details["endLine"]).toBe(3);
		const lines = result.content[0]!.text.split("\n");
		expect(lines[2]!).toMatch(/^\s*3│[A-Za-z0-9_-]{3}│c$/);
	});
});

describe("runHashlineEdit", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "hashline-execute-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("dryRun previews the edit without writing", async () => {
		const fp = join(tempDir, "a.ts");
		writeFileSync(fp, "a\nb\nc");
		const hashes = hashLines("a\nb\nc");

		const result = await runHashlineEdit({
			resolvedPath: fp,
			changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["B"] }],
			dryRun: true,
		});

		expect(result.isError).toBeUndefined();
		expect(result.details["_type"]).toBe("hashlineEditDryRun");
		expect(result.details["dryRun"]).toBe(true);
		expect(result.details["path"]).toBe(fp);
		expect(result.details["before"]).toBe("a\nb\nc");
		expect(result.content[0]!.text).toContain("[DRY-RUN]");
		expect(result.content[0]!.text).toContain("would edit");
		expect(result.content[0]!.text).toContain("(lines 2-2)");
		expect(result.content[0]!.text).not.toContain("boundary warning");
		const diff = result.details["diff"] as ParsedDiff | null;
		expect(diff).not.toBeNull();
		expect(diff!.added).toBe(1);
		expect(diff!.removed).toBe(1);
		expect(readFileSync(fp, "utf8")).toBe("a\nb\nc");
	});

	it("writes the edit and reports [OK]", async () => {
		const fp = join(tempDir, "a.ts");
		writeFileSync(fp, "a\nb\nc");
		const hashes = hashLines("a\nb\nc");

		const result = await runHashlineEdit({
			resolvedPath: fp,
			changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["B"] }],
		});

		expect(result.isError).toBeUndefined();
		expect(result.details["_type"]).toBe("hashlineEditInfo");
		expect(result.content[0]!.text).toContain("[OK]");
		expect(result.content[0]!.text).toContain("edited");
		expect(result.content[0]!.text).toContain("(lines 2-2)");
		expect(readFileSync(fp, "utf8")).toBe("a\nB\nc");
	});

	it("returns an error when the file cannot be read", async () => {
		const fp = join(tempDir, "missing.ts");

		const result = await runHashlineEdit({
			resolvedPath: fp,
			changes: [{ hash_range_inclusive: ["abc", "abc"], content_lines: [] }],
		});

		expect(result.isError).toBe(true);
		expect(result.details["_type"]).toBe("hashlineEditError");
		expect(result.details["code"]).toBe("E_READ_FAILED");
		expect(result.details["path"]).toBe(fp);
		expect(result.details["hashlineRereadHint"]).toBeUndefined();
		expect(result.details["nextStep"]).toBe(`hashline_read path=${JSON.stringify(fp)}`);
		expect(result.content[0]!.text).toContain("[E_READ_FAILED]");
	});

	it("includes a reread hint with coordinates when the anchor has suggestions", async () => {
		const fp = join(tempDir, "a.ts");
		writeFileSync(fp, "abc");
		const hashes = hashLines("abc");
		const ref = `${hashes[0]!}X`;

		const result = await runHashlineEdit({
			resolvedPath: fp,
			changes: [{ hash_range_inclusive: [ref, ref], content_lines: [] }],
		});

		expect(result.isError).toBe(true);
		expect(result.details["code"]).toBe("E_STALE_ANCHOR");
		expect(result.details["ref"]).toBe(ref);
		expect(result.details["hashlineRereadHint"]).toEqual({ path: fp, startLine: 1, endLine: 3 });
		expect(result.details["nextStep"]).toBe(`hashline_read path=${JSON.stringify(fp)} startLine=1 endLine=3`);
		const suggestions = result.details["suggestions"] as Array<{ line: number; ref: string }>;
		expect(suggestions[0]).toEqual({ line: 0, ref: hashes[0] });
	});

	it("omits the reread hint when the anchor has no suggestions", async () => {
		const fp = join(tempDir, "empty.ts");
		writeFileSync(fp, "");
		const hashes = hashLines("");
		const ref = (hashes[0]![0] === "A" ? "B" : "A") + hashes[0]!.slice(1);

		const result = await runHashlineEdit({
			resolvedPath: fp,
			changes: [{ hash_range_inclusive: [ref, ref], content_lines: [] }],
		});

		expect(result.isError).toBe(true);
		expect(result.details["code"]).toBe("E_STALE_ANCHOR");
		expect(result.details["hashlineRereadHint"]).toBeUndefined();
		expect(result.details["nextStep"]).toBe(`hashline_read path=${JSON.stringify(fp)}`);
		expect(result.details["suggestions"]).toEqual([]);
	});

	it("reports diff stats through onDiffStats when a toolCallId is given", async () => {
		const fp = join(tempDir, "a.ts");
		writeFileSync(fp, "a\nb\nc");
		const hashes = hashLines("a\nb\nc");
		const onDiffStats = vi.fn<(toolCallId: string, diff: ParsedDiff) => void>();

		const result = await runHashlineEdit({
			resolvedPath: fp,
			changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["B"] }],
			dryRun: true,
			toolCallId: "call_123",
			onDiffStats,
		});

		expect(result.isError).toBeUndefined();
		expect(onDiffStats).toHaveBeenCalledTimes(1);
		const [calledId, diff] = onDiffStats.mock.calls[0]!;
		expect(calledId).toBe("call_123");
		expect(diff.added).toBe(1);
		expect(diff.removed).toBe(1);
		expect(diff.lines.length).toBeGreaterThan(0);
	});

	it("works without toolCallId or onDiffStats", async () => {
		const fp = join(tempDir, "a.ts");
		writeFileSync(fp, "a\nb\nc");
		const hashes = hashLines("a\nb\nc");

		const result = await runHashlineEdit({
			resolvedPath: fp,
			changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["B"] }],
			dryRun: true,
		});

		expect(result.isError).toBeUndefined();
		expect(result.details["diff"]).not.toBeNull();
	});

	it("builds no diff when the edit changes nothing", async () => {
		const fp = join(tempDir, "a.ts");
		writeFileSync(fp, "a\nb\nc");
		const hashes = hashLines("a\nb\nc");
		const onDiffStats = vi.fn<(toolCallId: string, diff: ParsedDiff) => void>();

		const result = await runHashlineEdit({
			resolvedPath: fp,
			changes: [{ hash_range_inclusive: [hashes[1]!, hashes[1]!], content_lines: ["b"] }],
			dryRun: true,
			toolCallId: "call_123",
			onDiffStats,
		});

		expect(result.isError).toBeUndefined();
		expect(onDiffStats).not.toHaveBeenCalled();
		expect(result.details["diff"]).toBeNull();
	});
});
