/**
 * Tests for src/daemon/daemon-logger.ts
 *
 * Key invariant: DaemonLogger MUST NOT write to process.stdout or process.stderr.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DaemonLogger } from "../src/daemon/daemon-logger.js";

let tempDir: string;
let logFile: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-bc-logger-"));
	logFile = join(tempDir, "daemon.log");
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Critical: no stdout/stderr writes
// ---------------------------------------------------------------------------

describe("DaemonLogger — MUST NOT touch stdout/stderr", () => {
	it("does not write to process.stdout", async () => {
		const writes: string[] = [];
		const orig = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		};
		try {
			const logger = new DaemonLogger(logFile);
			logger.info("test");
			logger.warn("test");
			logger.error("test");
			// Give appendFile a chance to run
			await new Promise<void>((r) => setTimeout(r, 50));
		} finally {
			process.stdout.write = orig;
		}
		expect(writes).toHaveLength(0);
	});

	it("does not write to process.stderr", async () => {
		const writes: string[] = [];
		const orig = process.stderr.write.bind(process.stderr);
		process.stderr.write = (chunk: unknown) => {
			writes.push(String(chunk));
			return true;
		};
		try {
			const logger = new DaemonLogger(logFile);
			logger.info("hello");
			logger.warn("world");
			logger.error("oops");
			await new Promise<void>((r) => setTimeout(r, 50));
		} finally {
			process.stderr.write = orig;
		}
		expect(writes).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// File logging
// ---------------------------------------------------------------------------

describe("DaemonLogger — file logging", () => {
	it("creates the log file on first write", async () => {
		const logger = new DaemonLogger(logFile);
		logger.info("first message");
		await new Promise<void>((r) => setTimeout(r, 50));
		expect(existsSync(logFile)).toBe(true);
	});

	it("appends JSON lines with correct level=INFO", async () => {
		const logger = new DaemonLogger(logFile);
		logger.info("hello world");
		await new Promise<void>((r) => setTimeout(r, 50));
		const lines = readFileSync(logFile, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(entry["level"]).toBe("INFO");
		expect(entry["msg"]).toBe("hello world");
		expect(typeof entry["ts"]).toBe("string");
	});

	it("appends JSON lines with correct level=WARN", async () => {
		const logger = new DaemonLogger(logFile);
		logger.warn("a warning");
		await new Promise<void>((r) => setTimeout(r, 50));
		const lines = readFileSync(logFile, "utf-8").trim().split("\n");
		const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(entry["level"]).toBe("WARN");
		expect(entry["msg"]).toBe("a warning");
	});

	it("appends JSON lines with correct level=ERROR", async () => {
		const logger = new DaemonLogger(logFile);
		logger.error("an error");
		await new Promise<void>((r) => setTimeout(r, 50));
		const lines = readFileSync(logFile, "utf-8").trim().split("\n");
		const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(entry["level"]).toBe("ERROR");
		expect(entry["msg"]).toBe("an error");
	});

	it("includes extra data field when provided", async () => {
		const logger = new DaemonLogger(logFile);
		logger.info("with data", { key: "value", num: 42 });
		await new Promise<void>((r) => setTimeout(r, 50));
		const lines = readFileSync(logFile, "utf-8").trim().split("\n");
		const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
		expect(entry["data"]).toEqual({ key: "value", num: 42 });
	});

	it("appends multiple entries on separate lines", async () => {
		const logger = new DaemonLogger(logFile);
		logger.info("first");
		logger.warn("second");
		logger.error("third");
		await new Promise<void>((r) => setTimeout(r, 100));
		const lines = readFileSync(logFile, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(3);
		for (const line of lines) {
			expect((): unknown => JSON.parse(line)).not.toThrow();
		}
	});

	it("ts field is a valid ISO-8601 string", async () => {
		const logger = new DaemonLogger(logFile);
		logger.info("ts test");
		await new Promise<void>((r) => setTimeout(r, 50));
		const line = readFileSync(logFile, "utf-8").trim();
		const entry = JSON.parse(line) as Record<string, unknown>;
		expect(typeof entry["ts"]).toBe("string");
		expect(isNaN(Date.parse(entry["ts"] as string))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Default path (logPath() branch)
// ---------------------------------------------------------------------------

describe("DaemonLogger — default path", () => {
	it("writes to a logPath()-derived path when passed explicitly", async () => {
		// Compute the expected log path for tempDir (explicit, no global env mutation)
		const { logPath } = await import("../src/socket-paths.js");
		const expectedPath = logPath(tempDir);
		const logger = new DaemonLogger(expectedPath);
		logger.info("default-path-test");
		await new Promise<void>((r) => setTimeout(r, 50));
		expect(existsSync(expectedPath)).toBe(true);
	});

	it("constructor without arguments uses logPath() default (covers ?? branch)", () => {
		// Calls DaemonLogger() with no args to exercise the path ?? logPath() null branch.
		// logPath() reads the env inside src — no test-level env mutation.
		expect(() => new DaemonLogger()).not.toThrow();
	});
});
