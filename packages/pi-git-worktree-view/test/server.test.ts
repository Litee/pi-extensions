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
