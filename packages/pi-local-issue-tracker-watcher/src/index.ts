/**
 * pi-local-issue-tracker-watcher — pi extension.
 *
 * Watches a single on-disk database produced by the upstream
 * `litee-claude-code-plugins/local-skill-issues-tracker` skill and injects
 * summarised change notifications into pi chat as custom-typed messages.
 *
 * Control flow
 * ------------
 *   session_start:
 *     1. resolve dbRoot (env LOCAL_ISSUE_TRACKER_DB_ROOT or hard-coded default)
 *     2. if dbRoot missing → `ctx.ui.notify(...)` and bail out
 *     3. scan disk -> `currentSnapshot`
 *     4. rehydrate prior baseline from session entries (24h TTL)
 *     5a. if no prior baseline → persist `currentSnapshot` and start polling
 *     5b. if baseline present & fresh → `diffSnapshots`, if changes emit one
 *         `pi.sendMessage({customType:"issue-watcher", ...}, {triggerTurn:true})`
 *         and persist `currentSnapshot`
 *     6. start a setInterval poll loop (disabled when paused)
 *
 *   session_shutdown:
 *     - clear the poll interval
 *
 *   /issue-watcher  (pause|resume|<no args>):
 *     - toggle pause state or print a status summary via `ctx.ui.notify`
 *
 * Scope: one dbRoot per process. No tool is registered — this extension is
 * meant to be enabled per-project (via the workspace `pi.extensions`
 * manifest), not through the global pi config.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { changedPaths, diffSnapshots } from "./diff.js";
import {
	buildChatMessageContent,
	buildStartupAnnouncement,
	formatStatusSummary,
} from "./format.js";
import {
	STATE_ENTRY_TYPE,
	rehydrateFromSession,
	type SessionLike,
} from "./persistence.js";
import { scanIssueFiles } from "./scanner.js";
import type { Snapshot } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Directory under which the upstream `skill_issues_cli.py` writes issue
 * files by default when the user picks the plugin-data storage layout.
 */
const DEFAULT_DB_ROOT_REL = join(
	".claude",
	"plugin-data",
	"local-skill-issues-tracker",
	"use-local-skills-issue-tracker",
	"db",
);

/** Poll interval — 60 s. Long enough not to churn, short enough to feel responsive. */
export const POLL_INTERVAL_MS = 60_000;

/** customType used on every chat message this extension injects. */
const CUSTOM_MESSAGE_TYPE = "issue-watcher";

/**
 * Key used with `ctx.ui.setStatus(...)` to install / update / clear the
 * persistent status-row line for this watcher. Matches the slack-watcher
 * convention of one key per extension.
 */
const STATUS_KEY = "issue-watcher";

/** Apply SGR cyan to a status string so it's visually distinct in the footer. */
function colorize(text: string): string {
	return `\x1b[36m${text}\x1b[39m`;
}

function resolveDbRoot(env: NodeJS.ProcessEnv, home: string): string {
	const override = env["LOCAL_ISSUE_TRACKER_DB_ROOT"];
	if (override !== undefined && override !== "") return override;
	return join(home, DEFAULT_DB_ROOT_REL);
}

// ---------------------------------------------------------------------------
// Session-start handler — extracted so it can be unit-tested with stubs
// ---------------------------------------------------------------------------

export interface HandleSessionStartOptions {
	pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry">;
	ctx: SessionLike & {
		ui: {
			notify: (msg: string, level?: string) => void;
			setStatus: (key: string, text: string | undefined) => void;
		};
	};
	dbRoot: string;
}

export interface HandleSessionStartResult {
	/** Did polling start? `false` when dbRoot was missing. */
	started: boolean;
}

/**
 * Pure-ish session_start worker. Exported so tests can drive it directly
 * with stubbed `pi` / `ctx` / `dbRoot` — no polling loop, no real filesystem
 * assumptions beyond `scanIssueFiles` reading the supplied path.
 */
export async function handleSessionStart(
	opts: HandleSessionStartOptions,
): Promise<HandleSessionStartResult> {
	const { pi, ctx, dbRoot } = opts;

	if (!existsSync(dbRoot)) {
		ctx.ui.notify(
			`issue-watcher: dbRoot not found (${dbRoot}); not watching.`,
			"warning",
		);
		return { started: false };
	}

	const currentSnapshot = scanIssueFiles(dbRoot);
	const baseline = rehydrateFromSession(ctx);

	// Emit a single, informational startup announcement so the user can see
	// the watcher is running and which dbRoot is in effect — without having
	// to run `/issue-watcher status`. Uses `ctx.ui.setStatus` so it pins to
	// the extension-status row (below the main status line) and cannot
	// trigger an agent turn (see issue #0001).
	ctx.ui.setStatus(
		STATUS_KEY,
		colorize(buildStartupAnnouncement("active", dbRoot, POLL_INTERVAL_MS, currentSnapshot)),
	);

	if (baseline === null) {
		// First session, or state stale — adopt current as the new baseline.
		pi.appendEntry(STATE_ENTRY_TYPE, {
			savedAt: Date.now(),
			snapshot: serialisableSnapshot(currentSnapshot),
		});
		return { started: true };
	}

	const changes = diffSnapshots(baseline.snapshot, currentSnapshot);
	if (changes.length > 0) {
		pi.sendMessage(
			{
				customType: CUSTOM_MESSAGE_TYPE,
				content: buildChatMessageContent(changes),
				display: true,
				details: {
					changes,
					changedPaths: [...changedPaths(baseline.snapshot, currentSnapshot)],
				},
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		// Persist the new baseline so we don't replay these changes next session.
		pi.appendEntry(STATE_ENTRY_TYPE, {
			savedAt: Date.now(),
			snapshot: serialisableSnapshot(currentSnapshot),
		});
	}

	return { started: true };
}

/**
 * Convert a `Snapshot` (with `bigint` mtimeNs) into a form safe to pass
 * through `pi.appendEntry`, which round-trips through JSON. We stringify
 * every bigint; `rehydrateFromSession` converts it back.
 */
function serialisableSnapshot(snap: Snapshot): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [path, info] of Object.entries(snap)) {
		out[path] = { ...info, mtimeNs: info.mtimeNs.toString() };
	}
	return out;
}

