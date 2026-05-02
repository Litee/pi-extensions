/**
 * pi-update-cmux-status — pi extension.
 *
 * Mirrors pi lifecycle events into cmux (sidebar status pill, log lines,
 * progress, desktop notifications) and auto-renames the cmux tab +
 * workspace based on an LLM summary of the first user prompt.
 *
 * Behaviour summary (matches the single-file `cmux-status.ts` starting point):
 *
 *   session_start          → status "idle" + log "Session started"
 *   input (first user msg) → fire-and-forget rename of tab / workspace
 *   before_agent_start     → status "working"
 *   tool_execution_start   → status "<toolName>" + progress log
 *   tool_execution_end     → success / error log
 *   agent_end              → status "idle" + clear-progress + log + notify
 *   session_shutdown       → clear status pill
 *
 * Plus a `/cmux-rename` slash command to regenerate names on demand.
 *
 * All cmux calls are no-ops when not running inside cmux (see
 * `cmuxAvailable`), so loading this extension in a plain terminal is safe.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
	clearProgress,
	clearStatus,
	cmuxAvailable,
	hhmm,
	logLine,
	notifyCmux,
	renameTab,
	renameWorkspace,
	setStatus,
} from "./cmux.js";
import { resolveRenameWorkspace, resolveStatusKey } from "./config.js";
import { generateNames, type NamesContext } from "./names.js";

/**
 * Dispatches a rename: calls the LLM, then (when the call succeeds) pipes
 * the result to cmux. Separated from `runRename` in the source .ts so the
 * LLM stage can be swapped out in tests.
 *
 * Returns `true` iff cmux rename calls were dispatched.
 */
export async function runRename(
	ctx: NamesContext,
	prompt: string,
	opts: {
		statusKey: string;
		renameWorkspace: boolean;
		/** Override the names source — tests pass a stub resolving to canned names. */
		fetchNames?: (ctx: NamesContext, prompt: string) => Promise<Awaited<ReturnType<typeof generateNames>>>;
	},
): Promise<boolean> {
	if (!cmuxAvailable()) return false;
	const fetch = opts.fetchNames ?? generateNames;
	const names = await fetch(ctx, prompt);
	if (!names) return false;
	renameTab(names.tab);
	if (opts.renameWorkspace) renameWorkspace(names.workspace);
	logLine(
		opts.statusKey,
		"info",
		`Renamed tab → "${names.tab}"${opts.renameWorkspace ? ` · workspace → "${names.workspace}"` : ""}`,
	);
	return true;
}

/**
 * Per-session mutable state. Kept in a record so tests can inspect it
 * after invoking the default export.
 */
export interface Runtime {
	/** Sidebar status pill key (usually "pi"). */
	statusKey: string;
	/** Whether /rename also renames the workspace. */
	renameWorkspace: boolean;
	/** Has the one-shot auto-rename fired this session yet? */
	namedThisSession: boolean;
	/** Text of the first user prompt, if any — reused by /cmux-rename. */
	lastFirstPrompt: string | null;
	/** Tool currently in flight (for debugging, matches the .ts original). */
	currentTool: string | null;
}

function makeRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
	return {
		statusKey: resolveStatusKey(env),
		renameWorkspace: resolveRenameWorkspace(env),
		namedThisSession: false,
		lastFirstPrompt: null,
		currentTool: null,
	};
}

/** `shortCwd` — trailing path segment of `cwd`, or `"pi"` if cwd is blank. */
export function shortCwd(cwd: string): string {
	const segs = cwd.split("/").filter(Boolean);
	return segs[segs.length - 1] ?? "pi";
}

