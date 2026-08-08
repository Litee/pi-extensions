import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	executeApplyPatch,
	formatApplyPatchResult,
	type ApplyPatchChange,
	type ApplyPatchResult,
} from "./apply-patch.js";

describe("executeApplyPatch source-safe updates", () => {
	let tempDir: string;
	let filePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "apply-patch-"));
		filePath = join(tempDir, "source.ts");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("preserves the source indentation when matching an unambiguous shifted block", async () => {
		writeFileSync(filePath, "function f() {\n    first();\n    second();\n}\n");

		const result = await executeApplyPatch([
			{
				path: filePath,
				action: "update",
				oldText: "  first();\n  second();",
				newText: "  firstUpdated();\n  secondUpdated();",
			},
		]);

		expect(result.ok).toBe(true);
		expect(readFileSync(filePath, "utf8")).toBe("function f() {\n    firstUpdated();\n    secondUpdated();\n}\n");
	});

	it("rejects a stale block instead of replacing everything between loose anchors", async () => {
		const source = "function f() {\n  keep1();\n  keep2();\n  keep3();\n}\n";
		writeFileSync(filePath, source);

		const result = await executeApplyPatch([
			{
				path: filePath,
				action: "update",
				oldText: "function f() {\n  keep1();\n  invented();\n}",
				newText: "REPLACED",
			},
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe(source);
	});

	it("does not apply earlier changes when a later change is invalid", async () => {
		const otherPath = join(tempDir, "other.ts");
		writeFileSync(filePath, "const first = 1;\n");
		writeFileSync(otherPath, "const second = 2;\n");

		const result = await executeApplyPatch([
			{ path: filePath, action: "update", oldText: "const first = 1;", newText: "const first = 10;" },
			{ path: otherPath, action: "update", oldText: "missing", newText: "const second = 20;" },
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe("const first = 1;\n");
		expect(readFileSync(otherPath, "utf8")).toBe("const second = 2;\n");
	});

	it("does not overwrite existing files for add or move", async () => {
		const sourcePath = join(tempDir, "move-source.ts");
		const destinationPath = join(tempDir, "move-destination.ts");
		writeFileSync(filePath, "original add target\n");
		writeFileSync(sourcePath, "source\n");
		writeFileSync(destinationPath, "destination\n");

		const result = await executeApplyPatch([
			{ path: filePath, action: "add", content: "replacement" },
			{ path: sourcePath, action: "move", movePath: destinationPath },
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe("original add target\n");
		expect(readFileSync(sourcePath, "utf8")).toBe("source\n");
		expect(readFileSync(destinationPath, "utf8")).toBe("destination\n");
	});

	it("preserves CRLF when applying an indentation-adjusted single-line update", async () => {
		writeFileSync(filePath, "function f() {\r\n    first();\r\n}\r\n");

		const result = await executeApplyPatch([
			{
				path: filePath,
				action: "update",
				oldText: "  first(); ",
				newText: "  firstUpdated();",
			},
		]);

		expect(result.ok).toBe(true);
		expect(readFileSync(filePath, "utf8")).toBe("function f() {\r\n    firstUpdated();\r\n}\r\n");
	});

	it("rejects a partial-indentation exact match that would alter source indentation", async () => {
		const source = "function f() {\n    first();\n}\n";
		writeFileSync(filePath, source);

		const result = await executeApplyPatch([
			{ path: filePath, action: "update", oldText: "  first();", newText: "firstUpdated();" },
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe(source);
	});

	it("does not duplicate a trailing newline for an indentation-adjusted match", async () => {
		writeFileSync(filePath, "function f() {\n    first();\n}\n");

		const result = await executeApplyPatch([
			{ path: filePath, action: "update", oldText: "  first(); \n", newText: "  firstUpdated();\n" },
		]);

		expect(result.ok).toBe(true);
		expect(readFileSync(filePath, "utf8")).toBe("function f() {\n    firstUpdated();\n}\n");
	});

	it("rejects a mid-indent exact match that inserts multiple lines", async () => {
		const source = "function f() {\n    first();\n}\n";
		writeFileSync(filePath, source);

		const result = await executeApplyPatch([
			{
				path: filePath,
				action: "update",
				oldText: "  first();",
				newText: "  firstUpdated();\n  inserted();",
			},
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe(source);
	});

	it("rejects a multi-line exact match that starts inside source indentation", async () => {
		const source = "function f() {\n    first();\n    second();\n}\n";
		writeFileSync(filePath, source);

		const result = await executeApplyPatch([
			{
				path: filePath,
				action: "update",
				oldText: "  first();\n    second();",
				newText: "  firstUpdated();\n  secondUpdated();",
			},
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(filePath, "utf8")).toBe(source);
	});

	it("rejects batches whose operations would target the same path", async () => {
		const sourcePath = join(tempDir, "move-source.ts");
		const destinationPath = join(tempDir, "new-target.ts");
		writeFileSync(sourcePath, "source\n");

		const result = await executeApplyPatch([
			{ path: destinationPath, action: "add", content: "new file" },
			{ path: sourcePath, action: "move", movePath: destinationPath },
		]);

		expect(result.ok).toBe(false);
		expect(readFileSync(sourcePath, "utf8")).toBe("source\n");
		expect(() => lstatSync(destinationPath)).toThrow();
	});

	it("preserves executable modes and refuses to replace symlinks", async () => {
		writeFileSync(filePath, "run\n");
		chmodSync(filePath, 0o755);
		const executableResult = await executeApplyPatch([
			{ path: filePath, action: "update", oldText: "run", newText: "run updated" },
		]);
		expect(executableResult.ok).toBe(true);
		expect(statSync(filePath).mode & 0o777).toBe(0o755);

		const targetPath = join(tempDir, "target.ts");
		const linkPath = join(tempDir, "link.ts");
		writeFileSync(targetPath, "target\n");
		symlinkSync(targetPath, linkPath);
		const linkResult = await executeApplyPatch([
			{ path: linkPath, action: "update", oldText: "target", newText: "changed" },
		]);
		expect(linkResult.ok).toBe(false);
		expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
		expect(readFileSync(targetPath, "utf8")).toBe("target\n");
	});
});

describe("executeApplyPatch add/delete/move", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "apply-patch-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("adds a new file and normalizes a missing trailing newline", async () => {
		const content = "const x = 1;";
		const fp = join(tempDir, "nested", "dir", "new.ts");

		const result = await executeApplyPatch([{ path: fp, action: "add", content }]);

		expect(result.ok).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.applied[0]).toMatchObject({
			path: fp,
			action: "add",
			bytes: Buffer.byteLength(`${content}\n`, "utf8"),
			newContent: `${content}\n`,
		});
		expect(readFileSync(fp, "utf8")).toBe(`${content}\n`);
	});

	it("keeps an existing trailing newline on add and supports omitted content", async () => {
		const fp = join(tempDir, "new.ts");

		const withNewline = await executeApplyPatch([{ path: fp, action: "add", content: "x\n" }]);
		expect(withNewline.ok).toBe(true);
		expect(withNewline.applied[0]).toMatchObject({ newContent: "x\n", bytes: 2 });
		expect(readFileSync(fp, "utf8")).toBe("x\n");

		const empty = await executeApplyPatch([{ path: join(tempDir, "empty.ts"), action: "add" }]);
		expect(empty.ok).toBe(true);
		expect(empty.applied[0]).toMatchObject({ newContent: "\n", bytes: 1 });
		expect(readFileSync(join(tempDir, "empty.ts"), "utf8")).toBe("\n");
	});

	it("deletes a file and reports oldContent", async () => {
		const fp = join(tempDir, "gone.ts");
		writeFileSync(fp, "line1\nline2\n");

		const result = await executeApplyPatch([{ path: fp, action: "delete" }]);

		expect(result.ok).toBe(true);
		expect(result.applied[0]).toMatchObject({ path: fp, action: "delete", oldContent: "line1\nline2\n" });
		expect(() => lstatSync(fp)).toThrow();
	});

	it("moves a file and reports movePath", async () => {
		const src = join(tempDir, "src.ts");
		const dest = join(tempDir, "dest", "moved.ts");
		writeFileSync(src, "payload\n");

		const result = await executeApplyPatch([{ path: src, action: "move", movePath: dest }]);

		expect(result.ok).toBe(true);
		expect(result.applied[0]).toMatchObject({ path: src, action: "move", movePath: dest });
		expect(() => lstatSync(src)).toThrow();
		expect(readFileSync(dest, "utf8")).toBe("payload\n");
	});

	it("rejects a move without movePath", async () => {
		const src = join(tempDir, "src.ts");
		writeFileSync(src, "x\n");

		const result = await executeApplyPatch([{ path: src, action: "move" }]);

		expect(result.ok).toBe(false);
		expect(result.errors[0]).toMatchObject({ path: src, action: "move" });
		expect(result.errors[0]!.error).toBe("move requires movePath");
	});

	it("rejects a move whose destination already exists", async () => {
		const src = join(tempDir, "src.ts");
		const dest = join(tempDir, "dest.ts");
		writeFileSync(src, "x\n");
		writeFileSync(dest, "y\n");

		const result = await executeApplyPatch([{ path: src, action: "move", movePath: dest }]);

		expect(result.ok).toBe(false);
		expect(result.errors[0]!.error).toBe(`move destination already exists: ${dest}`);
	});
});

describe("executeApplyPatch update validation", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "apply-patch-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("requires oldText", async () => {
		const fp = join(tempDir, "a.ts");
		writeFileSync(fp, "x\n");

		const result = await executeApplyPatch([{ path: fp, action: "update", newText: "y" }]);

		expect(result.ok).toBe(false);
		expect(result.errors[0]!.error).toBe("update requires oldText");
	});

	it("rejects identical oldText and newText", async () => {
		const fp = join(tempDir, "a.ts");
		writeFileSync(fp, "x\n");

		const result = await executeApplyPatch([{ path: fp, action: "update", oldText: "x", newText: "x" }]);

		expect(result.ok).toBe(false);
		expect(result.errors[0]!.error).toBe("oldText and newText are identical — no change");
	});

	it("reports oldText not found", async () => {
		const fp = join(tempDir, "a.ts");
		writeFileSync(fp, "x\n");

		const result = await executeApplyPatch([{ path: fp, action: "update", oldText: "missing", newText: "y" }]);

		expect(result.ok).toBe(false);
		expect(result.errors[0]!.error).toBe(`oldText not found in ${fp}`);
	});

	it("deletes matched text when newText is omitted", async () => {
		const fp = join(tempDir, "a.ts");
		writeFileSync(fp, "line1\nline2\nline3\n");

		const result = await executeApplyPatch([{ path: fp, action: "update", oldText: "line2" }]);

		expect(result.ok).toBe(true);
		expect(result.applied[0]!.newContent).toBe("line1\n\nline3\n");
		expect(result.applied[0]!.diff).toContain("- line2");
		expect(result.applied[0]!.diff).not.toContain("+ line2");
		expect(readFileSync(fp, "utf8")).toBe("line1\n\nline3\n");
	});

	it("handles a newline-less source when deletion shortens the line list", async () => {
		const fp = join(tempDir, "a.ts");
		writeFileSync(fp, "alpha\nbeta");

		const result = await executeApplyPatch([{ path: fp, action: "update", oldText: "alpha\n", newText: "" }]);

		expect(result.ok).toBe(true);
		expect(result.applied[0]!.newContent).toBe("beta");
		expect(result.applied[0]!.diff).toContain("- alpha");
		expect(result.applied[0]!.diff).toContain("- beta");
		expect(result.applied[0]!.diff).toContain("+ beta");
		expect(readFileSync(fp, "utf8")).toBe("beta");
	});

	it("renders a pure addition line when newText grows beyond the last line", async () => {
		const fp = join(tempDir, "a.ts");
		writeFileSync(fp, "line1\nline2\n");

		const result = await executeApplyPatch([
			{ path: fp, action: "update", oldText: "line2", newText: "line2\nline3" },
		]);

		expect(result.ok).toBe(true);
		expect(result.applied[0]!.diff).toContain("+ line3");
		expect(result.applied[0]!.diff).not.toContain("- line3");
		expect(readFileSync(fp, "utf8")).toBe("line1\nline2\nline3\n");
	});

	it("reports a missing update target", async () => {
		const fp = join(tempDir, "missing.ts");

		const result = await executeApplyPatch([{ path: fp, action: "update", oldText: "x", newText: "y" }]);

		expect(result.ok).toBe(false);
		expect(result.errors[0]!.error).toBe(`update target not found: ${fp}`);
	});

	it("reports a missing delete target", async () => {
		const fp = join(tempDir, "missing.ts");

		const result = await executeApplyPatch([{ path: fp, action: "delete" }]);

		expect(result.ok).toBe(false);
		expect(result.errors[0]!.error).toBe(`delete target not found: ${fp}`);
	});

	it("rejects a directory as an update target", async () => {
		const dir = join(tempDir, "adir");
		mkdirSync(dir);

		const result = await executeApplyPatch([{ path: dir, action: "update", oldText: "x", newText: "y" }]);

		expect(result.ok).toBe(false);
		expect(result.errors[0]!.error).toBe(`update target must be a regular file: ${dir}`);
	});
});

describe("executeApplyPatch misc", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "apply-patch-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("rejects an unknown action", async () => {
		const result = await executeApplyPatch([
			{ path: join(tempDir, "a.ts"), action: "rename" } as unknown as ApplyPatchChange,
		]);

		expect(result.ok).toBe(false);
		expect(result.errors[0]!.error).toBe("unknown action: rename");
	});

	it("rolls back earlier commits when a later commit fails", async () => {
		const a = join(tempDir, "a.ts");
		const b = join(tempDir, "b.ts");
		const blocker = join(tempDir, "blocker");
		writeFileSync(a, "A1\n");
		writeFileSync(b, "B1\n");
		writeFileSync(blocker, "not a directory\n");

		const result = await executeApplyPatch([
			{ path: a, action: "update", oldText: "A1", newText: "A2" },
			{ path: b, action: "move", movePath: join(blocker, "sub.ts") },
		]);

		expect(result.ok).toBe(false);
		expect(result.applied).toEqual([]);
		expect(result.errors[0]).toMatchObject({ path: b, action: "move" });
		expect(result.errors[0]!.error).toMatch(/EEXIST|ENOTDIR|mkdir/);
		expect(readFileSync(a, "utf8")).toBe("A1\n");
		expect(readFileSync(b, "utf8")).toBe("B1\n");
	});
});

