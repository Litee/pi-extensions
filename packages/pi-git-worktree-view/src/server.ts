/**
 * HTTP server for the git worktree explorer.
 *
 * Exposes four routes:
 *   GET /                            — SPA HTML shell
 *   GET /api/worktrees               — list of worktrees (JSON)
 *   GET /api/worktree-status?path=…  — changed files in a worktree (JSON)
 *   GET /api/diff?worktree=…&file=…&status=…  — side-by-side diff (JSON)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildHtml } from "./html.js";
import { parseUnifiedDiff, buildUntrackedDiff } from "./diff.js";
import { watchWorktrees } from "./watcher.js";
import type { WatcherHandle } from "./watcher.js";
import type { DiffLine } from "./diff.js";

const execFileAsync = promisify(execFile);

// ── SSE clients ───────────────────────────────────────────────────────────────

const sseClients = new Set<ServerResponse>();

// Debounced broadcast: coalesces rapid fs.watch bursts into one refresh.
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
function broadcastRefresh(): void {
	if (debounceTimer) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => {
		debounceTimer = null;
		for (const res of sseClients) {
			try {
				res.write("event: refresh\ndata: {}\n\n");
			} catch {
				sseClients.delete(res);
			}
		}
	}, 1500);
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface ServerHandle {
	port: number;
	close: () => void;
}

/**
 * Start the HTTP server bound to `repoRoot`.
 * Passing `port = 0` (the default) lets the OS pick a free port.
 */
export async function startServer(repoRoot: string, preferredPort = 0): Promise<ServerHandle> {
	const server = createServer((req, res) => {
		void handleRequest(req, res, repoRoot);
	});

	// Try the preferred port first; fall back to a random one if it's taken.
	const boundPort = await new Promise<number>((resolve, reject) => {
		const tryBind = (port: number): void => {
			server.once("error", (err: NodeJS.ErrnoException) => {
				if (port !== 0 && (err.code === "EADDRINUSE" || err.code === "EACCES")) {
					tryBind(0); // fall back to random
				} else {
					reject(err);
				}
			});
			server.listen(port, "127.0.0.1", () => {
				server.removeAllListeners("error");
				const addr = server.address();
				if (!addr || typeof addr === "string") return reject(new Error("Bad address"));
				resolve(addr.port);
			});
		};
		tryBind(preferredPort);
	});

	// Start watching all worktrees and broadcast SSE refresh on any change.
	// We kick off an initial worktree list to seed the watcher; errors are
	// non-fatal (the server still works, just without live updates).
	let watcher: WatcherHandle | null = null;
	getWorktrees(repoRoot)
		.then(async (worktrees) => {
			const paths = worktrees.map((w) => w.path);
			watcher = await watchWorktrees(paths, () => broadcastRefresh());
		})
		.catch(() => { /* live updates unavailable */ });

	// 30-second fallback: push a refresh even if fs.watch missed something
	const pollInterval = setInterval(() => broadcastRefresh(), 30_000);

	return {
		port: boundPort,
		close: () => {
			if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
			clearInterval(pollInterval);
			watcher?.stop();
			for (const res of sseClients) { try { res.end(); } catch { /* ignore */ } }
			sseClients.clear();
			server.close();
		},
	};
}

// ── Request dispatch ──────────────────────────────────────────────────────────

async function handleRequest(
	req: IncomingMessage,
	res: ServerResponse,
	repoRoot: string,
): Promise<void> {
	const url = new URL(req.url ?? "/", "http://localhost");

	try {
		if (url.pathname === "/") {
			return sendHtml(res, buildHtml());
		}

		if (url.pathname === "/api/events") {
			return handleSse(req, res);
		}
		if (url.pathname === "/api/worktrees") {
			const data = await getWorktrees(repoRoot);
			return sendJson(res, data);
		}

		if (url.pathname === "/api/worktree-status") {
			const path = url.searchParams.get("path") ?? "";
			if (!path) return sendError(res, 400, "Missing ?path=");
			const data = await getWorktreeStatus(path);
			return sendJson(res, data);
		}

		if (url.pathname === "/api/diff") {
			const worktree = url.searchParams.get("worktree") ?? "";
			const file = url.searchParams.get("file") ?? "";
			const status = url.searchParams.get("status") ?? "";
			if (!worktree || !file) return sendError(res, 400, "Missing ?worktree= or ?file=");
			const data = await getDiff(worktree, file, status);
			return sendJson(res, data);
		}

		sendError(res, 404, "Not found");
	} catch (err) {
		sendError(res, 500, String(err));
	}
}

// ── Route handlers ────────────────────────────────────────────────────────────

interface WorktreeInfo {
	path: string;
	name: string;
	branch: string | null;
	head: string;
	isMain: boolean;
	isBare: boolean;
}