export default function cmuxStatus(pi: ExtensionAPI): void {
	const rt = makeRuntime();

	// ── Session lifecycle ──────────────────────────────────────────────
	pi.on("session_start", async () => {
		rt.namedThisSession = false;
		rt.lastFirstPrompt = null;
		rt.currentTool = null;
		if (!cmuxAvailable()) return;
		setStatus(rt.statusKey, "idle", "checkmark", "#30d158");
		logLine(rt.statusKey, "info", `[${hhmm()}] pi session started`);
	});

	pi.on("session_shutdown", async () => {
		if (!cmuxAvailable()) return;
		clearProgress();
		clearStatus(rt.statusKey);
	});

	// ── User input → capture first prompt for rename ───────────────────
	pi.on("input", async (event, ctx) => {
		if (!cmuxAvailable()) return;
		if (rt.namedThisSession) return;
		if (event.source !== "interactive" && event.source !== "rpc") return;
		const text = (event.text || "").trim();
		if (!text) return;
		if (text.startsWith("/")) return; // slash commands
		rt.namedThisSession = true;
		rt.lastFirstPrompt = text;
		// Fire-and-forget — don't block input processing on the LLM call.
		void runRename(ctx as unknown as NamesContext, text, {
			statusKey: rt.statusKey,
			renameWorkspace: rt.renameWorkspace,
		});
	});

	// ── Agent run lifecycle ────────────────────────────────────────────
	pi.on("before_agent_start", async () => {
		if (!cmuxAvailable()) return;
		setStatus(rt.statusKey, "working", "bolt", "#ff9500");
	});

	pi.on("agent_end", async () => {
		if (!cmuxAvailable()) return;
		rt.currentTool = null;
		clearProgress();
		setStatus(rt.statusKey, "idle", "checkmark", "#30d158");
		logLine(rt.statusKey, "success", `[${hhmm()}] Response complete`);
		notifyCmux("pi", shortCwd(process.cwd()), `[${hhmm()}] Response complete`);
	});

	// ── Tool execution ─────────────────────────────────────────────────
	pi.on("tool_execution_start", async (event) => {
		if (!cmuxAvailable()) return;
		rt.currentTool = event.toolName;
		setStatus(rt.statusKey, event.toolName, "hammer", "#ff9500");
		logLine(rt.statusKey, "progress", `[${hhmm()}] Running ${event.toolName}`);
	});

	pi.on("tool_execution_end", async (event) => {
		if (!cmuxAvailable()) return;
		const maybeFailed = event as unknown as {
			isError?: unknown;
			result?: { isError?: unknown };
		};
		const failed =
			maybeFailed.isError === true ||
			(typeof maybeFailed.result === "object" &&
				maybeFailed.result !== null &&
				maybeFailed.result.isError === true);
		if (failed) {
			logLine(rt.statusKey, "error", `[${hhmm()}] ${event.toolName} failed`);
		} else {
			logLine(rt.statusKey, "success", `[${hhmm()}] ${event.toolName} done`);
		}
		if (rt.currentTool === event.toolName) rt.currentTool = null;
	});

	// ── Manual rename command ──────────────────────────────────────────
	pi.registerCommand("cmux-rename", {
		description:
			"Regenerate cmux tab + workspace names from the last first-prompt (or provided text)",
		handler: async (args, ctx) => {
			const ui = (ctx as ExtensionContext).ui;
			if (!cmuxAvailable()) {
				ui.notify("Not running inside cmux (no CMUX_WORKSPACE_ID).", "warning");
				return;
			}
			const override = args?.trim();
			const prompt = override || rt.lastFirstPrompt;
			if (!prompt) {
				ui.notify(
					"No prompt yet — send a message first, or run '/cmux-rename <text>'.",
					"warning",
				);
				return;
			}
			ui.notify("Renaming cmux tab/workspace…", "info");
			rt.namedThisSession = true;
			if (override) rt.lastFirstPrompt = override;
			const ok = await runRename(ctx as unknown as NamesContext, prompt, {
				statusKey: rt.statusKey,
				renameWorkspace: rt.renameWorkspace,
			});
			if (!ok) {
				ui.notify("Rename failed (model call errored).", "error");
			} else {
				ui.notify("Renamed cmux tab/workspace.", "info");
			}
		},
	});
}

// ---------------------------------------------------------------------------
// Re-exports for convenience (makes the test surface explicit)
// ---------------------------------------------------------------------------

export { parseNames, SUMMARY_SYSTEM_PROMPT, resolveSummaryModel } from "./names.js";
export {
	resolveRenameWorkspace,
	resolveStatusKey,
	resolveSummaryModelOverride,
} from "./config.js";
export {
	buildLogArgs,
	buildNotifyArgs,
	buildRenameTabArgs,
	buildRenameWorkspaceArgs,
	buildSetStatusArgs,
	cmuxAvailable,
	hhmm,
} from "./cmux.js";
