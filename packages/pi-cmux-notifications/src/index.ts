/**
 * pi-cmux-notifications — pi extension.
 *
 * Mirrors pi lifecycle events into cmux. Four states:
 *
 *   idle       — grey circle; the agent is waiting for input and you
 *                have seen the last response (or the session just started).
 *   working    — orange bolt; an agent turn is in progress.
 *   unread     — blue circle; the agent finished a turn while you were
 *                in another pane. Clears to `idle` when you focus back.
 *   attention  — red speech bubble; the agent is blocked on a UI prompt
 *                (`ask_user_question`, plan-mode approval, …). The ONLY
 *                state that fires a desktop notification.
 *
 * The idle vs unread distinction lets you scan multiple cmux workspaces
 * and immediately tell apart "I know why this session is quiet" (grey)
 * from "something happened here while I was elsewhere" (blue).
 *
 * Focus tracking (DECSET ?1004):
 *   - focus-out sets `focusedAway = true`.
 *   - focus-in sets `focusedAway = false`; if the pill was `unread`,
 *     clears it to `idle` — you're now looking at it.
 *   - On `agent_end`: if `focusedAway`, pill → `unread`; otherwise
 *     pill → `idle` (you were already watching, no need to flag it).
 *   Focus reporting requires stdin + stdout to both be TTYs. When
 *   unavailable (non-TTY, RPC-only sessions), `focusedAway` is always
 *   false and `agent_end` goes straight to `idle`.
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

export interface Runtime {
	statusKey: string;
}

function makeRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
	return { statusKey: resolveStatusKey(env) };
}

export function shortCwd(cwd: string): string {
	const segs = cwd.split("/").filter(Boolean);
	return segs[segs.length - 1] ?? "pi";
}

// ── Pill constants ────────────────────────────────────────────────────────

const IDLE_ICON      = "circle.fill";
const IDLE_COLOR     = "#8e8e93"; // grey  — "quiet, nothing to see"
const WORKING_ICON   = "bolt";
const WORKING_COLOR  = "#ff9500"; // orange
const UNREAD_ICON    = "circle.fill";
const UNREAD_COLOR   = "#007aff"; // blue  — "something happened while you were away"
const ATTENTION_ICON  = "bubble.left.fill";
const ATTENTION_COLOR = "#ff3b30"; // red

export default function cmuxReportStatus(pi: ExtensionAPI): void {
	const rt = makeRuntime();

	// Focus state — updated by the stdin focus listener below.
	let focusedAway = false;
	let hasUnread   = false; // true while pill is in the `unread` state
	let focusListener: ((chunk: Buffer) => void) | undefined;
	let focusEnabled = false;

	// ── Pill helpers ────────────────────────────────────────────────────
	const setIdle = (): void => {
		hasUnread = false;
		setStatus(rt.statusKey, "idle", IDLE_ICON, IDLE_COLOR);
	};
	const setWorking = (): void => {
		hasUnread = false;
		setStatus(rt.statusKey, "working", WORKING_ICON, WORKING_COLOR);
	};
	const setUnread = (): void => {
		hasUnread = true;
		setStatus(rt.statusKey, "unread", UNREAD_ICON, UNREAD_COLOR);
	};
	const setAttention = (label: string): void => {
		setStatus(rt.statusKey, "attention", ATTENTION_ICON, ATTENTION_COLOR);
		notifyCmux(rt.statusKey, shortCwd(process.cwd()), `[${hhmm()}] ${label}`);
	};

	// ── Focus reporting ─────────────────────────────────────────────────
	function attachFocusReporting(): void {
		if (focusEnabled) return;
		if (!process.stdout.isTTY || !process.stdin.isTTY) return;
		try { process.stdout.write(FOCUS_ENABLE); } catch { return; }
		let buf = "";
		const listener = (chunk: Buffer) => {
			try {
				const { events, rest } = feedFocusBytes(buf, chunk.toString("binary"));
				buf = rest;
				for (const ev of events) {
					if (ev === "out") {
						focusedAway = true;
					} else {
						// focus-in: user is back on this pane
						focusedAway = false;
						if (hasUnread) setIdle();
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
		setIdle();
		logLine(rt.statusKey, "info", `[${hhmm()}] pi session started`);
		attachFocusReporting();
	});

	pi.on("session_shutdown", () => {
		if (!cmuxAvailable()) return;
		detachFocusReporting();
		clearProgress();
		clearStatus(rt.statusKey);
	});

	// ── User input + agent start → bolt ────────────────────────────────
	pi.on("input", (event) => {
		if (!cmuxAvailable()) return;
		if (event.source !== "interactive" && event.source !== "rpc") return;
		const text = (event.text || "").trim();
		if (!text) return;
		if (text.startsWith("/")) return;
		setWorking();
	});

	pi.on("before_agent_start", () => {
		if (!cmuxAvailable()) return;
		setWorking();
	});

	// ── Agent end → idle or unread ─────────────────────────────────────
	pi.on("agent_end", () => {
		if (!cmuxAvailable()) return;
		clearProgress();
		// If the user is in another pane, mark as unread so they can spot
		// which sessions finished while they were elsewhere. If they're
		// already watching, go straight to idle — no need to flag it.
		if (focusedAway) {
			setUnread();
		} else {
			setIdle();
		}
		logLine(rt.statusKey, "success", `[${hhmm()}] Response complete`);
	});

	// ── Inter-extension attention events ────────────────────────────────
	pi.events.on("user_attention_requested", (data: unknown) => {
		if (!cmuxAvailable()) return;
		const payload = data as { title?: string } | undefined;
		setAttention(payload?.title ?? "Needs your input");
	});

	pi.events.on("user_attention_resolved", () => {
		if (!cmuxAvailable()) return;
		setWorking();
	});
}

export { resolveStatusKey } from "./config.js";
export {
	buildLogArgs,
	buildNotifyArgs,
	buildSetStatusArgs,
	cmuxAvailable,
	hhmm,
} from "./cmux.js";
