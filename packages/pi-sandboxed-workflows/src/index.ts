/**
 * pi-sandboxed-workflows — extension entry point.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
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
			options.homedir !== undefined ? { homedir: options.homedir } : {},
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
					},
				}).then(() => {
					pi.sendMessage(
						{
							customType: EVENT_CUSTOM_TYPE,
							content: `✅ Workflow **${script.name}** finished`,
							display: true,
							details: { kind: "completed", name: script.name },
						},
						{ triggerTurn: false, deliverAs: "followUp" },
					);
				}).catch((err: unknown) => {
					const msg = err instanceof Error ? err.message : String(err);
					const aborted = runAc.signal.aborted || sessionAc.signal.aborted;
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
			await openBrowseTui(ctx, scripts);
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

async function openBrowseTui(
	ctx: CtxArg,
	scripts: ReadonlyArray<WorkflowScript>,
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
			} else {
				renderList(width, lines);
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
				const step = reduceBrowse(browseState, action, browseState.screen === "list" ? scripts.length : MENU_ITEMS.length);
				if (step.effect.kind === "close") {
					done(undefined);
					return;
				}
				browseState = step.state;
				invalidate();
				tui.requestRender();
			},
		};
	});
}
