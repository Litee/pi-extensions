/**
 * /glue-watcher subcommand dispatch.
 *
 * Split into a pure parser (`parseSubcommand`) that returns a discriminated
 * union, and a `runGlueWatcherCommand` executor that dispatches on the
 * parsed action against an injected `CommandDeps` bundle. The executor is
 * the piece wired into `pi.registerCommand` by index.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractUiSurface } from "pi-watcher-core/ui-surface";

import type { GlueClient } from "./glue-client.js";
import { writeState } from "./persistence.js";
import {
	stopPolling,
	toggleDisplayMode,
	type Runtime,
} from "./runtime.js";
import { WatchesView } from "./ui/watches-view.js";

// ---------------------------------------------------------------------------
// Parsed subcommand
// ---------------------------------------------------------------------------

export type GlueWatcherSubcommand =
	| { kind: "browse" }
	| { kind: "status" }
	| { kind: "unknown"; raw: string };

/**
 * Parse the raw argument string passed to the `/glue-watcher` command.
 * Empty / whitespace-only strings and the explicit `"browse"` subcommand both
 * resolve to `{kind: "browse"}` — opening the watches view. Matches the
 * `browse` naming convention used by other pi watcher extensions
 * (e.g. `/local-issue-watcher browse`).
 */
export function parseSubcommand(args: string | undefined): GlueWatcherSubcommand {
	const sub = (args ?? "").trim().toLowerCase();
	switch (sub) {
		case "":
		case "browse":
			return { kind: "browse" };
		case "status":
			return { kind: "status" };
		default:
			return { kind: "unknown", raw: args ?? "" };
	}
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export async function runGlueWatcherCommand(
	args: string | undefined,
	ctx: unknown,
	rt: Runtime,
	_pi: ExtensionAPI,
	client: GlueClient,
): Promise<void> {
	const ui = extractUiSurface(ctx);

	const parsed = parseSubcommand(args);

	switch (parsed.kind) {
		case "browse": {
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
			const stateDesc = rt.paused ? "paused" : "active";
			ui?.notify?.(
				`glue-watcher: ${stateDesc} | ${ids.length} watch(es) (${active} active) | poll: ${Math.round(rt.scheduler.intervalMs / 1000)}s`,
				"info",
			);
			return;
		}

		case "unknown":
			ui?.notify?.(
				`glue-watcher: unknown subcommand '${parsed.raw}'. Use: status | browse (or no args)`,
				"warning",
			);
			return;
	}
}
