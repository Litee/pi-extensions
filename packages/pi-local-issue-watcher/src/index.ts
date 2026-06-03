/**
 * pi-local-issue-watcher — pi extension.
 *
 * Watches a single on-disk database produced by the upstream
 * `litee-claude-code-plugins/local-skill-issues-tracker` skill and injects
 * summarised change notifications into pi chat as custom-typed messages.
 *
 * Control flow
 * ------------
 *   session_start:
 *     1. resolve dbRoot (env LOCAL_ISSUE_TRACKER_DB_ROOT or hard-coded default)
 *     2. if dbRoot missing → pin status row + emit chat message with remediation steps
 *     3. scan disk -> `currentSnapshot`
 *     4. rehydrate prior baseline from session entries (24h TTL)
 *     5a. if no prior baseline → persist `currentSnapshot` and start polling
 *     5b. if baseline present & fresh → `diffSnapshots`, if changes emit one
 *         `pi.sendMessage({customType:"pi-local-issue-watcher", ...}, {triggerTurn:true})`
 *         and persist `currentSnapshot`
 *     6. start a setInterval poll loop (disabled when paused)
 *
 *   session_shutdown:
 *     - clear the poll interval
 *
 *   /local-issue-watcher  (any args ignored):
 *     - opens the interactive menu (browse / refresh / pause / close)
 *
 * Scope: one dbRoot per process. No tool is registered — this extension is
 * meant to be enabled per-project (via the workspace `pi.extensions`
 * manifest), not through the global pi config.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { PollScheduler } from "pi-watcher-core/poll-scheduler";

import { changedPaths, diffSnapshots } from "./diff.js";
import {
	buildChatMessageContent,
	buildMissingDbRootChatMessage,
	buildMissingDbRootStatus,
	buildParseFailureToast,
	buildStartupAnnouncement,
	buildStatusDetailMessage,
	type WatcherState,
} from "./format.js";
import type { InfoPicker } from "./infoHandler.js";
import {
	rehydrateFromSession,
	persistSnapshot,
	type SessionLike,
} from "./persistence.js";
import {
	STATUS_KEY,
	runLocalIssueWatcherCommand,
} from "./command.js";
import { scanIssueFiles } from "./scanner.js";
import type { Snapshot } from "./types.js";

// ---------------------------------------------------------------------------
// Test-only hook: swap the real `makeInfoTuiPicker` for a fake picker so the
// `/local-issue-watcher browse` wiring can be exercised without spinning up a
// live pi-tui runtime. Mirrors the `__setFetchNamesForTests` pattern from
// pi-update-cmux-status. Production always sees `null` and falls back to
// `makeInfoTuiPicker(ctx)`.
// ---------------------------------------------------------------------------
let infoPickerOverride: InfoPicker | null = null;

/** Test-only. Pass `null` to restore the real TUI picker. */
export function __setInfoPickerForTests(fn: InfoPicker | null): void {
	infoPickerOverride = fn;
}

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

/**
 * customType used on every chat message this extension injects.
 *
 * Prefixed with the full package name per tracker issue #0021 so
 * messages in the shared pi chat-message namespace are unambiguously
 * attributable to their owning package. Pre-#0021 builds emitted the
 * bare literal `"local-issue-watcher"`. Write-only constant: this
 * extension never reads or matches on the customType, so no read-
 * side back-compat shim is needed. Downstream consumers (renderers,
 * debug tooling) that match on the literal must update their own
 * matchers; past messages in existing session logs keep their old
 * customType — that is fine, they are immutable history.
 */
const CUSTOM_MESSAGE_TYPE = "pi-local-issue-watcher";


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
	/**
	 * Shared one-shot parse-failure toast state (#0029). Mutated by this
	 * function and by `pollOnce` / command handlers so the contract
	 * "one toast per session, period" holds across all scan sites.
	 * Default `{ hasToasted: false }` when omitted — only the default
	 * export needs to thread a shared instance; tests can omit it.
	 */
	parseFailureToastState?: { hasToasted: boolean };
}