// ---------------------------------------------------------------------------
// Runtime (polling loop + paused flag)
// ---------------------------------------------------------------------------

interface Runtime {
	dbRoot: string;
	paused: boolean;
	/** Most recent snapshot used as the diff baseline across polls. */
	snapshot: Snapshot;
	timer: ReturnType<typeof setInterval> | null;
	pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry">;
	/** Set once `session_start` fires; `null` before that. */
	ui:
		| {
				notify: (m: string, l?: string) => void;
				setStatus: (key: string, text: string | undefined) => void;
		  }
		| null;
}

function makeRuntime(dbRoot: string, pi: Runtime["pi"]): Runtime {
	return { dbRoot, paused: false, snapshot: {}, timer: null, pi, ui: null };
}

function startPolling(rt: Runtime): void {
	if (rt.timer !== null) return;
	rt.timer = setInterval(() => {
		void pollOnce(rt);
	}, POLL_INTERVAL_MS);
}

function stopPolling(rt: Runtime): void {
	if (rt.timer !== null) {
		clearInterval(rt.timer);
		rt.timer = null;
	}
}

async function pollOnce(rt: Runtime): Promise<void> {
	if (rt.paused) return;
	if (!existsSync(rt.dbRoot)) return;
	const next = scanIssueFiles(rt.dbRoot);
	const changes = diffSnapshots(rt.snapshot, next);
	if (changes.length > 0) {
		rt.pi.sendMessage(
			{
				customType: CUSTOM_MESSAGE_TYPE,
				content: buildChatMessageContent(changes),
				display: true,
				details: {
					changes,
					changedPaths: [...changedPaths(rt.snapshot, next)],
				},
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		rt.pi.appendEntry(STATE_ENTRY_TYPE, {
			savedAt: Date.now(),
			snapshot: serialisableSnapshot(next),
		});
	}
	rt.snapshot = next;
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

export default function issueWatcher(pi: ExtensionAPI): void {
	const dbRoot = resolveDbRoot(process.env, homedir());
	const rt = makeRuntime(dbRoot, pi);

	pi.on("session_start", async (_event, ctx) => {
		rt.ui = ctx.ui as Runtime["ui"];
		const res = await handleSessionStart({
			pi,
			ctx: ctx as unknown as HandleSessionStartOptions["ctx"],
			dbRoot,
		});
		if (res.started && !rt.paused) {
			// Seed runtime snapshot so the first poll doesn't re-emit the
			// startup diff we just delivered in handleSessionStart.
			rt.snapshot = scanIssueFiles(dbRoot);
			startPolling(rt);
		}
	});

	pi.on("session_shutdown", async () => {
		stopPolling(rt);
		try {
			rt.ui?.setStatus(STATUS_KEY, undefined);
		} catch {
			/* noop — UI may already be torn down */
		}
		rt.ui = null;
	});

	pi.registerCommand("issue-watcher", {
		description: "Control the local-skill-issues-tracker watcher (pause/resume/status)",
		handler: async (args, ctx) => {
			const ui = (ctx as {
				ui: {
					notify: (m: string, l?: string) => void;
					setStatus: (key: string, text: string | undefined) => void;
				};
			}).ui;
			const sub = args.trim().toLowerCase();
			switch (sub) {
				case "pause": {
					rt.paused = true;
					stopPolling(rt);
					const snap = existsSync(rt.dbRoot) ? scanIssueFiles(rt.dbRoot) : {};
					ui.setStatus(
						STATUS_KEY,
						colorize(
							buildStartupAnnouncement(
								"paused",
								rt.dbRoot,
								POLL_INTERVAL_MS,
								snap,
							),
						),
					);
					ui.notify(`issue-watcher: paused (dbRoot=${rt.dbRoot})`, "info");
					return;
				}
				case "resume": {
					rt.paused = false;
					const resumedSnap = existsSync(rt.dbRoot) ? scanIssueFiles(rt.dbRoot) : {};
					if (existsSync(rt.dbRoot)) {
						rt.snapshot = resumedSnap;
						startPolling(rt);
					}
					ui.setStatus(
						STATUS_KEY,
						colorize(
							buildStartupAnnouncement(
								"resumed",
								rt.dbRoot,
								POLL_INTERVAL_MS,
								resumedSnap,
							),
						),
					);
					ui.notify(`issue-watcher: resumed (dbRoot=${rt.dbRoot})`, "info");
					return;
				}
				case "":
				case "status": {
					const snap = existsSync(rt.dbRoot) ? scanIssueFiles(rt.dbRoot) : {};
					const summary = formatStatusSummary(snap);
					const state = rt.paused ? "paused" : "running";
					ui.notify(
						`issue-watcher: ${state} | dbRoot=${rt.dbRoot} | ${summary}`,
						"info",
					);
					return;
				}
				default:
					ui.notify(
						`issue-watcher: unknown subcommand '${sub}'. Use: pause | resume | status`,
						"warning",
					);
			}
		},
	});
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export { STATE_ENTRY_TYPE } from "./persistence.js";
export { scanIssueFiles } from "./scanner.js";
export { diffSnapshots, changedPaths, formatChange } from "./diff.js";
export { buildChatMessageContent, buildStartupAnnouncement, formatStatusSummary } from "./format.js";
export { resolveDbRoot };