describe("formatApplyPatchResult", () => {
	it("renders success lines for every action", () => {
		const result: ApplyPatchResult = {
			ok: true,
			applied: [
				{ path: "/p/a.ts", action: "add" },
				{ path: "/p/b.ts", action: "update" },
				{ path: "/p/c.ts", action: "delete" },
				{ path: "/p/d.ts", action: "move", movePath: "/p/e.ts" },
			],
			errors: [],
		};

		const text = formatApplyPatchResult(result);
		expect(text).toContain("Applied 4 change(s):");
		expect(text).toContain("  A /p/a.ts");
		expect(text).toContain("  M /p/b.ts");
		expect(text).toContain("  D /p/c.ts");
		expect(text).toContain("  M /p/d.ts -> /p/e.ts");
		expect(text).not.toContain("Failed");
	});

	it("renders failure lines alongside applied changes", () => {
		const result: ApplyPatchResult = {
			ok: false,
			applied: [{ path: "/p/a.ts", action: "add" }],
			errors: [
				{ path: "/p/b.ts", action: "update", error: "oldText not found in /p/b.ts" },
				{ path: "/p/c.ts", action: "delete", error: "delete target not found: /p/c.ts" },
			],
		};

		const text = formatApplyPatchResult(result);
		expect(text).toContain("Applied 1 change(s):");
		expect(text).toContain("  A /p/a.ts");
		expect(text).toContain("Failed 2 change(s):");
		expect(text).toContain("[update] /p/b.ts: oldText not found in /p/b.ts");
		expect(text).toContain("[delete] /p/c.ts: delete target not found: /p/c.ts");
	});

	it("renders only failure lines when nothing was applied", () => {
		const result: ApplyPatchResult = {
			ok: false,
			applied: [],
			errors: [{ path: "/p/a.ts", action: "add", error: "add target already exists: /p/a.ts" }],
		};

		const text = formatApplyPatchResult(result);
		expect(text).not.toContain("Applied");
		expect(text).toContain("Failed 1 change(s):");
		expect(text).toContain("[add] /p/a.ts: add target already exists: /p/a.ts");
	});
});
