/**
 * pi-cmux-notifications — pi extension.
 *
 * Mirrors pi lifecycle events into cmux. Three states only:
 *
 *   idle       — green checkmark, between turns. Set on `session_start`
 *                and `agent_end`.
 *   working    — orange bolt, agent turn in progress. Set on `input`
 *                AND on `before_agent_start` (belt-and-braces — turns
 *                triggered by slack-watcher, recovery, or other
 *                non-interactive sources still get the bolt).
 *   attention  — red speech bubble, agent blocked on a UI prompt
 *                (`ask_user_question`, plan-mode approval, …). The
 *                ONLY state that fires a desktop notification.
 *
 * No "done" pill, no agent_end desktop ping, no focus tracking — by
 * deliberate design choice. The user's signal that a response is ready
 * is the pill returning to idle and the sidebar log line. If the agent
 * actually needs human input, the attention extension emits
 * `need_user_attention` on `pi.events` and we ping there.
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
import { resolveStatusKey } from "./config.js";

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

// ── Pill colour / icon constants ──────────────────────────────────────────
//
// Centralised so a future cmux icon-set change is a one-line edit and tests
// can assert on the constant rather than a magic string.
const IDLE_ICON = "checkmark";
const IDLE_COLOR = "#30d158"; // green
const WORKING_ICON = "bolt";
const WORKING_COLOR = "#ff9500"; // orange
const ATTENTION_ICON = "bubble.left.fill";
const ATTENTION_COLOR = "#ff3b30"; // red

export default function cmuxReportStatus(pi: ExtensionAPI): void {
	const rt = makeRuntime();

	// ── Pill helpers ────────────────────────────────────────────────────
	const setIdle = (): void =>
		setStatus(rt.statusKey, "idle", IDLE_ICON, IDLE_COLOR);
	const setWorking = (): void =>
		setStatus(rt.statusKey, "working", WORKING_ICON, WORKING_COLOR);
	const setAttention = (label: string): void => {
		setStatus(rt.statusKey, "attention", ATTENTION_ICON, ATTENTION_COLOR);
		notifyCmux(rt.statusKey, shortCwd(process.cwd()), `[${hhmm()}] ${label}`);
	};

	// ── Session lifecycle ──────────────────────────────────────────────
	pi.on("session_start", () => {
		if (!cmuxAvailable()) return;
		setIdle();
		logLine(rt.statusKey, "info", `[${hhmm()}] pi session started`);
	});

	pi.on("session_shutdown", () => {
		if (!cmuxAvailable()) return;
		clearProgress();
		clearStatus(rt.statusKey);
	});

	// ── User input → bolt ───────────────────────────────────────────────
	// We wire BOTH `input` (immediate feedback on keystroke) and
	// `before_agent_start` (belt-and-braces for turns kicked off by
	// non-interactive sources, e.g. slack-watcher injection, recovery,
	// API-source inputs). Either event lighting up the bolt is fine —
	// `setStatus("working", …)` is idempotent.
	pi.on("input", (event) => {
		if (!cmuxAvailable()) return;
		if (event.source !== "interactive" && event.source !== "rpc") return;
		const text = (event.text || "").trim();
		if (!text) return;
		if (text.startsWith("/")) return; // slash commands
		setWorking();
	});

	pi.on("before_agent_start", () => {
		if (!cmuxAvailable()) return;
		setWorking();
	});

	// ── Agent run lifecycle ────────────────────────────────────────────
	pi.on("agent_end", () => {
		if (!cmuxAvailable()) return;
		clearProgress();
		setIdle();
		logLine(rt.statusKey, "success", `[${hhmm()}] Response complete`);
		// No desktop notification on plain agent_end — the pill returning to
		// idle and the sidebar log are the signal. Notifications are reserved
		// for the `attention` state, where the agent is actually blocked on
		// the user.
	});

	// ── Inter-extension attention events ────────────────────────────────
	// Extensions that block on UI prompts outside the tool pipeline
	// (pi-ask-user-question, pi-plan-mode's approval prompt) emit these
	// events so we can flip the pill to red and fire a desktop notify
	// without coupling.
	pi.events.on("need_user_attention", (data: unknown) => {
		if (!cmuxAvailable()) return;
		const payload = data as { title?: string } | undefined;
		setAttention(payload?.title ?? "Needs your input");
	});

	pi.events.on("user_attention_resolved", () => {
		if (!cmuxAvailable()) return;
		setWorking();
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
