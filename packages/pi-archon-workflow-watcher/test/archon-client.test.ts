import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	ArchonCliError,
	findArchonWorkspaceCwd,
	parseStatusOutput,
} from "../src/archon-client.js";

// ---------------------------------------------------------------------------
// parseStatusOutput tests (unchanged)
// ---------------------------------------------------------------------------

describe("parseStatusOutput", () => {
	it("returns empty array for empty string", () => {
		expect(parseStatusOutput("")).toEqual([]);
	});

	it("returns empty array for whitespace-only string", () => {
		expect(parseStatusOutput("   \n  \n  ")).toEqual([]);
	});

	it("filters out pino log lines and parses JSON with runs", () => {
		const raw = [
			'{"level":30,"time":123,"msg":"db.connection_sqlite_selected"}',
			'{"level":30,"time":124,"msg":"db.sqlite_schema_initialized"}',
			JSON.stringify({ runs: [{ id: "run-1", status: "running", workflowName: "my-wf" }] }),
		].join("\n");
		const result = parseStatusOutput(raw);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			id: "run-1",
			status: "running",
			workflowName: "my-wf",
		});
	});

	it("parses real archon CLI output format (multiline JSON + pino logs)", () => {
		const raw = [
			'{"level":30,"time":1778422369109,"pid":38406,"hostname":"f4d488950f52","module":"db.connection","dbPath":"/Users/user/.archon/archon.db","msg":"db.connection_sqlite_selected"}',
			'{"level":30,"time":1778422369119,"pid":38406,"hostname":"f4d488950f52","module":"db.sqlite","msg":"db.sqlite_schema_initialized"}',
			'{',
			'  "runs": []',
			'}',
		].join("\n");
		expect(parseStatusOutput(raw)).toEqual([]);
	});

	it("returns empty array for invalid JSON", () => {
		expect(parseStatusOutput("not json at all")).toEqual([]);
	});

	it("returns empty array when runs is missing", () => {
		expect(parseStatusOutput(JSON.stringify({ other: [] }))).toEqual([]);
	});

	it("returns empty array when runs is null", () => {
		expect(parseStatusOutput(JSON.stringify({ runs: null }))).toEqual([]);
	});

	it("returns empty array when runs is a string", () => {
		expect(parseStatusOutput(JSON.stringify({ runs: "not-an-array" }))).toEqual([]);
	});

	it("returns empty array when runs is an empty array", () => {
		expect(parseStatusOutput(JSON.stringify({ runs: [] }))).toEqual([]);
	});

	it("handles a run with all optional fields present (snake_case, real archon output)", () => {
		const raw = JSON.stringify({
			runs: [
				{
					id: "abc",
					status: "completed",
					workflow_name: "my-workflow",
					working_path: "/repos/my-repo",
					started_at: "2024-01-01T00:00:00Z",
					last_activity_at: "2024-01-01T01:00:00Z",
				},
			],
		});
		const result = parseStatusOutput(raw);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			id: "abc",
			status: "completed",
			workflowName: "my-workflow",
			workingPath: "/repos/my-repo",
			startedAt: "2024-01-01T00:00:00Z",
			lastActivityAt: "2024-01-01T01:00:00Z",
		});
	});

	it("sets missing optional fields to undefined", () => {
		const raw = JSON.stringify({
			runs: [{ id: "r1", status: "running" }],
		});
		const result = parseStatusOutput(raw);
		expect(result[0]!.workflowName).toBeUndefined();
		expect(result[0]!.workingPath).toBeUndefined();
		expect(result[0]!.startedAt).toBeUndefined();
		expect(result[0]!.lastActivityAt).toBeUndefined();
	});

	it("filters out null items from the runs array", () => {
		const raw = JSON.stringify({
			runs: [null, { id: "r1", status: "running" }, null],
		});
		const result = parseStatusOutput(raw);
		expect(result).toHaveLength(1);
		expect(result[0]!.id).toBe("r1");
	});

	it("preserves unknown fields from the run object", () => {
		const raw = JSON.stringify({
			runs: [{ id: "r1", status: "running", customField: "value", nested: { x: 1 } }],
		});
		const result = parseStatusOutput(raw);
		expect(result[0]!["customField"]).toBe("value");
		expect(result[0]!["nested"]).toEqual({ x: 1 });
	});

	it("handles multiple runs", () => {
		const raw = JSON.stringify({
			runs: [
				{ id: "r1", status: "running", workflowName: "wf1" },
				{ id: "r2", status: "paused", workflowName: "wf2" },
				{ id: "r3", status: "completed", workflowName: "wf3" },
			],
		});
		const result = parseStatusOutput(raw);
		expect(result).toHaveLength(3);
		expect(result.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
	});

	it("normalises non-string id to empty string", () => {
		const raw = JSON.stringify({
			runs: [{ id: 42, status: "running" }],
		});
		const result = parseStatusOutput(raw);
		expect(result[0]!.id).toBe("");
	});

	it("normalises non-string status to empty string", () => {
		const raw = JSON.stringify({
			runs: [{ id: "r1", status: null }],
		});
		const result = parseStatusOutput(raw);
		expect(result[0]!.status).toBe("");
	});
});

// ---------------------------------------------------------------------------
// findArchonWorkspaceCwd tests
// ---------------------------------------------------------------------------

describe("findArchonWorkspaceCwd", () => {
	it("returns null when the workspaces directory does not exist", () => {
		expect(findArchonWorkspaceCwd("/nonexistent-home-12345")).toBeNull();
	});

	it("returns null when home exists but .archon/workspaces is absent", (ctx) => {
		// Use the OS temp dir (guaranteed to exist, no .archon/workspaces inside).
		const tmp = import.meta.env?.VITEST_WORKER_ID
			? "/tmp"
			: "/tmp";
		const result = findArchonWorkspaceCwd(tmp);
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// ArchonCliError
// ---------------------------------------------------------------------------

describe("ArchonCliError", () => {
	it("sets name, message, and exitCode", () => {
		const err = new ArchonCliError("something failed\nstderr: oops", 1);
		expect(err.name).toBe("ArchonCliError");
		expect(err.message).toContain("something failed");
		expect(err.exitCode).toBe(1);
	});

	it("accepts null exitCode", () => {
		const err = new ArchonCliError("cmd not found", null);
		expect(err.exitCode).toBeNull();
	});

	it("is an instance of Error", () => {
		expect(new ArchonCliError("x", 0)).toBeInstanceOf(Error);
	});
});
