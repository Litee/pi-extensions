/**
 * Tests for src/manifest-installer.ts
 * Writes the Firefox NM manifest JSON to a temp dir.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-bc-manifest-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

import { installManifest, readInstalledManifest } from "../src/manifest-installer.js";
import { GECKO_EXTENSION_ID, NM_HOST_NAME } from "../src/socket-paths.js";

describe("installManifest", () => {
	it("returns ok:true and writes the file", () => {
		const launcherPath = join(tempDir, "launch");
		const outPath = join(tempDir, "pi_browser_control.json");
		const result = installManifest({ launcherPath, overrideManifestPath: outPath });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.path).toBe(outPath);
		}
	});

	it("writes valid JSON with correct fields", () => {
		const launcherPath = join(tempDir, "launch");
		const outPath = join(tempDir, "nm.json");
		installManifest({ launcherPath, overrideManifestPath: outPath });
		const manifest = JSON.parse(readFileSync(outPath, "utf-8")) as Record<string, unknown>;
		expect(manifest["name"]).toBe(NM_HOST_NAME);
		expect(manifest["type"]).toBe("stdio");
		expect(manifest["path"]).toBe(launcherPath);
		expect(Array.isArray(manifest["allowed_extensions"])).toBe(true);
		expect((manifest["allowed_extensions"] as string[])[0]).toBe(GECKO_EXTENSION_ID);
	});

	it("uses custom geckoExtensionId when provided", () => {
		const launcherPath = join(tempDir, "launch");
		const outPath = join(tempDir, "nm-custom.json");
		installManifest({
			launcherPath,
			geckoExtensionId: "custom@example.com",
			overrideManifestPath: outPath,
		});
		const manifest = JSON.parse(readFileSync(outPath, "utf-8")) as Record<string, unknown>;
		expect((manifest["allowed_extensions"] as string[])[0]).toBe("custom@example.com");
	});

	it("writes pretty JSON with 2-space indent", () => {
		const outPath = join(tempDir, "nm-pretty.json");
		installManifest({ launcherPath: "/fake/launch", overrideManifestPath: outPath });
		const raw = readFileSync(outPath, "utf-8");
		expect(raw).toMatch(/^\{/);
		expect(raw).toMatch(/  "/); // 2-space indent
	});

	it("writes a trailing newline", () => {
		const outPath = join(tempDir, "nm-newline.json");
		installManifest({ launcherPath: "/fake/launch", overrideManifestPath: outPath });
		const raw = readFileSync(outPath, "utf-8");
		expect(raw.endsWith("\n")).toBe(true);
	});

	it("creates parent directories if missing", () => {
		const outPath = join(tempDir, "a", "b", "c", "nm.json");
		const result = installManifest({ launcherPath: "/fake/launch", overrideManifestPath: outPath });
		expect(result.ok).toBe(true);
	});

	it("returns ok:false on write error", () => {
		// Use a path that is a directory (cannot write file over a dir)
		const result = installManifest({
			launcherPath: "/fake/launch",
			overrideManifestPath: tempDir,
		});
		expect(result.ok).toBe(false);
	});

	it("includes a description field", () => {
		const outPath = join(tempDir, "nm-desc.json");
		installManifest({ launcherPath: "/fake/launch", overrideManifestPath: outPath });
		const manifest = JSON.parse(readFileSync(outPath, "utf-8")) as Record<string, unknown>;
		expect(typeof manifest["description"]).toBe("string");
		expect((manifest["description"] as string).length).toBeGreaterThan(0);
	});
});

describe("readInstalledManifest", () => {
	it("returns null when the file does not exist", () => {
		const missingPath = join(tempDir, "does-not-exist.json");
		expect(readInstalledManifest(missingPath)).toBeNull();
	});

	it("returns parsed JSON when the file exists", () => {
		const outPath = join(tempDir, "nm.json");
		installManifest({ launcherPath: "/fake/launch", overrideManifestPath: outPath });
		const m = readInstalledManifest(outPath);
		expect(m).not.toBeNull();
		expect(m?.["name"]).toBe(NM_HOST_NAME);
	});

	it("returns null on invalid JSON", () => {
		const p = join(tempDir, "bad.json");
		writeFileSync(p, "not json", "utf-8");
		expect(readInstalledManifest(p)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Branch coverage gaps
// ---------------------------------------------------------------------------

describe("installManifest — non-Error throw uses String(err)", () => {
	it("returns ok:false with String(err) when fs throws a non-Error value", async () => {
		const { vi } = await import("vitest");
		const fsDefault = (await import("node:fs")).default;
		class FakeThrown {
			readonly message = "manifest write failed";
			toString() { return this.message; }
		}
		const spy = vi.spyOn(fsDefault, "writeFileSync").mockImplementationOnce(() => {
			throw new FakeThrown() as unknown as Error;
		});
		const outPath = join(tempDir, "nm-str-err.json");
		const result = installManifest({ launcherPath: "/fake/launch", overrideManifestPath: outPath });
		spy.mockRestore();
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("manifest write failed");
		}
	});
});

describe("readInstalledManifest — non-object JSON returns null", () => {
	it("returns null when JSON parses to null", () => {
		const p = join(tempDir, "null.json");
		writeFileSync(p, "null", "utf-8");
		expect(readInstalledManifest(p)).toBeNull();
	});

	it("returns null when JSON parses to an array", () => {
		const p = join(tempDir, "arr.json");
		writeFileSync(p, "[]", "utf-8");
		expect(readInstalledManifest(p)).toBeNull();
	});
});
