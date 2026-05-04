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
 *         `pi.sendMessage({customType:"local-issue-watcher", ...}, {triggerTurn:true})`
 *         and persist `currentSnapshot`
 *     6. start a setInterval poll loop (disabled when paused)
 *
 *   session_shutdown:
 *     - clear the poll interval
 *
 *   /local-issue-watcher  (pause|resume|<no args>):
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
	buildMissingDbRootStatus,
	buildStartupAnnouncement,
	buildStartupChatMessage,
	formatStatusSummary,
} from "./format.js";
import {
	RUNSTATE_ENTRY_TYPE,
	STATE_ENTRY_TYPE,
	rehydrateFromSession,
	rehydrateRunStateFromSession,
	type SerialisedSnapshot,
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
const CUSTOM_MESSAGE_TYPE = "local-issue-watcher";

/**
 * Key used with `ctx.ui.setStatus(...)` to install / update / clear the
 * persistent status-row line for this watcher. Matches the slack-watcher
 * convention of one key per extension.
 */
const STATUS_KEY = "local-issue-watcher";

/** Apply the pi theme's accent color via `ctx.ui.theme.fg`. */
function colorize(
	theme: { fg: (color: string, text: string) => string } | undefined,
	text: string,
): string {
	return theme ? theme.fg("accent", text) : text;
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
		hasUI?: boolean;
		ui?: {
			notify?: (msg: string, level?: string) => void;
			setStatus?: (key: string, text: string | undefined) => void;
			theme?: { fg: (color: string, text: string) => string };
			hasUI?: boolean;
		};
	};
	dbRoot: string;
	/**
	 * When true, every `pi.sendMessage(...)` emitted from this function is
	 * deferred to the next `setImmediate` tick so it fires after the
	 * `session_start` handler returns and the interactive-mode UI has
	 * painted at least once. Without this, messages sent inline during
	 * `session_start` get folded into the very first LLM turn's prompt and
	 * never render as their own chat bubble (issue #0015).
	 *
	 * Default `false` so existing unit tests (which assert synchronous
	 * `pi.sendMessage` side effects) keep working. The default export at
	 * the bottom of this file passes `true`.
	 */
	deferMessages?: boolean;
}

export interface HandleSessionStartResult {
	/** Did polling start? `false` when dbRoot was missing. */
	started: boolean;
	/**
	 * Persisted run-state observed on entry. `paused === true` means the
	 * caller should honour the user's last explicit pause and NOT start
	 * the poll loop. `paused === false` (the default when nothing has
	 * been persisted yet) means it is safe to resume polling.
	 */
	paused: boolean;
	/**
	 * The on-disk snapshot captured during this call. Callers (the default
	 * export wrapper) should reuse this exact value as the polling baseline
	 * instead of re-scanning — re-scanning introduces a TOCTOU window where
	 * a file written between the two scans can be silently lost.
	 */
	snapshot: Snapshot;
}

/**
 * Pure-ish session_start worker. Exported so tests can drive it directly
 * with stubbed `pi` / `ctx` / `dbRoot` — no polling loop, no real filesystem
 * assumptions beyond `scanIssueFiles` reading the supplied path.
 */
