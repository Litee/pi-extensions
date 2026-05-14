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
 * Focus tracking (cmux events stream):
 *   Subscribes to `cmux events --reconnect` to watch:
 *   - `workspace.selected` — fires on the newly active workspace;
 *     if workspace_id matches CMUX_WORKSPACE_ID → focus-in, else → focus-out.
 *   - `window.unkeyed` / `window.keyed` — OS-level window focus.
 *   focusedAway = !windowKeyed || !workspaceSelected.
 *   This correctly handles both cmux workspace switches AND app switches,
 *   unlike the old DECSET ?1004 approach which cmux does not forward on
 *   workspace-level switches.
 *
 * All cmux calls are no-ops when not running inside cmux (see
 * `cmuxAvailable`), so loading this extension in a plain terminal is safe.
 *
 * DEBUG: set PI_CMUX_NOTIFY_DEBUG=1 to log focus events and notifyCmux
 * calls to /tmp/pi-cmux-debug.log.
 */

import { appendFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";

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

// ── Debug logging (PI_CMUX_NOTIFY_DEBUG=1) ────────────────────────────────
const DEBUG = process.env["PI_CMUX_NOTIFY_DEBUG"] === "1";
const DEBUG_LOG = "/tmp/pi-cmux-debug.log";
function dbg(msg: string): void {
	if (!DEBUG) return;
	try { appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`); } catch { /* ignore */ }
}

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

	// Focus state — managed by cmux events subscription.
	// windowKeyed:       true while the cmux OS window has keyboard focus.
	// workspaceSelected: true while this workspace is the active one.
	// Both default to true (assume we start in the active, focused workspace).
	let windowKeyed       = true;
	let workspaceSelected = true;
	let hasUnread         = false; // true while pill is in the `unread` state
	let focusChild: ChildProcess | undefined;

	const isFocusedAway = (): boolean => !windowKeyed || !workspaceSelected;

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

	// ── cmux events-based focus tracking ────────────────────────────────
	function attachCmuxFocusTracking(): void {
		if (focusChild) return;
		const myWorkspaceId = process.env["CMUX_WORKSPACE_ID"];
		if (!myWorkspaceId) return;
		try {
			const child = _focusSpawn("cmux", [
				"events", "--reconnect", "--no-heartbeat",
				"--name", "workspace.selected",
				"--name", "window.keyed",
				"--name", "window.unkeyed",
			], { stdio: ["ignore", "pipe", "ignore"] });
			focusChild = child;
			let buf = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				try {
					buf += chunk.toString("utf8");
					const lines = buf.split("\n");
					buf = lines.pop() ?? "";
					for (const line of lines) {
						if (!line.trim()) continue;
						try {
							const ev = JSON.parse(line) as { type?: string; name?: string; workspace_id?: string };
							if (ev.type !== "event") continue;
							const wasAway = isFocusedAway();
							if (ev.name === "workspace.selected") {
								workspaceSelected = ev.workspace_id === myWorkspaceId;
								dbg(`workspace.selected ws=${ev.workspace_id} mine=${myWorkspaceId} → workspaceSelected=${workspaceSelected}`);
							} else if (ev.name === "window.unkeyed") {
								windowKeyed = false;
								dbg(`window.unkeyed → windowKeyed=false`);
							} else if (ev.name === "window.keyed") {
								windowKeyed = true;
								dbg(`window.keyed → windowKeyed=true`);
							}
							const nowAway = isFocusedAway();
							if (wasAway && !nowAway) {
								dbg(`focus-in: hasUnread=${hasUnread}`);
								if (hasUnread) setIdle();
							}
						} catch { /* ignore bad JSON line */ }
					}
				} catch { /* ignore */ }
			});
			child.on("error", () => { focusChild = undefined; });
			child.on("exit", () => { focusChild = undefined; });
		} catch { /* spawn failed — cmux not on PATH */ }
	}

	function detachCmuxFocusTracking(): void {
		try { focusChild?.kill(); } catch { /* noop */ }
		focusChild = undefined;
	}

	// ── Session lifecycle ──────────────────────────────────────────────
	pi.on("session_start", () => {
		if (!cmuxAvailable()) return;
		setIdle();
		logLine(rt.statusKey, "info", `[${hhmm()}] pi session started`);
		dbg(`session_start workspace=${process.env["CMUX_WORKSPACE_ID"]}`);
		attachCmuxFocusTracking();
	});

	pi.on("session_shutdown", () => {
		if (!cmuxAvailable()) return;
		detachCmuxFocusTracking();
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
		dbg(`agent_end: isFocusedAway=${isFocusedAway()} windowKeyed=${windowKeyed} workspaceSelected=${workspaceSelected}`);
		if (isFocusedAway()) {
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
		const label = payload?.title ?? "Needs your input";
		dbg(`need_user_attention: "${label}" → calling notifyCmux`);
		setAttention(label);
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

// ---------------------------------------------------------------------------
// Test seam: allow tests to inject a fake spawn for the focus-tracking child.
// Production code always uses the real `spawn` imported above.
// ---------------------------------------------------------------------------
type SpawnFn = typeof spawn;
let _focusSpawn: SpawnFn = spawn;
export function __setFocusSpawnForTests(s: SpawnFn | null): void {
	_focusSpawn = s ?? spawn;
}
export { _focusSpawn as __focusSpawn };
