import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async () => {
	const actual = await vi.importActual<typeof import("node:os")>("node:os");
	return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});

import {
	ArchonCliError,
	findArchonWorkspaceCwd,
	parseStatusOutput,
	runArchonStatus,
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

	it("returns null when home exists but .archon/workspaces is absent", (_ctx) => {
		// Use the OS temp dir (guaranteed to exist, no .archon/workspaces inside).
		const tmp = "/tmp";
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

// ---------------------------------------------------------------------------
// metadata.approval normalization
describe("parseStatusOutput — approval metadata", () => {
	it("normalizes metadata.approval.nodeId to approvalNodeId", () => {
		const raw = JSON.stringify({
			runs: [{
				id: "r1", status: "paused", workflow_name: "my-wf",
				metadata: { approval: { nodeId: "plan-gate", message: "Review the plan." } },
			}],
		});
		const runs = parseStatusOutput(raw);
		expect(runs[0]!.approvalNodeId).toBe("plan-gate");
		expect(runs[0]!.approvalMessage).toBe("Review the plan.");
	});

	it("normalizes metadata.approval.type to approvalType", () => {
		const raw = JSON.stringify({
			runs: [{
				id: "r1", status: "paused",
				metadata: { approval: { nodeId: "plan-gate", message: "msg", type: "approval" } },
			}],
		});
		const runs = parseStatusOutput(raw);
		expect(runs[0]!.approvalType).toBe("approval");
	});

	it("handles metadata === null gracefully (line 81 FALSE branch)", () => {
		const raw = JSON.stringify({
			runs: [{ id: "r1", status: "paused", metadata: null }],
		});
		const runs = parseStatusOutput(raw);
		expect(runs[0]!.approvalNodeId).toBeUndefined();
		expect(runs[0]!.approvalMessage).toBeUndefined();
	});

	it("handles metadata as a non-object (line 81 FALSE branch via typeof check)", () => {
		const raw = JSON.stringify({
			runs: [{ id: "r1", status: "paused", metadata: "not-an-object" }],
		});
		const runs = parseStatusOutput(raw);
		expect(runs[0]!.approvalNodeId).toBeUndefined();
	});

	it("handles metadata.approval === null gracefully (line 83 FALSE branch)", () => {
		const raw = JSON.stringify({
			runs: [{ id: "r1", status: "paused", metadata: { approval: null } }],
		});
		const runs = parseStatusOutput(raw);
		expect(runs[0]!.approvalNodeId).toBeUndefined();
	});

	it("handles metadata.approval as non-object string (line 83 FALSE branch via typeof)", () => {
		const raw = JSON.stringify({
			runs: [{ id: "r1", status: "paused", metadata: { approval: "some-string" } }],
		});
		const runs = parseStatusOutput(raw);
		expect(runs[0]!.approvalNodeId).toBeUndefined();
	});

	it("handles missing metadata.approval gracefully", () => {
		const raw = JSON.stringify({ runs: [{ id: "r1", status: "running" }] });
		const runs = parseStatusOutput(raw);
		expect(runs[0]!.approvalNodeId).toBeUndefined();
		expect(runs[0]!.approvalMessage).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// DB_LOCKED_MARKER export
// ---------------------------------------------------------------------------

describe("DB_LOCKED_MARKER", () => {
	it("is exported and matches the archon error string", async () => {
		const { DB_LOCKED_MARKER } = await import("../src/archon-client.js");
		expect(DB_LOCKED_MARKER).toBe("database is locked");
	});
});

// ---------------------------------------------------------------------------
// runWithRetry — db-locked retry loop (lines 39, 191-192, 197)
// ---------------------------------------------------------------------------

describe("runWithRetry — db-locked retry exhaustion (lines 39, 191-192, 197)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.resetAllMocks();
	});

	it("retries on every db-locked error, sleeps between attempts, and throws after all retries exhausted", async () => {
		const childProcess = await import("node:child_process");
		const execFileMock = vi.mocked(childProcess.execFile);
		execFileMock.mockImplementation(
			((_cmd: string, _args: readonly string[], cb: (err: Error, stdout: string, stderr: string) => void) => {
				cb(Object.assign(new Error("database is locked"), { code: 1 }), "", "");
			}) as typeof childProcess.execFile,
		);

		const client = createArchonClient();
		const promise = client.getWorkflowStatus();
		// Attach the rejection handler BEFORE advancing timers to avoid unhandled-rejection warnings.
		const assertion = expect(promise).rejects.toThrow("database is locked");
		// Advance all fake timers so the sleep() calls between retries resolve.
		await vi.runAllTimersAsync();
		await assertion;
		// 4 total execFile calls: attempts 0, 1, 2, 3 (DB_LOCKED_RETRIES = 3)
		expect(execFileMock.mock.calls.length).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// findArchonWorkspaceCwd — .git found and non-dir skipped
// ---------------------------------------------------------------------------

describe("findArchonWorkspaceCwd — git workspace present", () => {
	it("returns the repo path when a .git directory exists inside a workspace", () => {
		const tmp = pathJoin(tmpdir(), "archon-faw-" + Date.now());
		const repoPath = pathJoin(tmp, ".archon", "workspaces", "owner", "my-repo");
		mkdirSync(pathJoin(repoPath, ".git"), { recursive: true });
		try {
			const result = findArchonWorkspaceCwd(tmp);
			expect(result).toBe(repoPath);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("skips non-directory entries in the owner dir (covers line 118 TRUE - repo-level skip)", () => {
		const tmp = pathJoin(tmpdir(), "archon-faw-skip-" + Date.now());
		const ownerDir = pathJoin(tmp, ".archon", "workspaces", "owner");
		mkdirSync(ownerDir, { recursive: true });
		// Place a file where a repo directory would be expected
		writeFileSync(pathJoin(ownerDir, "not-a-dir.txt"), "x");
		try {
			const result = findArchonWorkspaceCwd(tmp);
			expect(result).toBeNull();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("skips non-directory entries in workspaces root (covers line 115 TRUE - owner-level skip)", () => {
		const tmp = pathJoin(tmpdir(), "archon-faw-skip-owner-" + Date.now());
		const workspacesDir = pathJoin(tmp, ".archon", "workspaces");
		mkdirSync(workspacesDir, { recursive: true });
		// Place a file directly in .archon/workspaces/ where an owner dir would be expected
		writeFileSync(pathJoin(workspacesDir, "not-an-owner.txt"), "x");
		try {
			const result = findArchonWorkspaceCwd(tmp);
			expect(result).toBeNull();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("returns null when repo dir exists but has no .git directory (covers line 120 FALSE)", () => {
		const tmp = pathJoin(tmpdir(), "archon-faw-nogit-" + Date.now());
		const repoDir = pathJoin(tmp, ".archon", "workspaces", "owner", "repo");
		mkdirSync(repoDir, { recursive: true });
		// NO .git directory — existsSync returns false
		try {
			const result = findArchonWorkspaceCwd(tmp);
			expect(result).toBeNull();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// runArchonStatus — success and error paths via execFile mock
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
}));

describe("runArchonStatus", () => {
	afterEach(() => {
		vi.resetAllMocks();
	});

	it("resolves with parsed runs on success", async () => {
		const childProcess = await import("node:child_process");
		const execFileMock = vi.mocked(childProcess.execFile);
		const stdout = JSON.stringify({ runs: [{ id: "r1", status: "running" }] });
		execFileMock.mockImplementation(
			((_cmd: string, _args: readonly string[], cb: (err: null, stdout: string, stderr: string) => void) => {
				cb(null, stdout, "");
			}) as typeof childProcess.execFile,
		);
		const runs = await runArchonStatus();
		expect(runs).toHaveLength(1);
		expect(runs[0]!.id).toBe("r1");
	});

	it("rejects with ArchonCliError when execFile errors", async () => {
		const childProcess = await import("node:child_process");
		const execFileMock = vi.mocked(childProcess.execFile);
		const fakeErr = Object.assign(new Error("archon crashed"), { code: 1 });
		execFileMock.mockImplementation(
			((_cmd: string, _args: readonly string[], cb: (err: Error, stdout: string, stderr: string) => void) => {
				cb(fakeErr, "", "stderr output");
			}) as typeof childProcess.execFile,
		);
		await expect(runArchonStatus()).rejects.toBeInstanceOf(ArchonCliError);
	});

	it("appends --cwd when a cwd argument is provided", async () => {
		const childProcess = await import("node:child_process");
		const execFileMock = vi.mocked(childProcess.execFile);
		let capturedArgs: readonly string[] = [];
		execFileMock.mockImplementation(
			((_cmd: string, args: readonly string[], cb: (err: null, stdout: string, stderr: string) => void) => {
				capturedArgs = args;
				cb(null, JSON.stringify({ runs: [] }), "");
			}) as typeof childProcess.execFile,
		);
		await runArchonStatus("/my/cwd");
		expect(capturedArgs).toContain("--cwd");
		expect(capturedArgs).toContain("/my/cwd");
	});
});

// ---------------------------------------------------------------------------
// createArchonClient — getWorkflowStatus branches (lines 155-197)
// ---------------------------------------------------------------------------

import { createArchonClient } from "../src/archon-client.js";

describe("createArchonClient — getWorkflowStatus", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetAllMocks();
	});

	it("returns parsed runs on success", async () => {
		const childProcess = await import("node:child_process");
		const execFileMock = vi.mocked(childProcess.execFile);
		const stdout = JSON.stringify({ runs: [{ id: "r2", status: "running" }] });
		execFileMock.mockImplementation(
			((_cmd: string, _args: readonly string[], cb: (err: null, stdout: string, stderr: string) => void) => {
				cb(null, stdout, "");
			}) as typeof childProcess.execFile,
		);
		const client = createArchonClient();
		const runs = await client.getWorkflowStatus();
		expect(runs[0]!.id).toBe("r2");
	});

	it("returns empty array when NOT_IN_GIT_REPO and fallback workspace exists", async () => {
		const childProcess = await import("node:child_process");
		const execFileMock = vi.mocked(childProcess.execFile);
		let callCount = 0;
		execFileMock.mockImplementation(
			((_cmd: string, _args: readonly string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
				callCount++;
				if (callCount === 1) {
					cb(Object.assign(new Error("Not in a git repository"), { code: 128 }), "", "");
				} else {
					cb(null, JSON.stringify({ runs: [] }), "");
				}
			}) as typeof childProcess.execFile,
		);

		const fakeHome = pathJoin(tmpdir(), "archon-client-home-" + Date.now());
		const repoPath = pathJoin(fakeHome, ".archon", "workspaces", "owner", "repo");
		mkdirSync(pathJoin(repoPath, ".git"), { recursive: true });
		vi.mocked(homedir).mockReturnValue(fakeHome);

		try {
			const client = createArchonClient();
			const runs = await client.getWorkflowStatus();
			expect(runs).toEqual([]);
			expect(callCount).toBe(2);
		} finally {
			rmSync(fakeHome, { recursive: true, force: true });
		}
	});

	it("returns empty array when NOT_IN_GIT_REPO and no workspace exists", async () => {
		const childProcess = await import("node:child_process");
		const execFileMock = vi.mocked(childProcess.execFile);
		execFileMock.mockImplementation(
			((_cmd: string, _args: readonly string[], cb: (err: Error, stdout: string, stderr: string) => void) => {
				cb(Object.assign(new Error("Not in a git repository"), { code: 128 }), "", "");
			}) as typeof childProcess.execFile,
		);
		vi.mocked(homedir).mockReturnValue("/nonexistent-home-xyz-abc");

		const client = createArchonClient();
		const runs = await client.getWorkflowStatus();
		expect(runs).toEqual([]);
	});

	it("rethrows errors that are not NOT_IN_GIT_REPO", async () => {
		const childProcess = await import("node:child_process");
		const execFileMock = vi.mocked(childProcess.execFile);
		execFileMock.mockImplementation(
			((_cmd: string, _args: readonly string[], cb: (err: Error, stdout: string, stderr: string) => void) => {
				cb(new Error("permission denied"), "", "");
			}) as typeof childProcess.execFile,
		);
		const client = createArchonClient();
		await expect(client.getWorkflowStatus()).rejects.toThrow("permission denied");
	});
});

// ---------------------------------------------------------------------------
// parseStatusOutput — partial approval fields (lines 83-84 FALSE branches)
// ---------------------------------------------------------------------------

describe("parseStatusOutput — partial approval fields (lines 83-84-85 FALSE branches)", () => {
	it("handles approval object with no nodeId (line 83 FALSE — typeof nodeId !== 'string')", () => {
		const raw = JSON.stringify({
			runs: [{ id: "r1", status: "paused", metadata: { approval: { message: "msg", type: "approval" } } }],
		});
		const runs = parseStatusOutput(raw);
		expect(runs[0]!.approvalNodeId).toBeUndefined();
		expect(runs[0]!.approvalMessage).toBe("msg");
	});

	it("handles approval object with no message (line 84 FALSE — typeof message !== 'string')", () => {
		const raw = JSON.stringify({
			runs: [{ id: "r1", status: "paused", metadata: { approval: { nodeId: "gate", type: "approval" } } }],
		});
		const runs = parseStatusOutput(raw);
		expect(runs[0]!.approvalNodeId).toBe("gate");
		expect(runs[0]!.approvalMessage).toBeUndefined();
	});

	it("handles approval object with no type (line 85 FALSE — typeof type !== 'string')", () => {
		const raw = JSON.stringify({
			runs: [{ id: "r1", status: "paused", metadata: { approval: { nodeId: "gate", message: "msg" } } }],
		});
		const runs = parseStatusOutput(raw);
		expect(runs[0]!.approvalType).toBeUndefined();
	});
});
