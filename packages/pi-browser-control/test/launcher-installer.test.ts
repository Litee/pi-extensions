/**
 * Tests for src/launcher-installer.ts
 * Writes a #!/bin/sh exec launcher and asserts permissions + content.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { installLauncher } from "../src/launcher-installer.js";

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-bc-launcher-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("installLauncher", () => {
	it("returns ok:true and writes the file", () => {
		const targetPath = join(tempDir, "launch");
		const result = installLauncher({
			targetPath,
			nodePath: "/usr/local/bin/node",
			daemonScriptPath: "/abs/path/daemon.ts",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.path).toBe(targetPath);
		}
	});

	it("starts with #!/bin/sh shebang", () => {
		const targetPath = join(tempDir, "launch");
		installLauncher({
			targetPath,
			nodePath: "/usr/local/bin/node",
			daemonScriptPath: "/abs/daemon.ts",
		});
		const content = readFileSync(targetPath, "utf-8");
		expect(content.startsWith("#!/bin/sh\n")).toBe(true);
	});

	it("contains exec line with quoted node path and daemon script path", () => {
		const targetPath = join(tempDir, "launch");
		installLauncher({
			targetPath,
			nodePath: "/usr/local/bin/node",
			daemonScriptPath: "/abs/daemon.ts",
		});
		const content = readFileSync(targetPath, "utf-8");
		expect(content).toContain('exec "/usr/local/bin/node" "/abs/daemon.ts"');
	});

	it('includes "$@" to forward arguments', () => {
		const targetPath = join(tempDir, "launch");
		installLauncher({
			targetPath,
			nodePath: "/usr/local/bin/node",
			daemonScriptPath: "/abs/daemon.ts",
		});
		const content = readFileSync(targetPath, "utf-8");
		expect(content).toContain('"$@"');
	});

	it("sets file mode 0755", () => {
		const targetPath = join(tempDir, "launch");
		installLauncher({
			targetPath,
			nodePath: "/usr/local/bin/node",
			daemonScriptPath: "/abs/daemon.ts",
		});
		const stat = statSync(targetPath);
		const mode = stat.mode & 0o777;
		expect(mode).toBe(0o755);
	});

	it("creates parent directories if missing", () => {
		const targetPath = join(tempDir, "a", "b", "c", "launch");
		const result = installLauncher({
			targetPath,
			nodePath: "/usr/local/bin/node",
			daemonScriptPath: "/abs/daemon.ts",
		});
		expect(result.ok).toBe(true);
	});

	it("uses process.execPath when nodePath is omitted", () => {
		const targetPath = join(tempDir, "launch-default-node");
		installLauncher({
			targetPath,
			daemonScriptPath: "/abs/daemon.ts",
		});
		const content = readFileSync(targetPath, "utf-8");
		expect(content).toContain(process.execPath);
	});

	it("returns ok:false on write error (directory as target)", () => {
		const result = installLauncher({
			targetPath: tempDir, // directory, not a file
			nodePath: "/usr/local/bin/node",
			daemonScriptPath: "/abs/daemon.ts",
		});
		expect(result.ok).toBe(false);
	});

	it("handles spaces in paths (quotes them correctly)", () => {
		const targetPath = join(tempDir, "launch-spaces");
		installLauncher({
			targetPath,
			nodePath: "/usr/local/my node/node",
			daemonScriptPath: "/my projects/daemon.ts",
		});
		const content = readFileSync(targetPath, "utf-8");
		expect(content).toContain('"/usr/local/my node/node"');
		expect(content).toContain('"/my projects/daemon.ts"');
	});
});

// ---------------------------------------------------------------------------
// String(err) fallback when thrown value is not an Error instance
// ---------------------------------------------------------------------------

describe("installLauncher — non-Error throw uses String(err)", () => {
	it("returns ok:false with String(err) when fs throws a non-Error value", async () => {
		const { vi } = await import("vitest");
		// node:fs default export is mutable — spy on it directly
		const fsDefault = (await import("node:fs")).default;
		class FakeThrown {
			readonly message = "disk full str";
			toString() { return this.message; }
		}
		const spy = vi.spyOn(fsDefault, "writeFileSync").mockImplementationOnce(() => {
			throw new FakeThrown() as unknown as Error;
		});
		const result = installLauncher({
			targetPath: join(tempDir, "launch-non-error"),
			nodePath: "/usr/local/bin/node",
			daemonScriptPath: "/abs/daemon.ts",
		});
		spy.mockRestore();
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("disk full str");
		}
	});
});
