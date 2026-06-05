/**
 * pi-sandboxed-workflows — extension entry point.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

import {
	buildRowParts,
	dispatchBrowseKey,
	initialBrowseState,
	MENU_ITEMS,
	reduceBrowse,
	type BrowseState,
} from "./browseTui.js";
import { loadOrInitConfig } from "./config.js";
import { depsFromCtx } from "./depsFromCtx.js";
import { discoverWorkflows, type WorkflowScript } from "./discovery.js";
import { EVENT_CUSTOM_TYPE } from "./host.js";
import { createDefaultNotifySink } from "./notifySink.js";
import { createMessageRenderer } from "./render.js";
import { RunHistory, type RunRecord } from "./runHistory.js";
import { runWorkflow } from "./runtime.js";

export { EVENT_CUSTOM_TYPE } from "./host.js";
export { AgentBlockedError, MODEL_ALIASES } from "./agent.js";
export type { ModelAlias } from "./agent.js";
export type {
	WorkflowContext,
	WorkflowEvent,
	WorkflowModule,
} from "./types.js";

export const WORKFLOWS_DIR_NAME = "sandboxed-workflows";

export function defaultWorkflowsDir(homedir: string = osHomedir()): string {
	return join(homedir, ".pi", "agent", WORKFLOWS_DIR_NAME);
}

export interface FactoryOptions {
	readonly homedir?: string;
	readonly cwd?: string;   // override process.cwd() — used by tests
	readonly notify?: (
		message: string,
		level: "info" | "warning" | "error",
	) => void;
}

export default function piSandboxedWorkflows(
	pi: ExtensionAPI,
	options: FactoryOptions = {},
): void {
	const sessionAc = new AbortController();
	pi.on("session_shutdown", () => {
		sessionAc.abort();
	});

	// In-memory run history — populated by onLifecycleEvent and displayed
	// by the runs / run-detail TUI screens.
	const runHistory = new RunHistory();

	// Track in-flight workflow runs so a /workflow:stop-all command can abort
	// individual ones (or all). Each run gets its own AbortController so
	// stopping one doesn't affect others.
	interface RunningEntry {
		readonly name: string;
		readonly abort: (reason: Error) => void;
	}
	const runningWorkflows = new Map<string, RunningEntry>();
	let nextRunSeq = 0;
	pi.registerMessageRenderer(
		EVENT_CUSTOM_TYPE,
		createMessageRenderer() as Parameters<
			ExtensionAPI["registerMessageRenderer"]
		>[1],
	);

	const sink = options.notify ?? createDefaultNotifySink(pi);

	let scripts: ReadonlyArray<WorkflowScript> = [];
	try {
		const cfg = loadOrInitConfig(
			{
				...(options.homedir !== undefined ? { homedir: options.homedir } : {}),
				cwd: options.cwd ?? process.cwd(),
			},
		);
		const result = discoverWorkflows(cfg.directories);
		scripts = result.scripts;
		for (const w of result.warnings) {
			sink(
				`pi-sandboxed-workflows: skipped ${w.file} — ${w.reason}`,
				"warning",
			);
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		sink(`pi-sandboxed-workflows: failed to load config: ${msg}`, "error");
	}

	for (const script of scripts) {
		pi.registerCommand(`workflow:${script.name}`, {
			description: `Run the '${script.name}' workflow on <args>.`,
			// eslint-disable-next-line @typescript-eslint/require-await
			handler: async (args, ctx) => {
				// Per-run AbortController combined with the session signal so each
				// workflow can be cancelled individually via /workflow:stop-all without
				// affecting other in-flight runs.
				const runAc = new AbortController();
				const combinedSignal = AbortSignal.any([sessionAc.signal, runAc.signal]);
				const runKey = `${script.name}#${String(++nextRunSeq)}`;
				runningWorkflows.set(runKey, {
					name: script.name,
					abort: (reason) => runAc.abort(reason),
				});

				void runWorkflow({
					script,
					args,
					deps: {
						...depsFromCtx(pi, ctx, combinedSignal),
						rootSessionId: ctx.sessionManager.getSessionId(),
						runSeq: nextRunSeq,
						onLifecycleEvent: (kind, message, lifeCycleRunId, details) => {
							if (kind === "started") {
								runHistory.startRun(lifeCycleRunId, script.name);
							}
							runHistory.appendEvent(lifeCycleRunId, {
								kind,
								message,
								ts: Date.now(),
								details,
							});
							if (kind === "completed") {
								runHistory.finishRun(lifeCycleRunId, "completed");
							} else if (kind === "error") {
								runHistory.finishRun(lifeCycleRunId, "error");
							}
						},
					},
				}).then((result) => {
					if (result === "completed") {
						pi.sendMessage(
							{
								customType: EVENT_CUSTOM_TYPE,
								content: `✅ Workflow **${script.name}** finished`,
								display: true,
								details: { kind: "completed", name: script.name },
							},
							{ triggerTurn: false, deliverAs: "followUp" },
						);
					}
				}).catch((err: unknown) => {
					const msg = err instanceof Error ? err.message : String(err);
					// Treat AbortError (including Esc cancel from askUser) the same as
					// a signal abort so we show ⏹️ stopped instead of ❌ failed.
					const aborted = runAc.signal.aborted || sessionAc.signal.aborted
						|| (err instanceof Error && err.name === "AbortError");
					pi.sendMessage(
						{
							customType: EVENT_CUSTOM_TYPE,
							content: aborted
								? `⏹️ Workflow **${script.name}** stopped`
								: `❌ Workflow **${script.name}** failed: ${msg}`,
							display: true,
							details: aborted
								? { kind: "aborted", name: script.name }
								: { kind: "failed", name: script.name, error: msg },
						},
						{ triggerTurn: false, deliverAs: "followUp" },
					);
				}).finally(() => {
					runningWorkflows.delete(runKey);
				});
			},
		});
	}

	pi.registerCommand("workflow:stop-all", {
		description: "Stop all running sandboxed workflows.",
		// eslint-disable-next-line @typescript-eslint/require-await
		handler: async (_args, ctx) => {
			const entries = [...runningWorkflows.values()];
			if (entries.length === 0) {
				ctx.ui.notify("No workflows are currently running.", "info");
				return;
			}
			const reason = new Error("workflow stopped by /workflow:stop-all");
			for (const entry of entries) entry.abort(reason);
			ctx.ui.notify(
				`Aborted ${String(entries.length)} workflow(s): ${entries.map((e) => e.name).join(", ")}`,
				"info",
			);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("c"), {
		description: "Cancel all running sandboxed workflows",
		handler: () => {
			const entries = [...runningWorkflows.values()];
			if (entries.length > 0) {
				const reason = new Error("workflow cancelled by Ctrl+Alt+C");
				for (const entry of entries) entry.abort(reason);
			}
		},
	});

	pi.registerCommand("sandbox-workflow", {
		description:
			"Browse sandboxed workflows: opens a menu with Browse / Close options.",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(
					"Sandboxed workflow browser requires an interactive terminal",
					"warning",
				);
				return;
			}
			await openBrowseTui(ctx, scripts, runHistory);
		},
	});
}

const MAX_VISIBLE_ROWS = 15;

type CtxArg = Parameters<
	NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]>["handler"]
>[1];

type CustomFn = (
	factory: (
		tui: { requestRender: () => void },
		theme: {
			fg: (color: string, text: string) => string;
			bold: (text: string) => string;
			bg: (color: string, text: string) => string;
		},
		_kb: unknown,
		done: (value: void) => void,
	) => {
		render: (width: number) => string[];
		invalidate: () => void;
		handleInput: (data: string) => void;
	},
) => Promise<void>;

/** Format a Date.now() timestamp as a human-readable relative time. */
function formatRelative(ts: number): string {
	const diff = Date.now() - ts;
	if (diff < 60_000) return `${String(Math.floor(diff / 1_000))}s ago`;
	if (diff < 3_600_000) return `${String(Math.floor(diff / 60_000))}m ago`;
	return `${String(Math.floor(diff / 3_600_000))}h ago`;
}