async function getWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
	const { stdout } = await execFileAsync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"]);

	const worktrees: WorktreeInfo[] = [];
	let current: Partial<WorktreeInfo> & { path?: string } = {};
	let first = true;

	for (const raw of stdout.split("\n")) {
		const line = raw.trim();

		if (line === "") {
			if (current.path) {
				worktrees.push(normaliseWorktree(current, first));
				first = false;
			}
			current = {};
			continue;
		}

		if (line.startsWith("worktree ")) {
			current.path = line.slice("worktree ".length);
		} else if (line.startsWith("HEAD ")) {
			current.head = line.slice("HEAD ".length);
		} else if (line.startsWith("branch ")) {
			// refs/heads/<name>
			current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
		} else if (line === "bare") {
			current.isBare = true;
		}
		// prunable / locked lines ignored
	}

	// Flush last entry if no trailing blank line
	if (current.path) {
		worktrees.push(normaliseWorktree(current, first));
	}

	return worktrees;
}

function normaliseWorktree(
	raw: Partial<WorktreeInfo & { path: string }>,
	isMain: boolean,
): WorktreeInfo {
	const path = raw.path ?? "";
	const name = path.split("/").filter(Boolean).pop() ?? path;
	return {
		path,
		name,
		branch: raw.branch ?? null,
		head: raw.head ?? "",
		isMain,
		isBare: raw.isBare ?? false,
	};
}

// ────────────────────────────────────────────────────────────────────────────

interface ChangedFile {
	path: string;
	/** Single-char git status: M A D R C U ? etc. */
	status: string;
}

async function getWorktreeStatus(worktreePath: string): Promise<ChangedFile[]> {
	const { stdout } = await execFileAsync("git", [
		"-C",
		worktreePath,
		"status",
		"--porcelain",
		"--untracked-files=all",  // expand untracked dirs into individual files
	]);

	const files: ChangedFile[] = [];

	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;

		// Porcelain v1: XY PATH  or  XY ORIG -> PATH
		const xy = line.slice(0, 2);
		let filePath = line.slice(3);

		// Rename format: "old -> new"
		if (filePath.includes(" -> ")) {
			filePath = filePath.split(" -> ")[1] ?? filePath;
		}

		// Derive a single representative status character
		const x = xy[0] ?? " "; // index status
		const y = xy[1] ?? " "; // worktree status

		let status: string;
		if (x === "?" && y === "?") {
			status = "?"; // untracked
		} else if (x === "D" || y === "D") {
			status = "D";
		} else if (x === "A") {
			status = "A";
		} else if (x === "R" || y === "R") {
			status = "R";
		} else if (x === "C" || y === "C") {
			status = "C";
		} else if (x === "U" || y === "U") {
			status = "U";
		} else if (x === "M" || y === "M") {
			status = "M";
		} else {
			status = x !== " " ? x : y;
		}

		files.push({ path: filePath.trim(), status });
	}

	return files;
}

// ────────────────────────────────────────────────────────────────────────────

interface DiffResult {
	lines: DiffLine[];
}

async function getDiff(
	worktreePath: string,
	filePath: string,
	status: string,
): Promise<DiffResult> {
	// Untracked file — read content directly
	if (status === "?") {
		const absPath = resolve(worktreePath, filePath);
		let content: string;
		try {
			content = await readFile(absPath, "utf8");
		} catch {
			return { lines: [] };
		}
		return { lines: buildUntrackedDiff(content) };
	}

	// Staged-only (index vs HEAD): show diff of index
	// For modified (both staged + unstaged), show combined: HEAD vs worktree
	let diffOutput: string;
	try {
		if (status === "A") {
			// Newly staged file: diff against empty tree
			const { stdout } = await execFileAsync("git", [
				"-C",
				worktreePath,
				"diff",
				"--cached",
				"--",
				filePath,
			]);
			diffOutput = stdout;
		} else if (status === "D") {
			// Deleted — show what was there vs nothing
			const { stdout } = await execFileAsync("git", [
				"-C",
				worktreePath,
				"diff",
				"HEAD",
				"--",
				filePath,
			]);
			diffOutput = stdout;
		} else {
			// Modified, renamed, etc — HEAD vs working tree
			const { stdout } = await execFileAsync("git", [
				"-C",
				worktreePath,
				"diff",
				"HEAD",
				"--",
				filePath,
			]);
			// Fall back to staged if worktree diff is empty
			if (stdout.trim()) {
				diffOutput = stdout;
			} else {
				const { stdout: staged } = await execFileAsync("git", [
					"-C",
					worktreePath,
					"diff",
					"--cached",
					"--",
					filePath,
				]);
				diffOutput = staged;
			}
		}
	} catch {
		return { lines: [] };
	}

	return { lines: parseUnifiedDiff(diffOutput) };
}

// ── SSE handler ────────────────────────────────────────────────────

function handleSse(req: IncomingMessage, res: ServerResponse): void {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		"Connection": "keep-alive",
		"Access-Control-Allow-Origin": "*",
	});
	res.write(":\n\n"); // initial comment to flush
	sseClients.add(res);
	req.on("close", () => sseClients.delete(res));
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function sendHtml(res: ServerResponse, html: string): void {
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	res.end(html);
}

function sendJson(res: ServerResponse, data: unknown): void {
	const body = JSON.stringify(data);
	res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
	res.end(body);
}

function sendError(res: ServerResponse, statusCode: number, message: string): void {
	res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
	res.end(message);
}
