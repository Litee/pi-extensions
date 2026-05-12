/**
 * /glue-watcher subcommand dispatch.
 *
 * Split into a pure parser (`parseSubcommand`) that returns a discriminated
 * union, and a `runGlueWatcherCommand` executor that dispatches on the
 * parsed action against an injected `CommandDeps` bundle. The executor is
 * the piece wired into `pi.registerCommand` by index.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { GlueClient } from "./glue-client.js";
import { writeState } from "./persistence.js";
import {
	refreshStatus,
	startPolling,
	stopPolling,
	toggleDisplayMode,
	type Runtime,
	type UiSurface,
} from "./runtime.js";
import {
	addToolToActive,
	registerToolIfNeeded,
	removeToolFromActive,
} from "./toolAction.js";
import { WatchesView } from "./ui/watches-view.js";

// ---------------------------------------------------------------------------
// Parsed subcommand
// ---------------------------------------------------------------------------

export type GlueWatcherSubcommand =
	| { kind: "enable" }
	| { kind: "disable" }
	| { kind: "jobs" }
	| { kind: "status" }
	| { kind: "unknown"; raw: string };

/**
 * Parse the raw argument string passed to the `/glue-watcher` command.
 * Empty / whitespace-only strings and the explicit `"jobs"` subcommand both
 * resolve to `{kind: "jobs"}` — opening the watches view.
 */
export function parseSubcommand(args: string | undefined): GlueWatcherSubcommand {
	const sub = (args ?? "").trim().toLowerCase();
	switch (sub) {
		case "enable":
			return { kind: "enable" };
		case "disable":
			return { kind: "disable" };
		case "":
		case "jobs":
			return { kind: "jobs" };
		case "status":
			return { kind: "status" };
		default:
			return { kind: "unknown", raw: args ?? "" };
	}
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/** Context-shaped object the command handler reads from. Kept narrow. */
interface CtxWithUi {
	hasUI?: boolean;
	ui?: (UiSurface & {
		custom?: <T>(
			factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: T) => void) => unknown,
			options?: unknown,
		) => Promise<T>;
	}) | null;
}

export async function runGlueWatcherCommand(
	args: string | undefined,
	ctx: unknown,
	rt: Runtime,
	pi: ExtensionAPI,
	client: GlueClient,
): Promise<void> {
	const anyCtx = ctx as CtxWithUi;
	const hasUI = anyCtx.hasUI ?? anyCtx.ui?.hasUI ?? anyCtx.ui !== undefined;
	const ui = hasUI ? (anyCtx.ui ?? null) : null;

	const parsed = parseSubcommand(args);

	switch (parsed.kind) {
		case "enable": {
			if (rt.enabled) {
				ui?.notify?.("glue-watcher: already enabled.", "info");
				return;
			}
			rt.enabled = true;
			// Manual escape hatch: register + activate the tool, and start the full
			// polling/widget lifecycle. The LLM can also activate the tool alone via
			// manage_tools({action:"activate",tools:["glue_watcher"]}).
			registerToolIfNeeded(pi, rt);
			addToolToActive(pi);
			writeState(rt.pi, rt);
			const activeWatches = Object.values(rt.watches).filter((w) => !w.terminal);
			if (!rt.paused && activeWatches.length > 0 && !rt.scheduler.isRunning) startPolling(rt);
			refreshStatus(rt);
			if (rt.displayMode === "widget") rt.widget?.show(ctx);
			else rt.widget?.hide(ctx);
			ui?.notify?.(
				"glue-watcher: enabled and activated. Use the glue_watcher tool to add job or workflow watches.",
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
			rt.widget?.hide(ctx);
			removeToolFromActive(pi);
			writeState(rt.pi, rt);
			ui?.notify?.("glue-watcher: disabled. Tool removed.", "info");
			return;
		}

		case "jobs": {
			const ctxWithCustom = ctx as {
				ui: {
					custom: <T>(
						factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: T) => void) => unknown,
						options?: unknown,
					) => Promise<T>;
				};
			};
			await ctxWithCustom.ui.custom<void>(
				(tui, theme, _kb, done) => {
					const requestRender = (tui as { requestRender: () => void }).requestRender.bind(tui);
					return new WatchesView(
						() => rt.watches,
						theme as never,
						requestRender,
						() => done(undefined),
						async (row) => {
							const watch = rt.watches[row.watchId];
							if (!watch) return;
							if (watch.type === "job") {
								await client.stopJobRun(watch.name, watch.runId, watch.profile, watch.region);
							} else {
								await client.stopWorkflowRun(watch.name, watch.runId, watch.profile, watch.region);
							}
						},
						(watchId) => {
							delete rt.watches[watchId];
							if (Object.keys(rt.watches).length === 0) stopPolling(rt);
							writeState(rt.pi, rt);
							rt.pi.events.emit("glue:change", {});
						},
						() => rt.scheduler.intervalMs,
						() => toggleDisplayMode(rt, ctx),
						() => rt.displayMode,
					);
				},
				{
					overlay: true,
					overlayOptions: { width: "100%", maxHeight: "100%", anchor: "bottom-center" },
				},
			);
			return;
		}

		case "status": {
			const ids = Object.keys(rt.watches);
			const active = ids.filter((id) => !rt.watches[id]?.terminal).length;
			const stateDesc = rt.enabled
				? rt.paused
					? "enabled, paused"
					: "enabled, active"
				: "disabled";
			ui?.notify?.(
				`glue-watcher: ${stateDesc} | ${ids.length} watch(es) (${active} active) | poll: ${Math.round(rt.scheduler.intervalMs / 1000)}s`,
				"info",
			);
			return;
		}

		case "unknown":
			ui?.notify?.(
				`glue-watcher: unknown subcommand '${parsed.raw}'. Use: enable | disable | status | jobs (or no args)`,
				"warning",
			);
			return;
	}
}