/** Status icon for a run record. */
function statusIcon(status: RunRecord["status"]): string {
	switch (status) {
		case "running": return "⏳";
		case "completed": return "✅";
		case "error": return "❌";
		case "aborted": return "⏹️";
		default: return "○";
	}
}

async function openBrowseTui(
	ctx: CtxArg,
	scripts: ReadonlyArray<WorkflowScript>,
	runHistory: RunHistory,
): Promise<void> {
	const home = osHomedir();
	const ui = ctx.ui as unknown as { custom: CustomFn };

	await ui.custom((tui, theme, _kb, done) => {
		let browseState: BrowseState = initialBrowseState;
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;

		function invalidate(): void {
			cachedWidth = undefined;
			cachedLines = undefined;
		}

		function renderMenu(width: number, lines: string[]): void {
			const hr = theme.fg("accent", "─".repeat(width));
			lines.push(
				truncateToWidth(
					theme.fg("accent", theme.bold("Sandboxed Workflows")),
					width,
				),
			);
			lines.push(hr);
			lines.push("");
			for (let i = 0; i < MENU_ITEMS.length; i++) {
				const label = MENU_ITEMS[i]!;
				const selected = i === browseState.menuIndex;
				const cursor = selected ? theme.fg("accent", "\u203a") : " ";
				const text = selected
					? theme.fg("accent", theme.bold(label))
					: label;
				lines.push(truncateToWidth(`  ${cursor} ${text}`, width));
			}
			lines.push("");
			lines.push(hr);
			lines.push(
				truncateToWidth(
					theme.fg("dim", "\u2191\u2193 navigate \xb7 enter select \xb7 esc close"),
					width,
				),
			);
		}

		function renderRuns(width: number, lines: string[]): void {
			const hr = theme.fg("accent", "─".repeat(width));
			const workflow = scripts[browseState.listIndex];
			const wfName = workflow?.name ?? "unknown";
			const runs = runHistory.getRunsForName(wfName);

			lines.push(
				truncateToWidth(
					theme.fg("accent", theme.bold(`Runs: ${wfName}`)) +
						theme.fg("dim", `  (${String(runs.length)})`),
					width,
				),
			);
			lines.push(hr);

			if (runs.length === 0) {
				lines.push(
					truncateToWidth(
						theme.fg("dim", "  No run history available"),
						width,
					),
				);
			} else {
				const MAX_VISIBLE = 12;
				const idx = browseState.runsIndex;
				const start = Math.max(
					0,
					Math.min(runs.length - MAX_VISIBLE, idx - Math.floor(MAX_VISIBLE / 2)),
				);
				const end = Math.min(runs.length, start + MAX_VISIBLE);

				for (let i = start; i < end; i++) {
					const run = runs[i]!;
					const selected = i === idx;
					const icon = statusIcon(run.status);
					const when = formatRelative(run.startedAt);
					const idShort = run.runId.slice(0, 12);
					const label = `${icon}  ${idShort}  ${when}`;
					const cursor = selected ? theme.fg("accent", "\u203a") : " ";
					const text = selected
						? theme.fg("accent", theme.bold(label))
						: label;
					lines.push(truncateToWidth(`${cursor} ${text}`, width));
				}

				if (runs.length > MAX_VISIBLE) {
					lines.push(
						truncateToWidth(
							theme.fg("dim", `  \xb7\xb7\xb7 ${String(runs.length - MAX_VISIBLE)} more`),
							width,
						),
					);
				}
			}

			lines.push("");
			lines.push(hr);
			lines.push(
				truncateToWidth(
					theme.fg("dim", "\u2191\u2193 navigate \xb7 enter view \xb7 esc back \xb7 ctrl+c close"),
					width,
				),
			);
		}

		const EVENTS_PER_PAGE = 10;

		function renderRunDetail(width: number, lines: string[]): void {
			const hr = theme.fg("accent", "─".repeat(width));
			const workflow = scripts[browseState.listIndex];
			const wfName = workflow?.name ?? "unknown";
			const runs = runHistory.getRunsForName(wfName);
			const run = runs[browseState.runsIndex];

			lines.push(
				truncateToWidth(
					theme.fg("accent", theme.bold("Run Detail")) +
						(run !== undefined
							? theme.fg("dim", `  ${run.runId.slice(0, 12)}  ${statusIcon(run.status)}`)
							: ""),
					width,
				),
			);
			lines.push(hr);

			if (run === undefined || run.events.length === 0) {
				lines.push(
					truncateToWidth(
						theme.fg("dim", "  No events to display"),
						width,
					),
				);
			} else {
				const offset = browseState.runDetailIndex;
				const visibleEvents = run.events.slice(offset, offset + EVENTS_PER_PAGE);
				for (const ev of visibleEvents) {
					const ts = new Date(ev.ts).toLocaleTimeString();
					const row = `  [${ts}] ${ev.kind}: ${ev.message.slice(0, 80)}`;
					lines.push(truncateToWidth(row, width));
				}
				if (run.events.length > EVENTS_PER_PAGE) {
					const shown = `${String(offset + 1)}-${String(Math.min(offset + EVENTS_PER_PAGE, run.events.length))}`;
					lines.push(
						truncateToWidth(
							theme.fg("dim", `  \xb7\xb7\xb7 events ${shown} of ${String(run.events.length)}`),
							width,
						),
					);
				}
			}

			lines.push("");
			lines.push(hr);
			lines.push(
				truncateToWidth(
					theme.fg("dim", "\u2191\u2193 scroll \xb7 esc back \xb7 ctrl+c close"),
					width,
				),
			);
		}

		function renderList(width: number, lines: string[]): void {
			const hr = theme.fg("accent", "─".repeat(width));
			const count = theme.fg("dim", `  (${scripts.length})`);
			lines.push(
				truncateToWidth(
					theme.fg("accent", theme.bold("Workflows")) + count,
					width,
				),
			);
			lines.push(hr);

			if (scripts.length === 0) {
				lines.push(
					truncateToWidth(
						theme.fg(
							"warning",
							"  No workflows discovered. Edit ~/.pi/agent/pi-sandboxed-workflows.json",
						),
						width,
					),
				);
			} else {
				const idx = browseState.listIndex;
				const start = Math.max(
					0,
					Math.min(
						scripts.length - MAX_VISIBLE_ROWS,
						idx - Math.floor(MAX_VISIBLE_ROWS / 2),
					),
				);
				const end = Math.min(scripts.length, start + MAX_VISIBLE_ROWS);

				const longestName = scripts.reduce(
					(acc, s) => Math.max(acc, s.name.length),
					0,
				);
				const nameCol = Math.min(longestName + 2, 24);

				for (let i = start; i < end; i++) {
					const script = scripts[i]!;
					const selected = i === idx;
					const parts = buildRowParts(script, selected, home);
					const cursor = selected
						? theme.fg("accent", parts.cursor)
						: parts.cursor;
					const name = selected
						? theme.fg("accent", theme.bold(parts.name.padEnd(nameCol)))
						: parts.name.padEnd(nameCol);
					const source = theme.fg("dim", parts.source);
					lines.push(truncateToWidth(`${cursor} ${name}${source}`, width));
				}

				if (scripts.length > MAX_VISIBLE_ROWS) {
					lines.push(
						truncateToWidth(
							theme.fg("dim", `  \xb7\xb7\xb7 ${scripts.length - MAX_VISIBLE_ROWS} more`),
							width,
						),
					);
				}
			}

			lines.push("");
			lines.push(hr);
			lines.push(
				truncateToWidth(
					theme.fg("dim", "\u2191\u2193 navigate \xb7 esc back to menu \xb7 ctrl+c close"),
					width,
				),
			);
		}

		function render(width: number): string[] {
			if (cachedLines !== undefined && cachedWidth === width) {
				return cachedLines;
			}
			const lines: string[] = [];
			if (browseState.screen === "menu") {
				renderMenu(width, lines);
			} else if (browseState.screen === "list") {
				renderList(width, lines);
			} else if (browseState.screen === "runs") {
				renderRuns(width, lines);
			} else {
				renderRunDetail(width, lines);
			}
			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			render,
			invalidate,
			handleInput(data: string) {
				const action = dispatchBrowseKey(data, matchesKey);
				const listLength = browseState.screen === "list" ? scripts.length : MENU_ITEMS.length;
				// Compute the real runs count for the highlighted workflow so the
				// reducer can clamp runsIndex correctly (was always 0 = empty list).
				const wfName = scripts[browseState.listIndex]?.name ?? "";
				const runs = runHistory.getRunsForName(wfName);
				const step = reduceBrowse(browseState, action, listLength, runs.length);
				if (step.effect.kind === "close") {
					done(undefined);
					return;
				}
				// When transitioning from runs → run-detail, record which run is
				// selected so renderRunDetail can identify it by ID as well as index.
				if (
					step.state.screen === "run-detail" &&
					browseState.screen === "runs"
				) {
					const selectedRun = runs[browseState.runsIndex];
					browseState = {
						...step.state,
						...(selectedRun !== undefined
							? { currentRunId: selectedRun.runId }
							: {}),
					};
				} else {
					browseState = step.state;
				}
				invalidate();
				tui.requestRender();
			},
		};
	});
}
