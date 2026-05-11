import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ArchonRun } from "./types.js";

export interface ArchonClient {
	getWorkflowStatus(): Promise<ArchonRun[]>;
}

export class ArchonCliError extends Error {
	constructor(
		message: string,
		public readonly exitCode: number | null,
	) {
		super(message);
		this.name = "ArchonCliError";
	}
}

/** Sentinel string present in archon's stderr when not in a git repo. */
const NOT_IN_GIT_REPO_MARKER = "Not in a git repository";

/**
 * SQLite reports this when another process holds a write lock. It is
 * transient — the runner releases the lock in milliseconds — so we retry
 * a few times before giving up.
 */
export const DB_LOCKED_MARKER = "database is locked";

/** How many times to retry a db-locked failure before surfacing the error. */
const DB_LOCKED_RETRIES = 3;

/** Delay between db-locked retries (ms). Doubles on each attempt. */
const DB_LOCKED_RETRY_BASE_MS = 150;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse raw archon CLI output. The command emits pino log lines
 * ({"level":30,...}) followed by the actual JSON ({runs:[...]}).
 * Filter out log lines and parse the remainder.
 */
export function parseStatusOutput(raw: string): ArchonRun[] {
	const lines = raw.split("\n");
	// Find lines that are NOT pino log lines (don't start with {"level":)
	const jsonLines = lines.filter(
		(l) => l.trim() !== "" && !l.trim().startsWith('{"level":'),
	);
	if (jsonLines.length === 0) return [];
	try {
		const parsed = JSON.parse(jsonLines.join("\n")) as { runs?: unknown };
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.runs)) {
			return [];
		}
		return parsed.runs
			.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object")
			.map((r): ArchonRun => {
				const run: ArchonRun = {
					...r,
					id: typeof r["id"] === "string" ? r["id"] : "",
					status: typeof r["status"] === "string" ? r["status"] : "",
				};
				// Normalise snake_case fields from the archon DB to camelCase.
				// The JSON output uses snake_case (workflow_name, working_path, etc.).
				const wn = r["workflow_name"] ?? r["workflowName"];
				if (typeof wn === "string") run.workflowName = wn;
				const wp = r["working_path"] ?? r["workingPath"];
				if (typeof wp === "string") run.workingPath = wp;
				const sa = r["started_at"] ?? r["startedAt"];
				if (typeof sa === "string") run.startedAt = sa;
				const la = r["last_activity_at"] ?? r["lastActivityAt"];
				if (typeof la === "string") run.lastActivityAt = la;
				// Normalize metadata.approval fields for paused runs.
				const meta = r["metadata"];
				if (meta !== null && typeof meta === "object") {
					const approval = (meta as Record<string, unknown>)["approval"];
					if (approval !== null && typeof approval === "object") {
						const ap = approval as Record<string, unknown>;
						if (typeof ap["nodeId"] === "string") run.approvalNodeId = ap["nodeId"];
						if (typeof ap["message"] === "string") run.approvalMessage = ap["message"];
					}
				}
				return run;
			});
	} catch {
		return [];
	}
}

/**
 * Find a git repository that archon itself created, to use as a `--cwd`
 * fallback when the process is not running inside a git repository.
 *
 * Archon creates worktrees under `~/.archon/workspaces/<owner>/<repo>/`.
 * Each workspace directory is a proper git clone, so we can pass any of
 * them to `--cwd` and archon will accept the invocation. The global
 * SQLite database (`~/.archon/archon.db`) is queried regardless of which
 * repo is used as context.
 *
 * Returns the first workspace path found, or `null` when no workspaces
 * exist yet (meaning no workflows have ever run, so there is nothing to
 * report).
 *
 * The `home` parameter is injectable for unit tests.
 */
export function findArchonWorkspaceCwd(home = homedir()): string | null {
	const workspacesDir = join(home, ".archon", "workspaces");
	try {
		for (const owner of readdirSync(workspacesDir, { withFileTypes: true })) {
			if (!owner.isDirectory()) continue;
			const ownerPath = join(workspacesDir, owner.name);
			for (const repo of readdirSync(ownerPath, { withFileTypes: true })) {
				if (!repo.isDirectory()) continue;
				const repoPath = join(ownerPath, repo.name);
				if (existsSync(join(repoPath, ".git"))) {
					return repoPath;
				}
			}
		}
	} catch {
		// workspacesDir doesn't exist or isn't readable — no workspaces yet.
	}
	return null;
}

/**
 * Run `archon workflow status --json`, optionally with a `--cwd` override.
 * Exported for unit tests that want to stub `execFile` behaviour.
 */
export function runArchonStatus(cwd?: string): Promise<ArchonRun[]> {
	const args = ["workflow", "status", "--json"];
	if (cwd !== undefined) args.push("--cwd", cwd);
	return new Promise((resolve, reject) => {
		execFile("archon", args, (err, stdout, stderr) => {
			if (err) {
				reject(
					new ArchonCliError(
						`archon workflow status failed: ${err.message}\nstderr: ${stderr}`,
						err.code as number | null,
					),
				);
				return;
			}
			resolve(parseStatusOutput(stdout));
		});
	});
}

export function createArchonClient(): ArchonClient {
	return {
		async getWorkflowStatus(): Promise<ArchonRun[]> {
			try {
				return await runWithRetry();
			} catch (err) {
				// When not in a git repository, retry with a known archon workspace
				// as the --cwd context. Archon reads from its global SQLite database
				// regardless of which repo is passed — the repo is only required as
				// a CLI guard.
				if ((err as Error).message.includes(NOT_IN_GIT_REPO_MARKER)) {
					const fallbackCwd = findArchonWorkspaceCwd();
					if (fallbackCwd !== null) {
						return runWithRetry(fallbackCwd);
					}
					// No workspaces exist yet — no workflows can be running.
					return [];
				}
				throw err;
			}
		},
	};
}

/**
 * Run `archon workflow status --json` with automatic retry on transient
 * SQLite "database is locked" errors. The archon workflow runner holds a
 * write lock briefly; retrying with exponential back-off resolves it.
 */
async function runWithRetry(cwd?: string): Promise<ArchonRun[]> {
	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= DB_LOCKED_RETRIES; attempt++) {
		if (attempt > 0) await sleep(DB_LOCKED_RETRY_BASE_MS * attempt);
		try {
			return await runArchonStatus(cwd);
		} catch (err) {
			if ((err as Error).message.includes(DB_LOCKED_MARKER)) {
				lastError = err as Error;
				continue;
			}
			throw err;
		}
	}
	throw lastError ?? new Error("All retry attempts failed");
}
