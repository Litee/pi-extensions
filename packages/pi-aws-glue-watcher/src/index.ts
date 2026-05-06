/**
 * pi-aws-glue-watcher — pi extension.
 *
 * Polls AWS Glue job and workflow runs in-process and injects state-change
 * notifications into pi chat as custom-typed messages.
 *
 * ## Activation model
 *
 * The `glue_watcher` tool is intentionally NOT registered at load time.
 * It only appears in the LLM's tool list after the user opts in via
 * `/glue-watcher enable`, keeping the default tool list clean for sessions
 * that never touch Glue.
 *
 * Control flow:
 *
 *   session_start:
 *     1. Rehydrate state from the session log.
 *     2. If `enabled=true`: register the tool (once), add it to active
 *        tools, seed any missing baselines, start polling, pin status line,
 *        emit startup chat message.
 *     3. If `enabled=false` (default): do nothing — no tool, no status.
 *
 *   session_shutdown:
 *     - Stop the poll timer; clear the status line.
 *
 *   /glue-watcher enable:
 *     - Register the tool (idempotent), add to active tools, show status.
 *
 *   /glue-watcher disable:
 *     - Remove from active tools, hide status, stop polling.
 *
 *   /glue-watcher [status]:
 *     - Show a toast with current watcher state. (Default with no args.)
 *
 *   glue_watcher tool (LLM-callable when enabled):
 *     - add / remove / list / pause / resume / status.
 */

import { randomBytes } from "node:crypto";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import {
	createGlueClient,
	type GlueClient,
} from "./cli-client.js";
import {
	buildChangeChatMessage,
	buildStartupChatMessage,
	buildStatusLine,
} from "./format.js";
import {
	rehydrateStateFromSession,
	writeState,
	type SessionLike,
} from "./persistence.js";
import {
	detectJobChanges,
	detectWorkflowChanges,
	snapshotJobRun,
	snapshotWorkflowRun,
} from "./poller.js";
import type { GlueEvent, GlueWatch, WatchMap } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default poll interval (ms). Minimum / base rhythm. */
export const POLL_INTERVAL_MS = 120_000;

/**
 * Idle back-off ceiling (ms). When consecutive polls observe no updates the
 * interval doubles from {@link POLL_INTERVAL_MS} up to this cap (15 min).
 * Any detected update snaps the interval back to {@link POLL_INTERVAL_MS}.
 */
export const POLL_INTERVAL_MAX_MS = 900_000;

/**
 * Number of consecutive per-watch poll failures before a warning chat
 * message is injected. The same threshold triggers the ⚠ indicator in the
 * status line. The counter resets (and a recovery message fires) on the
 * first successful poll after the streak.
 */
export const POLL_ERROR_THRESHOLD = 5;

/** customType on every chat message this extension injects. */
export const CUSTOM_MESSAGE_TYPE = "glue-watcher";

/** Status-line key under which we pin our footer row. */
export const STATUS_KEY = "glue-watcher";

// ---------------------------------------------------------------------------
// Module-level flag — shared across all sessions in a single process.
// Prevents calling pi.registerTool more than once for the same tool name.
// ---------------------------------------------------------------------------

let toolRegistered = false;

// ---------------------------------------------------------------------------
// Tool parameters (TypeBox)
// ---------------------------------------------------------------------------

const GlueWatcherParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("add"),
			Type.Literal("remove"),
			Type.Literal("list"),
			Type.Literal("pause"),
			Type.Literal("resume"),
			Type.Literal("status"),
		],
		{
			description:
				"add: start watching a job or workflow run (seeds baseline immediately). " +
				"remove: stop watching a run by its watchId. " +
				"list: show the current watch list with state. " +
				"pause: suspend polling (persisted). " +
				"resume: resume polling (persisted). " +
				"status: show runtime state (enabled, paused, watch count, poll interval).",
		},
	),
	type: Type.Optional(
		Type.Union([Type.Literal("job"), Type.Literal("workflow")], {
			description: "Target kind for 'add': 'job' or 'workflow'.",
		}),
	),
	name: Type.Optional(
		Type.String({ description: "Glue job name or workflow name (required for 'add')." }),
	),
	runId: Type.Optional(
		Type.String({
			description:
				"Run ID (jr_… for jobs, wr_… for workflows). If omitted for 'add', the most recent run is used.",
		}),
	),
	profile: Type.Optional(
		Type.String({ description: "AWS credentials profile (required for 'add')." }),
	),
	region: Type.Optional(
		Type.String({ description: "AWS region. Uses the profile default when omitted." }),
	),
	watchId: Type.Optional(
		Type.String({ description: "Watch ID returned by 'add', required for 'remove'." }),
	),
});

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

