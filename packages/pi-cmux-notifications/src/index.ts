/**
 * pi-cmux-notifications — pi extension.
 *
 * Mirrors pi lifecycle events into cmux (sidebar status pill, desktop
 * notifications). Split out of the old `pi-update-cmux-status` package
 * so the status-pill mirror and the LLM-driven workspace rename can be
 * installed/uninstalled independently (see the sibling
 * `pi-cmux-update-workspace-name` package for the rename half).
 *
 * Four-state status model: the pill is `idle` (pi waiting for user input),
 * `working` (pi is processing a user request), `waiting` (agent is blocked
 * on user attention), or `done` (agent turn finished, pending user focus-in).
 *
 *   session_start          → status "idle" + log "pi session started"
 *   input (any eligible)   → status "working" every turn; clears pending dot
 *   agent_end              → status "done" (red circle) + clear-progress + log;
 *                            cleared to "idle" (green checkmark) on focus-in
 *   session_shutdown       → clear status pill + clear progress
 *
 * Additionally, two inter-extension events on pi.events are handled:
 *   pi.events "need_user_attention"    → status "waiting" + desktop notify
 *   pi.events "user_attention_resolved" → status back to "working"
 * These cover UI-level prompts outside the tool pipeline (e.g.
 * pi-ask-user-question emits these when the ask_user_question dialog is open,
 * pi-plan-mode's ctx.ui.select approval prompt).
 *
 * All cmux calls are no-ops when not running inside cmux (see
 * `cmuxAvailable`), so loading this extension in a plain terminal is safe.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	clearProgress,
	clearStatus,
	cmuxAvailable,
	hhmm,
	logLine,
	notifyCmux,
	setStatus,
} from "./cmux.js";
import { feedFocusBytes } from "./focusParser.js";
import { resolveStatusKey } from "./config.js";

const FOCUS_ENABLE = "\x1b[?1004h";
const FOCUS_DISABLE = "\x1b[?1004l";

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

	let hasPendingDot = false;
	let focusListener: ((chunk: Buffer) => void) | undefined;
	let focusEnabled = false;

	// ── Attention state helpers ────────────────────────────────────────
	function enterWaiting(label: string): void {
		setStatus(rt.statusKey, "waiting", "bell", "#5ac8fa");
		notifyCmux(rt.statusKey, shortCwd(process.cwd()), `[${hhmm()}] ${label}`);
	}

	function exitWaiting(): void {
		setStatus(rt.statusKey, "working", "bolt", "#ff9500");
	}

	// ── Focus reporting helpers ────────────────────────────────────────
	function attachFocusReporting(): void {
		if (focusEnabled) return;
		if (!process.stdout.isTTY || !process.stdin.isTTY) return;
		try { process.stdout.write(FOCUS_ENABLE); } catch { return; }
		let buf = "";
		const listener = (chunk: Buffer) => {
			try {
				const { events: focusEvents, rest } = feedFocusBytes(buf, chunk.toString("binary"));
				buf = rest;
				for (const ev of focusEvents) {
					if (ev === "in" && hasPendingDot) {
						hasPendingDot = false;
						setStatus(rt.statusKey, "idle", "checkmark", "#30d158");
					}
				}
			} catch { /* best-effort */ }
		};
		process.stdin.on("data", listener);
		focusListener = listener;
		focusEnabled = true;
	}

	function detachFocusReporting(): void {
		if (focusListener) {
			try { process.stdin.off("data", focusListener); } catch { /* noop */ }
			focusListener = undefined;
		}
		if (focusEnabled) {
			try { process.stdout.write(FOCUS_DISABLE); } catch { /* noop */ }
			focusEnabled = false;
		}
	}

	// ── Session lifecycle ──────────────────────────────────────────────
	pi.on("session_start", () => {
		if (!cmuxAvailable()) return;
		setStatus(rt.statusKey, "idle", "checkmark", "#30d158");
		logLine(rt.statusKey, "info", `[${hhmm()}] pi session started`);
		attachFocusReporting();
	});

	pi.on("session_shutdown", () => {
		if (!cmuxAvailable()) return;
		detachFocusReporting();
		clearProgress();
		clearStatus(rt.statusKey);
	});

	// ── User input → pill to working ───────────────────────────────────
	pi.on("input", (event) => {
		if (!cmuxAvailable()) return;
		if (event.source !== "interactive" && event.source !== "rpc") return;
		const text = (event.text || "").trim();
		if (!text) return;
		if (text.startsWith("/")) return; // slash commands
		// Every eligible user message clears the pending dot and flips the
		// pill to 'working' so the user gets immediate feedback that pi has
		// accepted their turn. The pill stays 'working' across all tool calls
		// in this turn and only returns to 'done' on `agent_end`.
		hasPendingDot = false;
		setStatus(rt.statusKey, "working", "bolt", "#ff9500");
	});

	// ── Agent run lifecycle ────────────────────────────────────────────
	pi.on("agent_end", () => {
		if (!cmuxAvailable()) return;
		clearProgress();
		setStatus(rt.statusKey, "done", "circle.fill", "#ff3b30");
		hasPendingDot = true;
		logLine(rt.statusKey, "success", `[${hhmm()}] Response complete`);
		// No desktop notification here: agent finishing is surfaced via the
		// status pill and sidebar log only. Notifications are reserved for
		// states where the agent actively needs human input (attention tools).
		// The red circle clears to idle (green checkmark) on the next focus-in.
	});

	// ── Inter-extension attention events ────────────────────────────────
	// Extensions that block on UI prompts outside the tool pipeline
	// (e.g. pi-ask-user-question emits these when ask_user_question runs,
	// pi-plan-mode's ctx.ui.select emits them for approval prompts) emit
	// these events so we can flip the pill and fire a desktop notification
	// without coupling.
	pi.events.on("need_user_attention", (data: unknown) => {
		if (!cmuxAvailable()) return;
		const payload = data as { title?: string } | undefined;
		enterWaiting(payload?.title ?? "Needs your input");
	});

	pi.events.on("user_attention_resolved", () => {
		if (!cmuxAvailable()) return;
		exitWaiting();
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