export async function handleSessionStart(
	opts: HandleSessionStartOptions,
): Promise<HandleSessionStartResult> {
	const { pi, ctx, dbRoot, deferMessages } = opts;
	const hasUI = ctx.hasUI ?? ctx.ui?.hasUI ?? ctx.ui !== undefined;
	const notify = hasUI ? ctx.ui?.notify : undefined;
	const setStatus = hasUI ? ctx.ui?.setStatus : undefined;
	const theme = hasUI ? ctx.ui?.theme : undefined;
	/**
	 * Route every `sendMessage` through this helper so we can defer to
	 * `setImmediate` when called from the real extension (#0015). The inline
	 * path is preserved for existing synchronous unit tests.
	 */
	const emit: typeof pi.sendMessage = ((message, options) => {
		if (deferMessages) {
			setImmediate(() => pi.sendMessage(message, options));
		} else {
			pi.sendMessage(message, options);
		}
	}) as typeof pi.sendMessage;

	if (!existsSync(dbRoot)) {
		notify?.(
			`local-issue-watcher: dbRoot not found (${dbRoot}); not watching.`,
			"warning",
		);
		// Pin a persistent misconfiguration status line so the user can still
		// see the watcher is loaded and which path it tried to watch after the
		// transient warning toast disappears (#0014).
		setStatus?.(
			STATUS_KEY,
			colorize(theme, buildMissingDbRootStatus(dbRoot)),
		);
		return { started: false, paused: false, snapshot: {} };
	}

	const baseline = rehydrateFromSession(ctx);
	const currentSnapshot = scanIssueFiles(dbRoot, baseline?.snapshot);

	// Rehydrate the user's last explicit pause / resume preference. Absent
	// entry → default to **paused** (#0012). A brand-new pi session stays
	// quiet until the user opts in with `/local-issue-watcher resume`, matching
	// the intent that background chat messages require explicit consent.
	const runState = rehydrateRunStateFromSession(ctx);
	const paused = runState?.paused !== false;

	// Emit a single, informational startup announcement so the user can see
	// the watcher is running and which dbRoot is in effect — without having
	// to run `/local-issue-watcher status`. Uses `ctx.ui.setStatus` so it pins to
	// the extension-status row (below the main status line) and cannot
	// trigger an agent turn (see issue #0001).
	setStatus?.(
		STATUS_KEY,
		colorize(
			theme,
			buildStartupAnnouncement(
				paused ? "paused" : "active",
				dbRoot,
				POLL_INTERVAL_MS,
				currentSnapshot,
			),
		),
	);

	if (baseline === null) {
		// First session, or state stale — adopt current as the new baseline.
		pi.appendEntry(STATE_ENTRY_TYPE, {
			savedAt: Date.now(),
			snapshot: serialisableSnapshot(currentSnapshot),
		});
		// Fresh-session startup summary (#0011, #0013) — only when not paused.
		// A paused watcher stays silent; the pinned status line already shows
		// 'paused' and that is sufficient signal. Matches the no-diff path
		// below. `triggerTurn: true` so the LLM sees the tracker state at
		// session start (reversed from the original #0011 decision in #0013).
		if (!paused) {
			emit(
				{
					customType: CUSTOM_MESSAGE_TYPE,
					content: buildStartupChatMessage(dbRoot, currentSnapshot),
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		}
		return { started: true, paused, snapshot: currentSnapshot };
	}

	// While paused we do NOT diff or emit change messages — the user asked us
	// to stop watching, so don't resurface changes on resume/reload either.
	// The snapshot stays rehydrated so a later `/local-issue-watcher resume` picks
	// up from the last baseline rather than silently losing the intervening
	// window.
	if (paused) {
		return { started: true, paused, snapshot: currentSnapshot };
	}

	const changes = diffSnapshots(baseline.snapshot, currentSnapshot);
	if (changes.length > 0) {
		emit(
			{
				customType: CUSTOM_MESSAGE_TYPE,
				content: buildChatMessageContent(changes, new Date()),
				display: true,
				details: {
					changes,
					changedPaths: [...changedPaths(baseline.snapshot, currentSnapshot)],
				},
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		// Persist the new baseline so we don't replay these changes next
		// session.
		pi.appendEntry(STATE_ENTRY_TYPE, {
			savedAt: Date.now(),
			snapshot: serialisableSnapshot(currentSnapshot),
		});
	} else {
		// No diff to deliver — emit a short, chat-visible startup summary so the
		// LLM can see the watcher is active and knows which tracker it is
		// monitoring (#0011). Never fired when a diff message already landed
		// on this session_start (avoid two chat messages in rapid succession).
		// `triggerTurn: true` so the LLM is aware of the tracker state at
		// session start rather than waiting for the next user input
		// (reversed from the original #0011 decision in #0013).
		emit(
			{
				customType: CUSTOM_MESSAGE_TYPE,
				content: buildStartupChatMessage(dbRoot, currentSnapshot),
				display: true,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	}

	return { started: true, paused, snapshot: currentSnapshot };
}

/**
 * Convert a `Snapshot` (with `bigint` mtimeNs) into a form safe to pass
 * through `pi.appendEntry`, which round-trips through JSON. We stringify
 * every bigint; `rehydrateFromSession` converts it back.
 */
function serialisableSnapshot(snap: Snapshot): SerialisedSnapshot {
	const out: SerialisedSnapshot = {};
	for (const [path, info] of Object.entries(snap)) {
		out[path] = { ...info, mtimeNs: info.mtimeNs.toString() };
	}
	return out;
}

/**
 * Append a run-state entry (paused / running) to the session log.
 * Swallows any failure from `appendEntry` — persistence is a nice-to-have,
 * not worth breaking the pause/resume command over.
 */
function persistRunState(
	pi: Pick<ExtensionAPI, "appendEntry">,
	paused: boolean,
): void {
	try {
		pi.appendEntry(RUNSTATE_ENTRY_TYPE, {
			savedAt: Date.now(),
			paused,
		});
	} catch {
		/* noop — see doc comment */
	}
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
				notify?: (m: string, l?: string) => void;
				setStatus?: (key: string, text: string | undefined) => void;
				theme?: { fg: (color: string, text: string) => string };
				hasUI?: boolean;
		  }
		| null;
}

function makeRuntime(dbRoot: string, pi: Runtime["pi"]): Runtime {
	return {
		dbRoot,
		paused: false,
		snapshot: {},
		timer: null,
		pi,
		ui: null,
	};
}

/**
 * Re-pin the extension status line with the current state + counts.
 * Safe to call with no UI — the optional-chain calls simply do nothing.
 */
function refreshStatusLine(
	ui: Runtime["ui"],
	rt: Pick<Runtime, "dbRoot">,
	state: string,
	snapshot: Snapshot,
): void {
	ui?.setStatus?.(
		STATUS_KEY,
		colorize(
			ui?.theme,
			buildStartupAnnouncement(state, rt.dbRoot, POLL_INTERVAL_MS, snapshot),
		),
	);
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
	// Carry forward the previous snapshot so transient read/parse failures
	// (writer mid-flush) don't produce spurious `removed -> new` diffs (#0003).
	const next = scanIssueFiles(rt.dbRoot, rt.snapshot);
	const changes = diffSnapshots(rt.snapshot, next);
	if (changes.length > 0) {
		rt.pi.sendMessage(
			{
				customType: CUSTOM_MESSAGE_TYPE,
				content: buildChatMessageContent(changes, new Date()),
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
	// Re-pin the status line on every poll (even when no diff fired) so the
	// counts segment reflects any fresh rescan. The `last update` phrase the
	// older status line carried was removed in #0016.
	refreshStatusLine(rt.ui, rt, "active", next);
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

export default function issueWatcher(pi: ExtensionAPI): void {
	const dbRoot = resolveDbRoot(process.env, homedir());
	const rt = makeRuntime(dbRoot, pi);

	pi.on("session_start", async (_event, ctx) => {
		const anyCtx = ctx as unknown as {
			hasUI?: boolean;
			ui?: Runtime["ui"];
		};
		const hasUI = anyCtx.hasUI ?? anyCtx.ui?.hasUI ?? anyCtx.ui !== undefined;
		rt.ui = hasUI ? (anyCtx.ui as Runtime["ui"]) ?? null : null;
		const res = await handleSessionStart({
			pi,
			ctx: ctx as unknown as HandleSessionStartOptions["ctx"],
			dbRoot,
			// Defer every pi.sendMessage(...) emitted during session_start to
			// the next setImmediate tick so the interactive UI renders the
			// chat bubble before the LLM turn absorbs the content (#0015).
			deferMessages: true,
		});
		if (!res.started) return;
		// Reuse the exact snapshot handleSessionStart already scanned. A
		// second scanIssueFiles() here would open a TOCTOU window where
		// a file written between the two scans is silently lost (#0001).
		rt.snapshot = res.snapshot;
		rt.paused = res.paused;
		// If the user explicitly paused in a prior session (or earlier in this
		// one, before a reload) we honour that and stay quiet until they run
		// `/local-issue-watcher resume`. Otherwise start the poll loop.
		if (!rt.paused) startPolling(rt);
	});

	pi.on("session_shutdown", async () => {
		stopPolling(rt);
		try {
			rt.ui?.setStatus?.(STATUS_KEY, undefined);
		} catch {
			/* noop — UI may already be torn down */
		}
		rt.ui = null;
	});

	pi.registerCommand("local-issue-watcher", {
		description: "Control the local-skill-issues-tracker watcher (pause/resume/status)",
		handler: async (args, ctx) => {
			const anyCtx = ctx as unknown as {
				hasUI?: boolean;
				ui?: {
					notify?: (m: string, l?: string) => void;
					setStatus?: (key: string, text: string | undefined) => void;
					theme?: { fg: (color: string, text: string) => string };
					hasUI?: boolean;
				};
			};
			const hasUI = anyCtx.hasUI ?? anyCtx.ui?.hasUI ?? anyCtx.ui !== undefined;
			const ui = hasUI ? anyCtx.ui : undefined;
			const sub = args.trim().toLowerCase();
			switch (sub) {
				case "pause": {
					rt.paused = true;
					stopPolling(rt);
					persistRunState(pi, true);
					// No disk scan: paused status line renders no per-status counts
					// (#0010), so an empty snapshot is all buildStartupAnnouncement
					// needs. Saves a readdir under dbRoot that the user wouldn't see.
					refreshStatusLine(ui ?? null, rt, "paused", {});
					ui?.notify?.(`local-issue-watcher: paused (dbRoot=${rt.dbRoot})`, "info");
					return;
				}
				case "resume": {
					rt.paused = false;
					persistRunState(pi, false);
					const resumedSnap = existsSync(rt.dbRoot)
						? scanIssueFiles(rt.dbRoot, rt.snapshot)
						: {};
					if (existsSync(rt.dbRoot)) {
						rt.snapshot = resumedSnap;
						startPolling(rt);
					}
					refreshStatusLine(ui ?? null, rt, "resumed", resumedSnap);
					ui?.notify?.(`local-issue-watcher: resumed (dbRoot=${rt.dbRoot})`, "info");
					return;
				}
				case "":
				case "status": {
					const snap = existsSync(rt.dbRoot) ? scanIssueFiles(rt.dbRoot) : {};
					const summary = formatStatusSummary(snap);
					const state = rt.paused ? "paused" : "running";
					ui?.notify?.(
						`local-issue-watcher: ${state} | dbRoot=${rt.dbRoot} | ${summary}`,
						"info",
					);
					return;
				}
				default:
					ui?.notify?.(
						`local-issue-watcher: unknown subcommand '${sub}'. Use: pause | resume | status`,
						"warning",
					);
			}
		},
	});
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export { STATE_ENTRY_TYPE, RUNSTATE_ENTRY_TYPE } from "./persistence.js";
export { scanIssueFiles } from "./scanner.js";
export { diffSnapshots, changedPaths, formatChange } from "./diff.js";
export { buildChatMessageContent, buildMissingDbRootStatus, buildStartupAnnouncement, buildStartupChatMessage, formatStatusSummary } from "./format.js";
export { resolveDbRoot };