interface UiSurface {
	notify?: (msg: string, level?: string) => void;
	setStatus?: (key: string, text: string | undefined) => void;
	theme?: { fg?: (color: string, text: string) => string };
	hasUI?: boolean;
}

/** Mutable per-process runtime. One instance per `createExtensionWithClient` call. */
interface Runtime {
	pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry">;
	client: GlueClient;
	watches: WatchMap;
	paused: boolean;
	enabled: boolean;
	/** Effective poll interval (ms). Grows on idle, resets on update. */
	pollIntervalMs: number;
	/** Idle back-off base (ms). Separate from pollIntervalMs so it isn't
	 *  reset unintentionally by the interval-change logic. */
	idleIntervalMs: number;
	timer: ReturnType<typeof setInterval> | null;
	ui: UiSurface | null;
}

function makeRuntime(pi: Runtime["pi"], client: GlueClient): Runtime {
	return {
		pi,
		client,
		watches: {},
		paused: false,
		enabled: false,
		pollIntervalMs: POLL_INTERVAL_MS,
		idleIntervalMs: POLL_INTERVAL_MS,
		timer: null,
		ui: null,
	};
}

// ---------------------------------------------------------------------------
// Status-line helpers
// ---------------------------------------------------------------------------

function colorize(
	theme: UiSurface["theme"],
	text: string,
): string {
	return theme?.fg ? theme.fg("accent", text) : text;
}

/** Re-render the status-line row from current runtime state. */
function refreshStatus(rt: Runtime): void {
	if (!rt.enabled) {
		rt.ui?.setStatus?.(STATUS_KEY, undefined);
		return;
	}
	const hasErrors = Object.values(rt.watches).some(
		(w) => !w.terminal && w.consecutiveErrors >= POLL_ERROR_THRESHOLD,
	);
	const text = buildStatusLine({
		watches: rt.watches,
		paused: rt.paused,
		pollIntervalMs: rt.pollIntervalMs,
		hasErrors,
	});
	rt.ui?.setStatus?.(STATUS_KEY, colorize(rt.ui?.theme, text));
}

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------

function startPolling(rt: Runtime): void {
	if (rt.timer !== null) return;
	rt.timer = setInterval(() => {
		void pollOnce(rt);
	}, rt.pollIntervalMs);
}

function stopPolling(rt: Runtime): void {
	if (rt.timer !== null) {
		clearInterval(rt.timer);
		rt.timer = null;
	}
}

/** Change the running interval; restart the timer only when the value changed. */
function setPollInterval(rt: Runtime, nextMs: number): void {
	if (rt.pollIntervalMs === nextMs) return;
	rt.pollIntervalMs = nextMs;
	stopPolling(rt);
	if (!rt.paused && rt.enabled) startPolling(rt);
}

/** Double the idle base (cap {@link POLL_INTERVAL_MAX_MS}) after a quiet poll. */
function bumpIdleInterval(rt: Runtime): void {
	rt.idleIntervalMs = Math.min(rt.idleIntervalMs * 2, POLL_INTERVAL_MAX_MS);
	setPollInterval(rt, rt.idleIntervalMs);
}

/** Reset both the idle base and effective interval after a poll with updates. */
function resetIntervalAfterUpdate(rt: Runtime): void {
	rt.idleIntervalMs = POLL_INTERVAL_MS;
	setPollInterval(rt, POLL_INTERVAL_MS);
}

/**
 * Single poll cycle. Exported for testing — callers can drive a poll
 * without advancing real timers.
 *
 * Processes all non-terminal watches in insertion order. Per-watch errors
 * are isolated — one failing watch never blocks the others. The combined
 * event batch lands as a single chat message.
 *
 * Error back-off: each watch tracks {@link GlueWatch.consecutiveErrors}.
 * After {@link POLL_ERROR_THRESHOLD} consecutive failures a warning chat
 * message is injected and the ⚠ indicator appears in the status line. On
 * the first successful poll after a streak the counter resets and a
 * recovery chat message fires. The idle back-off (interval doubling) is
 * shared across all watches so a single bad watch can't prevent the
 * interval from converging; error polls count the same as quiet polls for
 * back-off purposes.
 */
