/**
 * pi-cmux-notifications — pi extension.
 *
 * Mirrors pi lifecycle events into cmux (sidebar status pill, desktop
 * notifications). Split out of the old `pi-update-cmux-status` package
 * so the status-pill mirror and the LLM-driven workspace rename can be
 * installed/uninstalled independently (see the sibling
 * `pi-cmux-update-workspace-name` package for the rename half).
 *
 * Two-state status model (#0002 in the old package): the pill is either
 * `working` (pi is processing a user request) or `idle` (pi is waiting
 * for user input). A third `waiting` state fires only when an
 * attention-marked tool is running (e.g. `ask_user_question`) so users
 * in a different cmux tab get a desktop bell.
 *
 *   session_start          → status "idle" + log "pi session started"
 *   input (any eligible)   → status "working" every turn
 *   tool_execution_start   → if toolName is in ATTENTION_TOOLS
 *                             (hardcoded), status "waiting" + notify.
 *   tool_execution_end     → if toolName is in ATTENTION_TOOLS,
 *                             status back to "working".
 *   agent_end              → status "idle" + clear-progress + log (no desktop notify)
 *   session_shutdown       → clear status pill + clear progress
 *
 * All cmux calls are no-ops when not running inside cmux (see
 * `cmuxAvailable`), so loading this extension in a plain terminal is safe.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
	clearProgress,
	clearStatus,
	cmuxAvailable,
	hhmm,
	logLine,
	notifyCmux,
	setStatus,
} from "./cmux.js";
import { resolveStatusKey } from "./config.js";

/**
 * Tool names that should flip the pill to `waiting` and fire a desktop
 * notification when invoked by any extension.
 *
 * Hardcoded — adding to this list is a source edit, not a config knob.
 * Currently only the `ask_user_question` tool from the sibling
 * `pi-ask-user-question` extension qualifies: it blocks the agent
 * waiting on the user, which is exactly the state a user sitting in
 * another tab needs to be pinged about.
 */
const ATTENTION_TOOLS: readonly string[] = ["ask_user_question"];

/**
 * Per-session mutable state. Kept in a record so tests can inspect it
 * after invoking the default export.
 */
export interface Runtime {
	/** Sidebar status pill key (usually "pi"). */
	statusKey: string;
}

function makeRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
	return { statusKey: resolveStatusKey(env) };
}

/** `shortCwd` — trailing path segment of `cwd`, or `"pi"` if cwd is blank. */
export function shortCwd(cwd: string): string {
	const segs = cwd.split("/").filter(Boolean);
	return segs[segs.length - 1] ?? "pi";
}

export default function cmuxReportStatus(pi: ExtensionAPI): void {
	const rt = makeRuntime();

	// ── Session lifecycle ──────────────────────────────────────────────
	pi.on("session_start", async () => {
		if (!cmuxAvailable()) return;
		setStatus(rt.statusKey, "idle", "checkmark", "#30d158");
		logLine(rt.statusKey, "info", `[${hhmm()}] pi session started`);
	});

	pi.on("session_shutdown", async () => {
		if (!cmuxAvailable()) return;
		clearProgress();
		clearStatus(rt.statusKey);
	});

	// ── User input → pill to working ───────────────────────────────────
	pi.on("input", async (event) => {
		if (!cmuxAvailable()) return;
		if (event.source !== "interactive" && event.source !== "rpc") return;
		const text = (event.text || "").trim();
		if (!text) return;
		if (text.startsWith("/")) return; // slash commands
		// Every eligible user message flips the pill to 'working' so the user
		// gets immediate feedback that pi has accepted their turn. The pill
		// stays 'working' across all tool calls in this turn and only returns
		// to 'idle' on `agent_end`.
		setStatus(rt.statusKey, "working", "bolt", "#ff9500");
	});

	// ── Agent run lifecycle ────────────────────────────────────────────
	pi.on("agent_end", async () => {
		if (!cmuxAvailable()) return;
		clearProgress();
		setStatus(rt.statusKey, "idle", "checkmark", "#30d158");
		logLine(rt.statusKey, "success", `[${hhmm()}] Response complete`);
		// No desktop notification here: agent finishing is surfaced via the
		// status pill and sidebar log only. Notifications are reserved for
		// states where the agent actively needs human input (attention tools).
	});

	// ── Attention tools → waiting pill + desktop notify ────────────────
	pi.on("tool_execution_start", async (event) => {
		if (!cmuxAvailable()) return;
		const toolName = (event as { toolName?: unknown }).toolName;
		if (typeof toolName !== "string") return;
		if (!ATTENTION_TOOLS.includes(toolName)) return;
		setStatus(rt.statusKey, "waiting", "bell", "#5ac8fa");
		notifyCmux(
			"pi",
			shortCwd(process.cwd()),
			`[${hhmm()}] Needs your input (${toolName})`,
		);
	});

	pi.on("tool_execution_end", async (event) => {
		if (!cmuxAvailable()) return;
		const toolName = (event as { toolName?: unknown }).toolName;
		if (typeof toolName !== "string") return;
		if (!ATTENTION_TOOLS.includes(toolName)) return;
		setStatus(rt.statusKey, "working", "bolt", "#ff9500");
	});
}

// ---------------------------------------------------------------------------
// Re-exports for convenience (makes the test surface explicit)
// ---------------------------------------------------------------------------

export { resolveStatusKey } from "./config.js";
export {
	buildLogArgs,
	buildNotifyArgs,
	buildSetStatusArgs,
	cmuxAvailable,
	hhmm,
} from "./cmux.js";
