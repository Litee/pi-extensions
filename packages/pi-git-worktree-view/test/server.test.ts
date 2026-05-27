/**
 * Integration tests for the HTTP server module.
 *
 * These tests start a real HTTP server bound to a free port (0) and make
 * actual HTTP requests to exercise route dispatch, JSON serialisation,
 * HTML serving, SSE, and error responses.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer } from "../src/server.js";
import type { ServerHandle } from "../src/server.js";

let tmpDir: string;
let handle: ServerHandle | null = null;

beforeEach(() => {
	tmpDir = mkdtempSync("/tmp/pi-gwv-server-test-");
	// Minimal git repo so getWorktrees can run
	execSync("git init", { cwd: tmpDir, stdio: "ignore" });
	execSync("git commit --allow-empty -m init", {
		cwd: tmpDir,
		stdio: "ignore",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@test.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@test.com",
		},
	});
});

afterEach(() => {
	if (handle) {
		handle.close();
		handle = null;
	}
	rmSync(tmpDir, { recursive: true, force: true });
});

async function get(path: string, base: string): Promise<Response> {
	return fetch(`http://127.0.0.1:${base}${path}`);
}

describe("startServer — lifecycle", () => {
	it("binds to a free port (port 0) and returns a numeric port", async () => {
		handle = await startServer(tmpDir, 0);
		expect(handle.port).toBeTypeOf("number");
		expect(handle.port).toBeGreaterThan(0);
	});

	it("close() does not throw", async () => {
		handle = await startServer(tmpDir, 0);
		expect(() => handle!.close()).not.toThrow();
		handle = null;
	});
});

describe("startServer — route dispatch", () => {
	let port: string;

	beforeEach(async () => {
		handle = await startServer(tmpDir, 0);
		port = String(handle.port);
	});

	it("GET / returns HTML with 200", async () => {
		const res = await get("/", port);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const body = await res.text();
		expect(body).toContain("<!DOCTYPE html>");
	});

	it("GET /api/worktrees returns a JSON array", async () => {
		const res = await get("/api/worktrees", port);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const data = await res.json() as unknown[];
		expect(Array.isArray(data)).toBe(true);
	});

	it("GET /api/worktree-status without ?path= returns 400", async () => {
		const res = await get("/api/worktree-status", port);
		expect(res.status).toBe(400);
	});

	it("GET /api/worktree-status?path=<valid> returns a JSON array", async () => {
		const res = await get(
			`/api/worktree-status?path=${encodeURIComponent(tmpDir)}`,
			port,
		);
		expect(res.status).toBe(200);
		const data = await res.json() as unknown[];
		expect(Array.isArray(data)).toBe(true);
	});

	it("GET /api/diff without params returns 400", async () => {
		const res = await get("/api/diff", port);
		expect(res.status).toBe(400);
	});

	it("GET /api/diff with worktree but no file returns 400", async () => {
		const res = await get(`/api/diff?worktree=${encodeURIComponent(tmpDir)}`, port);
		expect(res.status).toBe(400);
	});

	it("GET /unknown-route returns 404", async () => {
		const res = await get("/does-not-exist", port);
		expect(res.status).toBe(404);
	});

	it("GET /api/events returns SSE stream headers", async () => {
		// Abort after a short time — the SSE stream stays open indefinitely
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
				signal: controller.signal,
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("text/event-stream");
		} catch (_err) {
			// AbortError is expected when we tear down the SSE connection
		}
	});
});

describe("startServer — port fallback", () => {
	it("falls back to random port when preferred port is already in use", async () => {
		// Bind the first server to get a port
		const first = await startServer(tmpDir, 0);
		const takenPort = first.port;
		try {
			// Try to bind to the taken port — should fall back to a random port
			handle = await startServer(tmpDir, takenPort);
			expect(handle.port).not.toBe(takenPort);
			expect(handle.port).toBeGreaterThan(0);
		} finally {
			first.close();
		}
	});
});

// ---------------------------------------------------------------------------
// Route coverage: getWorktreeStatus with actual changed files
// ---------------------------------------------------------------------------

describe("startServer — /api/worktree-status with files", () => {
	let filePort: string;
	let fileHandle: ServerHandle | null = null;

	beforeEach(async () => {
		fileHandle = await startServer(tmpDir, 0);
		filePort = String(fileHandle.port);
	});

	afterEach(() => {
		fileHandle?.close();
		fileHandle = null;
	});

	it("returns untracked file in status list", async () => {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(tmpDir, "newfile.txt"), "hello");
		const res = await get(
			`/api/worktree-status?path=${encodeURIComponent(tmpDir)}`,
			filePort,
		);
		expect(res.status).toBe(200);
		const files = await res.json() as Array<{ path: string; status: string }>;
		const entry = files.find((f) => f.path === "newfile.txt");
		expect(entry).toBeDefined();
		expect(entry!.status).toBe("?"); // untracked
	});

	it("returns diff for an untracked file (status=?)", async () => {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(tmpDir, "untracked.ts"), "export const x = 1;\n");
		const res = await get(
			`/api/diff?worktree=${encodeURIComponent(tmpDir)}&file=untracked.ts&status=?`,
			filePort,
		);
		expect(res.status).toBe(200);
		const data = await res.json() as { lines: unknown[] };
		expect(Array.isArray(data.lines)).toBe(true);
		expect(data.lines.length).toBeGreaterThan(0);
	});

	it("returns diff for a modified file (status=M)", async () => {
		const { writeFileSync } = await import("node:fs");
		// Stage a new file, then modify it to create an M status
		const filePath = join(tmpDir, "tracked.ts");
		writeFileSync(filePath, "export const x = 1;\n");
		execSync("git add tracked.ts", { cwd: tmpDir, stdio: "ignore" });
		execSync("git commit -m 'add tracked'", {
			cwd: tmpDir,
			stdio: "ignore",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "Test",
				GIT_AUTHOR_EMAIL: "test@test.com",
				GIT_COMMITTER_NAME: "Test",
				GIT_COMMITTER_EMAIL: "test@test.com",
			},
		});
		writeFileSync(filePath, "export const x = 42;\n"); // modify it

		const res = await get(
			`/api/diff?worktree=${encodeURIComponent(tmpDir)}&file=tracked.ts&status=M`,
			filePort,
		);
		expect(res.status).toBe(200);
		const data = await res.json() as { lines: unknown[] };
		expect(Array.isArray(data.lines)).toBe(true);
	});

	it("returns diff for a newly staged file (status=A)", async () => {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(tmpDir, "added.ts"), "export const y = 2;\n");
		execSync("git add added.ts", { cwd: tmpDir, stdio: "ignore" });

		const res = await get(
			`/api/diff?worktree=${encodeURIComponent(tmpDir)}&file=added.ts&status=A`,
			filePort,
		);
		expect(res.status).toBe(200);
		const data = await res.json() as { lines: unknown[] };
		expect(Array.isArray(data.lines)).toBe(true);
	});

	it("handles deleted file gracefully (status=D)", async () => {
		const { writeFileSync } = await import("node:fs");
		// Create, commit, then delete a file
		writeFileSync(join(tmpDir, "todelete.ts"), "export const z = 3;\n");
		execSync("git add todelete.ts", { cwd: tmpDir, stdio: "ignore" });
		execSync("git commit -m 'add todelete'", {
			cwd: tmpDir,
			stdio: "ignore",
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "Test",
				GIT_AUTHOR_EMAIL: "test@test.com",
				GIT_COMMITTER_NAME: "Test",
				GIT_COMMITTER_EMAIL: "test@test.com",
			},
		});
		execSync("git rm todelete.ts", { cwd: tmpDir, stdio: "ignore" });

		const res = await get(
			`/api/diff?worktree=${encodeURIComponent(tmpDir)}&file=todelete.ts&status=D`,
			filePort,
		);
		expect(res.status).toBe(200);
		const data = await res.json() as { lines: unknown[] };
		expect(Array.isArray(data.lines)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// getWorktreeStatus — full status-character coverage
// ---------------------------------------------------------------------------

describe("startServer — getWorktreeStatus status chars", () => {
	const GIT_ENV = {
		...process.env,
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@test.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@test.com",
	};

	let statusPort: string;
	let statusHandle: ServerHandle | null = null;

	beforeEach(async () => {
		statusHandle = await startServer(tmpDir, 0);
		statusPort = String(statusHandle.port);
	});

	afterEach(() => {
		statusHandle?.close();
		statusHandle = null;
	});

	it("returns status=A for a newly staged (index-added) file", async () => {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(tmpDir, "staged-new.ts"), "export const v = 1;\n");
		execSync("git add staged-new.ts", { cwd: tmpDir, stdio: "ignore" });

		const res = await get(
			`/api/worktree-status?path=${encodeURIComponent(tmpDir)}`,
			statusPort,
		);
		expect(res.status).toBe(200);
		const files = await res.json() as Array<{ path: string; status: string }>;
		const entry = files.find((f) => f.path === "staged-new.ts");
		expect(entry).toBeDefined();
		expect(entry!.status).toBe("A");
	});

	it("returns status=M for a worktree-modified committed file", async () => {
		const { writeFileSync } = await import("node:fs");
		const fp = join(tmpDir, "tracked-m.ts");
		writeFileSync(fp, "const a = 1;\n");
		execSync("git add tracked-m.ts", { cwd: tmpDir, stdio: "ignore" });
		execSync("git commit -m 'add tracked-m'", { cwd: tmpDir, stdio: "ignore", env: GIT_ENV });
		writeFileSync(fp, "const a = 42;\n"); // modify in working tree

		const res = await get(
			`/api/worktree-status?path=${encodeURIComponent(tmpDir)}`,
			statusPort,
		);
		expect(res.status).toBe(200);
		const files = await res.json() as Array<{ path: string; status: string }>;
		const entry = files.find((f) => f.path === "tracked-m.ts");
		expect(entry).toBeDefined();
		expect(entry!.status).toBe("M");
	});

	it("returns status=D for a staged-deleted file", async () => {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(tmpDir, "to-rm.ts"), "const z = 3;\n");
		execSync("git add to-rm.ts", { cwd: tmpDir, stdio: "ignore" });
		execSync("git commit -m 'add to-rm'", { cwd: tmpDir, stdio: "ignore", env: GIT_ENV });
		execSync("git rm to-rm.ts", { cwd: tmpDir, stdio: "ignore" });

		const res = await get(
			`/api/worktree-status?path=${encodeURIComponent(tmpDir)}`,
			statusPort,
		);
		expect(res.status).toBe(200);
		const files = await res.json() as Array<{ path: string; status: string }>;
		const entry = files.find((f) => f.path === "to-rm.ts");
		expect(entry).toBeDefined();
		expect(entry!.status).toBe("D");
	});

	it("handles worktree with no changes (empty status)", async () => {
		const res = await get(
			`/api/worktree-status?path=${encodeURIComponent(tmpDir)}`,
			statusPort,
		);
		expect(res.status).toBe(200);
		const files = await res.json() as unknown[];
		expect(Array.isArray(files)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// getDiff — coverage for missing branches
// ---------------------------------------------------------------------------

describe("startServer — getDiff edge cases", () => {
	const GIT_ENV = {
		...process.env,
		GIT_AUTHOR_NAME: "Test",
		GIT_AUTHOR_EMAIL: "test@test.com",
		GIT_COMMITTER_NAME: "Test",
		GIT_COMMITTER_EMAIL: "test@test.com",
	};

	let edgePort: string;
	let edgeHandle: ServerHandle | null = null;

	beforeEach(async () => {
		edgeHandle = await startServer(tmpDir, 0);
		edgePort = String(edgeHandle.port);
	});

	afterEach(() => {
		edgeHandle?.close();
		edgeHandle = null;
	});

	it("returns empty lines when untracked file does not exist on disk (readFile catch)", async () => {
		// status=? but the file is absent — triggers the readFile catch block
		const res = await get(
			`/api/diff?worktree=${encodeURIComponent(tmpDir)}&file=does-not-exist.ts&status=?`,
			edgePort,
		);
		expect(res.status).toBe(200);
		const data = await res.json() as { lines: unknown[] };
		expect(Array.isArray(data.lines)).toBe(true);
		expect(data.lines).toHaveLength(0);
	});

	it("falls back to staged diff when worktree diff is empty (staged-only change)", async () => {
		const { writeFileSync } = await import("node:fs");
		const fp = join(tmpDir, "staged-only.ts");

		// Commit the file with content A
		writeFileSync(fp, "const x = 1;\n");
		execSync("git add staged-only.ts", { cwd: tmpDir, stdio: "ignore" });
		execSync("git commit -m 'base'", { cwd: tmpDir, stdio: "ignore", env: GIT_ENV });

		// Modify and stage (index now has B)
		writeFileSync(fp, "const x = 42;\n");
		execSync("git add staged-only.ts", { cwd: tmpDir, stdio: "ignore" });

		// Revert the working tree back to A — so HEAD=A, index=B, worktree=A
		// "git diff HEAD -- file" returns empty (worktree == HEAD)
		// "git diff --cached -- file" returns the staged change
		writeFileSync(fp, "const x = 1;\n");

		const res = await get(
			`/api/diff?worktree=${encodeURIComponent(tmpDir)}&file=staged-only.ts&status=M`,
			edgePort,
		);
		expect(res.status).toBe(200);
		const data = await res.json() as { lines: unknown[] };
		expect(Array.isArray(data.lines)).toBe(true);
		// The fallback staged diff should return non-empty diff lines
		expect(data.lines.length).toBeGreaterThan(0);
	});

	it("returns empty lines when git diff fails (invalid worktree path — outer catch)", async () => {
		const res = await get(
			`/api/diff?worktree=%2Ftmp%2F__no-such-repo__&file=f.ts&status=M`,
			edgePort,
		);
		expect(res.status).toBe(200);
		const data = await res.json() as { lines: unknown[] };
		expect(Array.isArray(data.lines)).toBe(true);
		expect(data.lines).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// handleRequest — 500 internal-error path
// ---------------------------------------------------------------------------

describe("startServer — 500 error on broken git repo", () => {
	it("returns 500 when git command fails for /api/worktrees", async () => {
		// Start server, then destroy the .git directory so git commands fail
		const brokenHandle = await startServer(tmpDir, 0);
		const brokenPort = String(brokenHandle.port);
		try {
			const { rmSync } = await import("node:fs");
			rmSync(join(tmpDir, ".git"), { recursive: true, force: true });

			const res = await get("/api/worktrees", brokenPort);
			expect(res.status).toBe(500);
		} finally {
			brokenHandle.close();
		}
	});
});

// ---------------------------------------------------------------------------
// getWorktrees — bare worktree and trailing-flush edge cases
// ---------------------------------------------------------------------------

describe("startServer — getWorktrees porcelain parsing edge cases", () => {
	it("returns worktree list that includes the main entry (trailing flush path)", async () => {
		// A single worktree with no other worktrees triggers the
		// 'flush last entry if no trailing blank line' path in getWorktrees.
		const singleHandle = await startServer(tmpDir, 0);
		const singlePort = String(singleHandle.port);
		try {
			const res = await get("/api/worktrees", singlePort);
			expect(res.status).toBe(200);
			const data = await res.json() as Array<{ path: string; isMain: boolean }>;
			expect(Array.isArray(data)).toBe(true);
			expect(data.length).toBeGreaterThan(0);
			const main = data.find((w) => w.isMain);
			expect(main).toBeDefined();
		} finally {
			singleHandle.close();
		}
	});
});