export interface HandleSessionStartResult {
	/** Did polling start? `false` when dbRoot was missing. */
	started: boolean;
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
export function handleSessionStart(
	opts: HandleSessionStartOptions,
): Promise<HandleSessionStartResult> {
	const { pi, ctx, dbRoot, deferMessages, parseFailureToastState } = opts;
	const hasUI = ctx.hasUI ?? ctx.ui?.hasUI ?? ctx.ui !== undefined;
	const notify = hasUI ? ctx.ui?.notify : undefined;
	const setStatus = hasUI ? ctx.ui?.setStatus : undefined;
	const theme = hasUI ? ctx.ui?.theme : undefined;
	/**
	 * One-shot parse-failure toast helper (#0029). Returns a scanner-
	 * compatible `onError` callback that counts failures into a local
	 * closure, plus a `flush()` to be called after the scan. `flush()`
	 * fires at most ONE `ui.notify(...)` per session across all
	 * `makeParseFailureHandler()` call sites, because the `hasToasted`
	 * bit lives on the shared mutable state object passed in.
	 *
	 * UI-absent sessions (`hasUI === false`) are explicitly designed NOT
	 * to flip `hasToasted`: a later UI-enabled session must still be
	 * allowed to warn about the same failures. See test coverage for
	 * #0029 UI-absence case.
	 */
	function makeParseFailureHandler() {
		let count = 0;
		return {
			onError: (_path: string, _err: unknown) => {
				count += 1;
			},
			flush: () => {
				if (count === 0) return;
				if (!hasUI || notify === undefined) return;
				if (parseFailureToastState?.hasToasted === true) return;
				notify(buildParseFailureToast(count), "warning");
				if (parseFailureToastState !== undefined) {
					parseFailureToastState.hasToasted = true;
				}
			},
		};
	}
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
	});

	if (!existsSync(dbRoot)) {
		notify?.(
			`local-issue-watcher: dbRoot not found (${dbRoot}); not watching.`,
			"warning",
		);
		// Pin a terse misconfiguration status line so the watcher stays
		// visible after the transient warning toast disappears (#0014).
		setStatus?.(
			STATUS_KEY,
			colorize(theme, buildMissingDbRootStatus(dbRoot)),
		);
		// Emit a chat message with actionable remediation steps so the LLM
		// can guide the user without requiring a separate /status invocation.
		emit(
			{
				customType: CUSTOM_MESSAGE_TYPE,
				content: buildMissingDbRootChatMessage(dbRoot),
				display: true,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		return Promise.resolve({ started: false, snapshot: {} });
	}

	const baseline = rehydrateFromSession(ctx);
	const scanHandler = makeParseFailureHandler();
	const currentSnapshot = scanIssueFiles(dbRoot, baseline?.snapshot, scanHandler.onError);
	scanHandler.flush();

	// Pin the active status row. Uses `ctx.ui.setStatus` so it cannot trigger
	// an agent turn. Format: `local-issue-watcher: active (N open)`.
	// Only reached on the non-paused path, so the state is always 'active'.
	setStatus?.(
		STATUS_KEY,
		colorize(
			theme,
			buildStartupAnnouncement(
				"active",
				dbRoot,
				POLL_INTERVAL_MS,
				currentSnapshot,
			),
		),
	);

	if (baseline === null) {
		// First session, or state stale — adopt current as the new baseline.
		persistSnapshot(pi, currentSnapshot);
		// Startup status summary (#0011, #0013, #0002). Injected as a
		// non-display entry so the LLM sees the tracker state but does not
		// activate a new turn. Uses the same compact format as /status.
		emit(
			{
				customType: CUSTOM_MESSAGE_TYPE,
				content: buildStatusDetailMessage(dbRoot, currentSnapshot, POLL_INTERVAL_MS),
				display: false,
			},
			{ deliverAs: "followUp", triggerTurn: false },
		);
		return Promise.resolve({ started: true, snapshot: currentSnapshot });
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
		persistSnapshot(pi, currentSnapshot);
	} else {
		// No diff to deliver — emit a short, chat-visible startup summary so the
		// LLM can see the watcher is active and knows which tracker it is
		// monitoring (#0011). Never fired when a diff message already landed
		// on this session_start (avoid two chat messages in rapid succession).
		// No diff — emit the compact status block so the LLM sees watcher
		// state without activating a new turn (#0002).
		emit(
			{
				customType: CUSTOM_MESSAGE_TYPE,
				content: buildStatusDetailMessage(dbRoot, currentSnapshot, POLL_INTERVAL_MS),
				display: false,
			},
			{ deliverAs: "followUp", triggerTurn: false },
		);
	}

	return Promise.resolve({ started: true, snapshot: currentSnapshot });
}

// ---------------------------------------------------------------------------
// Runtime (polling loop)
// ---------------------------------------------------------------------------

export interface Runtime {
	dbRoot: string;
	/** Most recent snapshot used as the diff baseline across polls. */
	snapshot: Snapshot;
	/**
	 * Back-off-aware poll scheduler (pi-watcher-core). Configured with
	 * baseMs === maxMs === idleMaxMs so the effective interval never
	 * changes — this watcher has a flat 60s cadence. PollScheduler is
	 * still used (over raw setInterval) for its re-entry guard, which
	 * prevents a slow filesystem scan from being re-entered by the timer.
	 */
	scheduler: PollScheduler;
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
	/**
	 * One-shot parse-failure toast state (#0029). Shared between
	 * `handleSessionStart`, `pollOnce`, and the status command so exactly
	 * one toast fires per session regardless of which scan site first
	 * sees a bad file.
	 */
	parseFailureToastState: { hasToasted: boolean };
}

function makeRuntime(dbRoot: string, pi: Runtime["pi"]): Runtime {
	return {
		dbRoot,
		snapshot: {},
		scheduler: new PollScheduler({
			baseMs: POLL_INTERVAL_MS,
			maxMs: POLL_INTERVAL_MS,
			idleMaxMs: POLL_INTERVAL_MS,
		}),
		pi,
		ui: null,
		parseFailureToastState: { hasToasted: false },
	};
}

/**
 * Re-pin the extension status line with the current state + counts.
 * Safe to call with no UI — the optional-chain calls simply do nothing.
 */
export function refreshStatusLine(
	ui: Runtime["ui"],
	rt: Pick<Runtime, "dbRoot">,
	state: WatcherState,
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

export function startPolling(rt: Runtime): void {
	rt.scheduler.start(() => {
		pollOnce(rt);
		return Promise.resolve();
	});
}

export function stopPolling(rt: Runtime): void {
	rt.scheduler.stop();
}

/**
 * Force a single poll cycle. Called by the Refresh menu item so the user can get an
 * immediate diff. Callers MUST check that
 * rt.dbRoot exists before calling (a missing dbRoot is a no-op inside, but
 * the caller needs to show the right warning message).
 */
export function forceRefresh(rt: Runtime): void {
	if (!existsSync(rt.dbRoot)) return;
	let failureCount = 0;
	const next = scanIssueFiles(rt.dbRoot, rt.snapshot, () => {
		failureCount += 1;
	});
	if (
		failureCount > 0 &&
		rt.ui?.hasUI !== false &&
		rt.ui?.notify !== undefined &&
		!rt.parseFailureToastState.hasToasted
	) {
		rt.ui.notify(buildParseFailureToast(failureCount), "warning");
		rt.parseFailureToastState.hasToasted = true;
	}
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
		persistSnapshot(rt.pi, next);
	}
	rt.snapshot = next;
	refreshStatusLine(rt.ui, rt, "active", next);
}

function pollOnce(rt: Runtime): void {
	forceRefresh(rt);
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
			// Share the runtime's one-shot toast state so session_start,
			// pollOnce, and the command handlers all agree on whether we've
			// already warned about bad files this session (#0029).
			parseFailureToastState: rt.parseFailureToastState,
		});
		if (!res.started) return;
		// Reuse the exact snapshot handleSessionStart already scanned. A
		// second scanIssueFiles() here would open a TOCTOU window where
		// a file written between the two scans is silently lost (#0001).
		rt.snapshot = res.snapshot;
		startPolling(rt);
	});

	pi.on("session_shutdown", () => {
		stopPolling(rt);
		try {
			rt.ui?.setStatus?.(STATUS_KEY, undefined);
		} catch {
			/* noop — UI may already be torn down */
		}
		rt.ui = null;
	});

	// #0028: renderer for session-start, event updates, and /local-issue-watcher
	// status messages. Wraps content in a Box with the customMessageBg background
	// so messages are visually distinct from plain text. The first line is the
	// extension name, styled with the customMessageLabel colour + bold, so the
	// user can immediately see which watcher produced the output.
	pi.registerMessageRenderer(CUSTOM_MESSAGE_TYPE, (message, _options, theme) => {
		// `CustomMessage.content` is typed as `string | (TextContent | ImageContent)[]`;
		// this extension only ever sends string content via `pi.sendMessage`, but
		// narrow defensively so a stray array form can't crash the renderer.
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
		const label = theme.bold(theme.fg("customMessageLabel", "pi-local-issue-watcher"));
		const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${label}\n\n${text}`, 0, 0));
		return box;
	});

	pi.registerCommand("local-issue-watcher", {
		description: "Open the local-issue-watcher menu",
		handler: async (args, ctx) => {
			return runLocalIssueWatcherCommand(args, ctx, rt, pi, {
				startPolling,
				stopPolling,
				forceRefresh,
				refreshStatusLine,
				getInfoPickerOverride: () => infoPickerOverride,
			});
		},
	});
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

export { STATE_ENTRY_TYPE } from "./persistence.js";
export { scanIssueFiles } from "./scanner.js";
export { diffSnapshots, changedPaths, formatChange } from "./diff.js";
export { buildChatMessageContent, buildMissingDbRootStatus, buildStartupAnnouncement, buildStartupChatMessage, buildStatusDetailMessage, formatStatusSummary, type WatcherState } from "./format.js";
export { resolveDbRoot };