export async function pollOnce(rt: Runtime): Promise<void> {
	if (rt.paused || !rt.enabled) return;

	const active = Object.values(rt.watches).filter((w) => !w.terminal);
	if (active.length === 0) {
		refreshStatus(rt);
		return;
	}

	const allEvents: GlueEvent[] = [];
	let anyUpdate = false;

	for (const watch of active) {
		try {
			const result =
				watch.type === "job"
					? await detectJobChanges(rt.client, watch)
					: await detectWorkflowChanges(rt.client, watch);

			const prevErrors = watch.consecutiveErrors;
			watch.consecutiveErrors = 0;
			watch.baseline = result.newBaseline;
			watch.lastPolledAt = Date.now();

			// Recovery notification — only when we crossed the threshold
			if (prevErrors >= POLL_ERROR_THRESHOLD) {
				rt.pi.sendMessage(
					{
						customType: CUSTOM_MESSAGE_TYPE,
						content:
							`[Glue Watcher] ✓ ${watch.type} '${watch.name}' (${watch.watchId}) ` +
							`recovered after ${prevErrors} consecutive error(s).`,
						display: true,
					},
					{ deliverAs: "followUp", triggerTurn: false },
				);
			}

			if (result.events.length > 0) {
				anyUpdate = true;
				allEvents.push(...result.events);
				if (result.events.some((e) => e.isTerminal)) {
					watch.terminal = true;
				}
			}
		} catch (err) {
			watch.consecutiveErrors = (watch.consecutiveErrors) + 1;
			// eslint-disable-next-line no-console
			console.warn(
				`[glue-watcher] poll failed for ${watch.type} '${watch.name}': ${(err as Error).message}`,
			);
			// Threshold notification — fire exactly once when the streak reaches
			// the threshold, not on every subsequent failure.
			if (watch.consecutiveErrors === POLL_ERROR_THRESHOLD) {
				rt.pi.sendMessage(
					{
						customType: CUSTOM_MESSAGE_TYPE,
						content:
							`[Glue Watcher] ⚠ ${watch.type} '${watch.name}' (${watch.watchId}) ` +
							`has failed ${POLL_ERROR_THRESHOLD} consecutive polls. ` +
							`Last error: ${(err as Error).message}`,
						display: true,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			}
		}
	}

	if (allEvents.length > 0) {
		rt.pi.sendMessage(
			{
				customType: CUSTOM_MESSAGE_TYPE,
				content: buildChangeChatMessage(allEvents, new Date()),
				display: true,
				details: { events: allEvents },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		writeState(rt.pi, rt);
	}

	if (anyUpdate) {
		resetIntervalAfterUpdate(rt);
	} else {
		// Error polls and quiet polls both advance the idle back-off — a
		// consistently failing watch converges to the cap just as a healthy
		// but inactive one does.
		bumpIdleInterval(rt);
	}
	refreshStatus(rt);
}

// ---------------------------------------------------------------------------
// Tool registration (lazy, once-only)
// ---------------------------------------------------------------------------

/**
 * Register the `glue_watcher` tool with pi. Safe to call multiple times —
 * subsequent calls are no-ops guarded by the module-level `toolRegistered`
 * flag.
 */
export function registerToolIfNeeded(pi: ExtensionAPI, rt: Runtime): void {
	if (toolRegistered) return;
	toolRegistered = true;
	pi.registerTool({
		name: "glue_watcher",
		label: "Glue Watcher",
		description:
			"Manage the background AWS Glue job and workflow watcher. " +
			"Actions: add (start watching a run), remove (stop watching), " +
			"list (show all watches), pause (suspend polling), " +
			"resume (resume polling), status (show runtime state). " +
			"State-change events are injected into chat automatically.",
		parameters: GlueWatcherParams,
		async execute(_toolCallId, params) {
			return handleToolAction(rt, params);
		},
	});
}

function addToolToActive(pi: ExtensionAPI): void {
	const active = pi.getActiveTools(); // returns string[]
	if (active.includes("glue_watcher")) return;
	pi.setActiveTools([...active, "glue_watcher"]);
}

function removeToolFromActive(pi: ExtensionAPI): void {
	const active = pi.getActiveTools(); // returns string[]
	pi.setActiveTools(active.filter((n) => n !== "glue_watcher"));
}

// ---------------------------------------------------------------------------
// Tool action handler
// ---------------------------------------------------------------------------

interface ToolResultContent {
	content: Array<{ type: "text"; text: string }>;
	details: {
		action: string;
		ok: boolean;
		message: string;
		watches?: string[];
	};
}

function toolText(text: string): ToolResultContent["content"] {
	return [{ type: "text", text }];
}

type ToolParams = {
	action: string;
	type?: string | undefined;
	name?: string | undefined;
	runId?: string | undefined;
	profile?: string | undefined;
	region?: string | undefined;
	watchId?: string | undefined;
};

/** Exported for testing. Handles every tool action; pure except for AWS calls. */
export async function handleToolAction(
	rt: Runtime,
	params: ToolParams,
): Promise<ToolResultContent> {
	switch (params.action) {
		case "add": {
			// Validate inputs
			if (params.type !== "job" && params.type !== "workflow") {
				const message = `glue-watcher: 'add' requires type to be 'job' or 'workflow', got ${JSON.stringify(params.type ?? "")}.`;
				return { content: toolText(message), details: { action: "add", ok: false, message } };
			}
			const name = params.name?.trim() ?? "";
			if (!name) {
				const message = "glue-watcher: 'add' requires a non-empty name.";
				return { content: toolText(message), details: { action: "add", ok: false, message } };
			}
			const profile = params.profile?.trim() ?? "";
			if (!profile) {
				const message = "glue-watcher: 'add' requires a profile.";
				return { content: toolText(message), details: { action: "add", ok: false, message } };
			}
			const region = params.region?.trim() || undefined;
			const type = params.type;

			// Resolve run ID
			let runId = params.runId?.trim() ?? "";
			if (!runId) {
				try {
					runId =
						type === "job"
							? await rt.client.getLatestJobRunId(name, profile, region)
							: await rt.client.getLatestWorkflowRunId(name, profile, region);
				} catch (err) {
					const message = `glue-watcher: failed to fetch latest run ID for ${type} '${name}': ${(err as Error).message}`;
					return { content: toolText(message), details: { action: "add", ok: false, message } };
				}
			}

			const watchId = randomBytes(4).toString("hex");
			const watch: GlueWatch = {
				watchId,
				type,
				name,
				runId,
				profile,
				region,
				addedAt: Date.now(),
				lastPolledAt: undefined,
				baseline: undefined,
				terminal: false,
				consecutiveErrors: 0,
			};

			// Seed baseline (best-effort)
			let seedError: string | undefined;
			try {
				watch.baseline =
					type === "job"
						? await snapshotJobRun(rt.client, watch)
						: await snapshotWorkflowRun(rt.client, watch);
			} catch (err) {
				seedError = (err as Error).message;
			}

			rt.watches[watchId] = watch;
			writeState(rt.pi, rt);
			if (!rt.paused && rt.timer === null) startPolling(rt);
			refreshStatus(rt);

			const stateLabel = watch.baseline ? watch.baseline.state || "?" : "?";
			const message = watch.baseline
				? `glue-watcher: added ${type} '${name}' (${runId}) — state=${stateLabel}. Watch ID: ${watchId}`
				: `glue-watcher: added ${type} '${name}' (${runId}), but seeding failed (${seedError ?? "unknown"}). Watch ID: ${watchId}`;
			return {
				content: toolText(message),
				details: { action: "add", ok: true, message, watches: Object.keys(rt.watches) },
			};
		}

		case "remove": {
			const id = params.watchId?.trim() ?? "";
			if (!id) {
				const message = "glue-watcher: 'remove' requires a watchId.";
				return { content: toolText(message), details: { action: "remove", ok: false, message } };
			}
			if (!(id in rt.watches)) {
				const message = `glue-watcher: watch '${id}' not found.`;
				return { content: toolText(message), details: { action: "remove", ok: false, message } };
			}
			delete rt.watches[id];
			if (Object.keys(rt.watches).length === 0) stopPolling(rt);
			writeState(rt.pi, rt);
			refreshStatus(rt);
			const message = `glue-watcher: removed watch '${id}'. ${Object.keys(rt.watches).length} watch(es) remaining.`;
			return {
				content: toolText(message),
				details: { action: "remove", ok: true, message, watches: Object.keys(rt.watches) },
			};
		}

		case "list": {
			const ids = Object.keys(rt.watches);
			if (ids.length === 0) {
				const message = "glue-watcher: no watches configured.";
				return { content: toolText(message), details: { action: "list", ok: true, message, watches: [] } };
			}
			const lines = ids.map((id) => {
				const w = rt.watches[id];
				if (!w) return `- [${id}] (missing)`;
				const state = w.baseline ? w.baseline.state || "?" : "?";
				return `- [${id}] ${w.type} '${w.name}' (${w.runId}) | state=${state}${w.terminal ? " [terminal]" : ""}`;
			});
			const message = `glue-watcher: ${ids.length} watch(es):\n${lines.join("\n")}`;
			return { content: toolText(message), details: { action: "list", ok: true, message, watches: ids } };
		}

		case "pause": {
			rt.paused = true;
			stopPolling(rt);
			writeState(rt.pi, rt);
			refreshStatus(rt);
			const message = "glue-watcher: paused. Use the glue_watcher resume action to re-enable polling.";
			return { content: toolText(message), details: { action: "pause", ok: true, message } };
		}

		case "resume": {
			rt.paused = false;
			writeState(rt.pi, rt);
			const activeWatches = Object.values(rt.watches).filter((w) => !w.terminal);
			if (rt.enabled && activeWatches.length > 0 && rt.timer === null) startPolling(rt);
			refreshStatus(rt);
			const message = `glue-watcher: resumed. Polling ${Object.keys(rt.watches).length} watch(es) every ${Math.round(rt.pollIntervalMs / 1000)}s.`;
			return { content: toolText(message), details: { action: "resume", ok: true, message } };
		}

		case "status": {
			const ids = Object.keys(rt.watches);
			const activeCount = ids.filter((id) => !rt.watches[id]?.terminal).length;
			const terminalCount = ids.length - activeCount;
			const statusLabel = rt.paused ? "paused" : "active";
			const enabledLabel = rt.enabled ? "enabled" : "disabled";
			const message = [
				`glue-watcher: ${statusLabel} | ${enabledLabel}`,
				`  watches: ${ids.length} total (${activeCount} active, ${terminalCount} terminal)`,
				`  poll interval: ${Math.round(rt.pollIntervalMs / 1000)}s`,
			].join("\n");
			return { content: toolText(message), details: { action: "status", ok: true, message } };
		}

		default: {
			const message = `glue-watcher: unknown action ${JSON.stringify(params.action)}.`;
			return { content: toolText(message), details: { action: params.action, ok: false, message } };
		}
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Wire up the extension with a concrete or injected {@link GlueClient}.
 * Exported so tests can supply a stub client without touching the real CLI.
 */
export function createExtensionWithClient(
	pi: ExtensionAPI,
	client: GlueClient,
): void {
	const rt = makeRuntime(pi, client);

	pi.on("session_start", async (_event, ctx) => {
		const anyCtx = ctx as unknown as { hasUI?: boolean; ui?: UiSurface };
		const hasUI = anyCtx.hasUI ?? anyCtx.ui?.hasUI ?? anyCtx.ui !== undefined;
		rt.ui = hasUI ? (anyCtx.ui ?? null) : null;

		const state = rehydrateStateFromSession(ctx as unknown as SessionLike);
		rt.watches = state?.watches ?? {};
		rt.paused = state?.paused ?? false;
		rt.enabled = state?.enabled ?? false;

		if (!rt.enabled) return;

		// Register + expose tool
		registerToolIfNeeded(pi, rt);
		addToolToActive(pi);

		// Seed missing baselines (best-effort; poll loop retries on failure)
		for (const watch of Object.values(rt.watches)) {
			if (watch.terminal || watch.baseline !== undefined) continue;
			try {
				watch.baseline =
					watch.type === "job"
						? await snapshotJobRun(client, watch)
						: await snapshotWorkflowRun(client, watch);
			} catch (err) {
				// eslint-disable-next-line no-console
				console.warn(
					`[glue-watcher] seed failed for ${watch.type} '${watch.name}': ${(err as Error).message}`,
				);
			}
		}

		const activeWatches = Object.values(rt.watches).filter((w) => !w.terminal);
		if (!rt.paused && activeWatches.length > 0) startPolling(rt);
		refreshStatus(rt);

		if (Object.keys(rt.watches).length > 0) {
			setImmediate(() => {
				pi.sendMessage(
					{
						customType: CUSTOM_MESSAGE_TYPE,
						content: buildStartupChatMessage(rt.watches, new Date()),
						display: true,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
			});
		}
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

	pi.registerCommand("glue-watcher", {
		description:
			"AWS Glue watcher commands. Subcommands: enable, disable, status (default).",
		handler: async (args, ctx) => {
			const anyCtx = ctx as unknown as { hasUI?: boolean; ui?: UiSurface };
			const hasUI = anyCtx.hasUI ?? anyCtx.ui?.hasUI ?? anyCtx.ui !== undefined;
			const ui = hasUI ? (anyCtx.ui ?? null) : null;
			const sub = (args ?? "").trim().toLowerCase();

			switch (sub) {
				case "enable": {
					if (rt.enabled) {
						ui?.notify?.("glue-watcher: already enabled.", "info");
						return;
					}
					rt.enabled = true;
					registerToolIfNeeded(pi, rt);
					addToolToActive(pi);
					writeState(rt.pi, rt);
					const activeWatches = Object.values(rt.watches).filter((w) => !w.terminal);
					if (!rt.paused && activeWatches.length > 0 && rt.timer === null) startPolling(rt);
					refreshStatus(rt);
					ui?.notify?.(
						"glue-watcher: enabled. Use the glue_watcher tool to add job or workflow watches.",
						"info",
					);
					return;
				}

				case "disable": {
					if (!rt.enabled) {
						ui?.notify?.("glue-watcher: already disabled.", "info");
						return;
					}
					rt.enabled = false;
					stopPolling(rt);
					removeToolFromActive(pi);
					writeState(rt.pi, rt);
					rt.ui?.setStatus?.(STATUS_KEY, undefined);
					ui?.notify?.("glue-watcher: disabled. Status line and tool removed.", "info");
					return;
				}

				case "":
				case "status": {
					const ids = Object.keys(rt.watches);
					const active = ids.filter((id) => !rt.watches[id]?.terminal).length;
					const stateDesc = rt.enabled
						? rt.paused
							? "enabled, paused"
							: "enabled, active"
						: "disabled";
					ui?.notify?.(
						`glue-watcher: ${stateDesc} | ${ids.length} watch(es) (${active} active) | poll: ${Math.round(rt.pollIntervalMs / 1000)}s`,
						"info",
					);
					return;
				}

				default:
					ui?.notify?.(
						`glue-watcher: unknown subcommand '${args}'. Use: enable | disable | status`,
						"warning",
					);
			}
		},
	});
}

/** Default export — wired to the real AWS CLI client. */
export default function glueWatcher(pi: ExtensionAPI): void {
	const client = createGlueClient();
	createExtensionWithClient(pi, client);
}

// ---------------------------------------------------------------------------
// Test-only hooks
// ---------------------------------------------------------------------------

/** Reset the module-level tool-registration flag between test runs. */
export function __resetToolRegisteredForTests(): void {
	toolRegistered = false;
}

/** Construct a bare runtime for unit tests without running the full extension. */
export function __createRuntimeForTest(
	pi: Runtime["pi"],
	client: GlueClient,
): Runtime {
	return makeRuntime(pi, client);
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { STATE_CUSTOM_TYPE } from "./persistence.js";
export { buildStatusLine, buildChangeChatMessage, buildStartupChatMessage } from "./format.js";
export { snapshotJobRun, snapshotWorkflowRun, detectJobChanges, detectWorkflowChanges } from "./poller.js";
export { createGlueClient, GlueCliError } from "./cli-client.js";
export type { GlueClient } from "./cli-client.js";
export type { GlueWatch, GlueEvent, WatchMap, WatchBaseline, JobBaseline, WorkflowBaseline } from "./types.js";
