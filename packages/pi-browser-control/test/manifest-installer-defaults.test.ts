/**
 * Tests for the `?? manifestPath()` default-argument branches in
 * manifest-installer.ts. The existing manifest-installer.test.ts always passes
 * the override path, leaving the `?? manifestPath()` fallback (used when the
 * argument is omitted) uncovered. We mock socket-paths' manifestPath so the
 * default branch resolves to a temp file instead of the real macOS location.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const manifestPathMock = vi.fn();
vi.mock("../src/socket-paths.js", () => ({
	manifestPath: () => manifestPathMock() as string,
	GECKO_EXTENSION_ID: "pi-browser-control@earendil-works",
	NM_HOST_NAME: "pi_browser_control",
}));

import { installManifest, readInstalledManifest } from "../src/manifest-installer.js";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-bc-mi-"));
	manifestPathMock.mockReturnValue(join(tempDir, "pi_browser_control.json"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("installManifest — default manifestPath when overrideManifestPath omitted", () => {
	it("writes to manifestPath() default when overrideManifestPath is omitted", () => {
		const result = installManifest({ launcherPath: "/fake/launch" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.path).toBe(join(tempDir, "pi_browser_control.json"));
		}
		expect(manifestPathMock).toHaveBeenCalled();
	});
});

describe("readInstalledManifest — default path when overridePath omitted", () => {
	it("reads from manifestPath() default when overridePath is omitted", () => {
		// Write a manifest at the mocked default path first.
		const written = installManifest({ launcherPath: "/fake/launch" });
		expect(written.ok).toBe(true);
		expect(existsSync(join(tempDir, "pi_browser_control.json"))).toBe(true);

		const m = readInstalledManifest();
		expect(m).not.toBeNull();
		expect(m?.["name"]).toBe("pi_browser_control");
		expect(manifestPathMock).toHaveBeenCalled();
	});
});
