/**
 * pi-update-cmux-status — pi extension.
 *
 * Mirrors pi lifecycle events into cmux (sidebar status pill, desktop
 * notifications) and auto-renames the cmux workspace based on an LLM
 * summary of the first user prompt. Tab renaming was removed in #0003.
 *
 * Simplified two-state status model (#0002): the pill is either
 * `working` (pi is processing a user request) or `idle` (pi is waiting
 * for user input). Per-tool transitions were removed because they
 * flickered the pill across every `bash` / `read` / `edit` inside a
 * single turn without carrying any signal the user could act on.
 *
 *   session_start          → status "idle" + log "Session started"
 *   input (any eligible)   → status "working" (every turn);
 *                             fire-and-forget workspace rename on the
 *                             first eligible prompt of the pi session
 *                             (gated on the `Terminal ` prefix, #0003).
 *   tool_execution_start   → if toolName is in ATTENTION_TOOLS
 *                             (hardcoded), status "waiting" + notify.
 *   tool_execution_end     → if toolName is in ATTENTION_TOOLS,
 *                             status back to "working".
 *   agent_end              → status "idle" + clear-progress + log + notify
 *   session_shutdown       → clear status pill + clear progress
 *
 * Plus a `/cmux-rename` slash command to regenerate the workspace name
 * on demand (bypasses the prefix gate).
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
	renameWorkspace,
	setStatus,
} from "./cmux.js";
import { readWorkspaceTitle } from "./cmuxReader.js";
import { resolveRenameWorkspace, resolveStatusKey } from "./config.js";
import { generateNames, type NamesContext } from "./names.js";
import { buildSessionRenamePrompt, getBranchSafely } from "./sessionPrompt.js";

/**
 * Session-log custom-entry type used to persist the "we already
 * auto-named this pi session" flag. Rehydrated on every `session_start`
 * so a `/reload` inside the same pi session does not silently re-rename
 * a workspace the user has manually renamed after the first auto-name.
 *
 * Payload: `{ savedAt: number }`. A marker-only entry — `/cmux-rename`
 * rebuilds its prompt from the live session branch, so the first prompt
 * is not stored.
 *
 * Naming convention (#0004 follow-up): every session-log entry type
 * owned by this extension is prefixed with the full package name
 * (`pi-update-cmux-status-`) so the session log stays self-explanatory
 * and collisions with other extensions are impossible.
 */
export const RENAMED_ENTRY_TYPE = "pi-update-cmux-status-state";

/**
 * Session-log custom-entry types this extension has written in the
 * past. Read by `wasAlreadyRenamedThisSession` so a session log that
 * was populated by an older build still short-circuits on `/reload`.
 * Write-side ALWAYS uses `RENAMED_ENTRY_TYPE`.
 */
export const LEGACY_RENAMED_ENTRY_TYPES: readonly string[] = [
	"cmux-status-renamed",
];

/**
 * Rehydrates the once-per-session rename flag from the pi session log.
 * Called from `session_start` so `/reload` picks up the persisted
 * marker and skips both the prefix gate and the LLM call on the first
 * eligible user message.
 *
 * Returns `true` when the session log has at least one
 * `RENAMED_ENTRY_TYPE` custom entry. Tolerant of missing/unsupported
 * sessionManager shapes (returns `false` in that case).
 */
export function wasAlreadyRenamedThisSession(
	sessionManager: {
		getEntries?: () => Array<{
			type?: string;
			customType?: string;
			data?: unknown;
		}>;
	} | undefined | null,
): boolean {
	if (!sessionManager || typeof sessionManager.getEntries !== "function") return false;
	try {
		const entries = sessionManager.getEntries() ?? [];
		for (const e of entries) {
			if (e?.type !== "custom") continue;
			const t = e.customType;
			if (t === RENAMED_ENTRY_TYPE) return true;
			if (t !== undefined && LEGACY_RENAMED_ENTRY_TYPES.includes(t)) return true;
		}
		return false;
	} catch {
		return false;
	}
}

/**
 * Writes the `RENAMED_ENTRY_TYPE` marker to the pi session log. Called
 * after a decision has been made about the workspace title — either a
 * rename was dispatched, or the gate confirmed the title already looks
 * user-set. Future messages (and `/reload`s within the same pi session)
 * will then short-circuit before the prefix gate. The call is
 * best-effort — any throw is swallowed so a session-log failure does
 * not crash the rename dispatch.
 */
export function persistRenamed(
	pi: {
		appendEntry?: (customType: string, data: unknown) => void;
	},
): void {
	try {
		pi.appendEntry?.(RENAMED_ENTRY_TYPE, { savedAt: Date.now() });
	} catch (err) {
		// eslint-disable-next-line no-console
		console.warn("[cmux-status] persistRenamed failed:", err);
	}
}
/**
 * Tool names that should flip the pill to `waiting` and fire a desktop
 * notification when invoked by any extension (#0002).
 *
 * Hardcoded — adding to this list is a source edit, not a config knob.
 * Currently only the `ask_user_question` tool from the sibling
 * `pi-ask-user-question` extension qualifies: it blocks the agent
 * waiting on the user, which is exactly the state a user sitting in
 * another tab needs to be pinged about.
 */
const ATTENTION_TOOLS: readonly string[] = ["ask_user_question"];

/**
 * Test-only hook. When set, `input` and `/cmux-rename` call sites use this
 * instead of `generateNames` so tests can inject canned names and assert
 * side effects (e.g. `pi.appendEntry`) without spinning up a real model.
 * Cleared by passing `null`.
 */
let fetchNamesOverride:
	| ((
			ctx: NamesContext,
			prompt: string,
	  ) => Promise<Awaited<ReturnType<typeof generateNames>>>)
	| null = null;

export function __setFetchNamesForTests(
	fn:
		| ((
				ctx: NamesContext,
				prompt: string,
		  ) => Promise<Awaited<ReturnType<typeof generateNames>>>)
		| null,
): void {
	fetchNamesOverride = fn;
}


/**
 * Prefix that gates the auto-rename of the cmux workspace. See
 * pi-update-cmux-status#0003 and #0004.
 *
 * The workspace is renamed only when its current title starts with
 * `RENAME_PREFIX_WORKSPACE` — cmux's own default for a fresh workspace
 * (`Terminal <N>`). A workspace the user has already renamed by hand
 * is left alone.
 *
 * Since #0004 the gate **fails closed**: when the current title cannot
 * be determined (cmux unavailable, RPC error, malformed JSON, 3-second
 * timeout, or empty title), the rename is skipped for this turn and
 * retried on the next user message — the LLM call is now gated BEHIND
 * the prefix check, so skipping costs nothing. The pre-#0004 fail-open
 * policy existed because the LLM call had already been paid for before
 * the gate ran; reordering made fail-open unnecessary.
 *
 * Tab renaming was removed in #0003 per user request — the extension
 * never touches the cmux tab title any more.
 */
const RENAME_PREFIX_WORKSPACE = "Terminal ";

/**
 * Dispatches a workspace rename with the following order (reversed in
 * #0004):
 *
 *   cmuxAvailable()  →  prefix gate (cmux RPC)  →  fetchNames (LLM)  →  dispatch
 *
 * The prefix gate runs BEFORE the LLM call, so a workspace the user has
 * already renamed (or whose title cannot be read) never pays for a
 * completion. See pi-update-cmux-status#0004.
 *
 * When `opts.runtime` is supplied, `runRename` manages
 * `runtime.namedThisSession` itself. The flag is a session-scoped
 * cache; the caller is responsible for persisting the decision via
 * `persistRenamed(pi)` when `runRename` returns `true` (see the input
 * handler and the `/cmux-rename` command).
 *
 * - Gate returns null (fail-closed): flag reset to `false`, return
 *   `false` → next message retries (no persist).
 * - Gate returns a user-set title: flag stays `true`, return `true` →
 *   caller persists so `/reload` skips the gate entirely next time.
 * - Gate passes → flag already `true` (reserved synchronously by the
 *   caller, see input handler); on LLM failure reset to `false`,
 *   return `false` (no persist).
 * - Dispatch succeeds → flag stays `true`, return `true` → caller
 *   persists.
 *
 * When `opts.runtime` is not supplied, no flag is touched.
 *
 * Returns `true` once a decision has been made — whether or not a
 * rename was actually dispatched (the prefix gate may have suppressed
 * it). Returns `false` only when no decision was possible: cmux not
 * available, the prefix gate read failed (fail-closed), or the LLM
 * names call failed.
 */
export async function runRename(
	ctx: NamesContext,
	prompt: string,
	opts: {
		statusKey: string;
		/**
		 * Caller-supplied toggle mirroring the `PI_CMUX_RENAME_WORKSPACE`
		 * env var. When false, `runRename` returns a decision of "do
		 * nothing" without asking cmux or the LLM to rename anything.
		 * Kept for symmetry with the pre-#0003 runtime config; today's
		 * extension only has one rename target.
		 */
		renameWorkspace: boolean;
		/**
		 * When true, bypass the prefix gate and rename unconditionally.
		 * Used by the manual `/cmux-rename` command, where the user has
		 * explicitly asked for a rename.
		 */
		skipPrefixGate?: boolean;
		/**
		 * Optional runtime record whose `namedThisSession` flag should be
		 * managed by this call. See the JSDoc above for the full
		 * set/reset rules. When omitted (the default for pre-#0004
		 * tests), no flag is touched.
		 */
		runtime?: { namedThisSession: boolean };
		/** Override the names source — tests pass a stub resolving to canned names. */
		fetchNames?: (ctx: NamesContext, prompt: string) => Promise<Awaited<ReturnType<typeof generateNames>>>;
	},
): Promise<boolean> {
	if (!cmuxAvailable()) {
		if (opts.runtime) opts.runtime.namedThisSession = false;
		return false;
	}

	// Prefix gate (#0003) — now runs BEFORE the LLM call (#0004). Only
	// rename when the current workspace title still starts with cmux's
	// default `Terminal ` prefix. Fails CLOSED (#0004): a null read skips
	// the turn without paying for a completion and retries next message.
	if (opts.renameWorkspace && !opts.skipPrefixGate) {
		const wsTitle = await readWorkspaceTitle();
		if (wsTitle === null) {
			logLine(
				opts.statusKey,
				"info",
				"Skipped workspace rename: could not read current workspace title (#0004); will retry next message",
			);
			if (opts.runtime) opts.runtime.namedThisSession = false;
			return false;
		}
		if (!wsTitle.startsWith(RENAME_PREFIX_WORKSPACE)) {
			logLine(
				opts.statusKey,
				"info",
				"Skipped workspace rename: title looks user-set (#0003)",
			);
			// Keep runtime.namedThisSession = true so the caller persists
			// the marker — /reload should then skip both the gate and the
			// LLM call for the rest of this pi session (#0004).
			return true;
		}
	}

	// Gate passed (or was bypassed by `skipPrefixGate`). Reserve the
	// flag here too (the input handler already reserves it before
	// firing the IIFE to close the back-to-back race, but callers that
	// hit runRename directly — /cmux-rename, unit tests — rely on
	// runRename to do the reservation itself).
	if (opts.runtime) opts.runtime.namedThisSession = true;

	const fetch = opts.fetchNames ?? fetchNamesOverride ?? generateNames;
	const names = await fetch(ctx, prompt);
	if (!names) {
		// LLM failed — release the slot so the next message retries.
		if (opts.runtime) opts.runtime.namedThisSession = false;
		return false;
	}

	if (opts.renameWorkspace) {
		renameWorkspace(names.workspace);
		logLine(opts.statusKey, "info", `Renamed workspace → "${names.workspace}"`);
	} else {
		logLine(
			opts.statusKey,
			"info",
			"Skipped workspace rename: PI_CMUX_RENAME_WORKSPACE is off",
		);
		// runtime.namedThisSession stays `true` so the caller persists
		// the marker and subsequent messages (plus `/reload`) short-
		// circuit without paying for another LLM completion. Flipping
		// `PI_CMUX_RENAME_WORKSPACE` back on mid-session requires a
		// fresh pi session today.
	}
	return true;
}

/**
 * Per-session mutable state. Kept in a record so tests can inspect it
 * after invoking the default export.
 */
export interface Runtime {
	/** Sidebar status pill key (usually "pi"). */
	statusKey: string;
	/** Whether the extension renames the workspace at all (`PI_CMUX_RENAME_WORKSPACE`). */
	renameWorkspace: boolean;
	/** Has the one-shot auto-rename fired this session yet? */
	namedThisSession: boolean;
}

function makeRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
	return {
		statusKey: resolveStatusKey(env),
		renameWorkspace: resolveRenameWorkspace(env),
		namedThisSession: false,
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
	pi.on("session_start", async (_event, ctx) => {
		rt.namedThisSession = false;
		// #0004: rehydrate the once-per-session flag from the pi session
		// log so `/reload` inside the same pi session skips both the
		// prefix gate (cmux RPC) and the LLM call on the first eligible
		// user message. The marker is written after any gate-reached
		// decision (successful rename OR "title looks user-set, skip"),
		// so a reloaded session only re-checks when a prior session
		// never got that far.
		try {
			const sm = (ctx as ExtensionContext | undefined)?.sessionManager;
			if (sm) {
				rt.namedThisSession = wasAlreadyRenamedThisSession(
					sm as unknown as {
						getEntries?: () => Array<{
							type?: string;
							customType?: string;
							data?: unknown;
						}>;
					},
				);
			}
		} catch (err) {
			// eslint-disable-next-line no-console
			console.warn("[cmux-status] session-start rehydrate failed:", err);
		}
		if (!cmuxAvailable()) return;
		setStatus(rt.statusKey, "idle", "checkmark", "#30d158");
		logLine(rt.statusKey, "info", `[${hhmm()}] pi session started`);
	});

	pi.on("session_shutdown", async () => {
		if (!cmuxAvailable()) return;
		clearProgress();
		clearStatus(rt.statusKey);
	});

	// ── User input → auto-rename once per pi session ───────────────────
	pi.on("input", async (event, ctx) => {
		if (!cmuxAvailable()) return;
		if (event.source !== "interactive" && event.source !== "rpc") return;
		const text = (event.text || "").trim();
		if (!text) return;
		if (text.startsWith("/")) return; // slash commands
		// Every eligible user message flips the pill to 'working' so the user
		// gets immediate feedback that pi has accepted their turn. The pill
		// stays 'working' across all tool calls in this turn and only returns
		// to 'idle' on `agent_end` (#0002 — supersedes the old per-tool pill
		// transitions driven by `before_agent_start` + `tool_execution_*`).
		setStatus(rt.statusKey, "working", "bolt", "#ff9500");
		if (rt.namedThisSession) return;
		// Reserve the slot synchronously-before-IIFE so two back-to-back
		// input events cannot both kick off a rename. runRename also
		// manages the flag internally — see its JSDoc for the full
		// set/reset rules under gate-pass / gate-fail / LLM-fail. On any
		// `true` return (rename dispatched OR gate skipped because title
		// looks user-set), persist the marker so a later `/reload` skips
		// both the cmux RPC and the LLM call on its first eligible input.
		rt.namedThisSession = true;
		// Fire-and-forget — don't block input processing on the LLM call.
		void (async () => {
			const ok = await runRename(ctx as unknown as NamesContext, text, {
				statusKey: rt.statusKey,
				renameWorkspace: rt.renameWorkspace,
				runtime: rt,
			});
			if (ok) persistRenamed(pi);
		})();
	});

	// ── Agent run lifecycle ────────────────────────────────────────────
	// Agent run lifecycle. Only `agent_end` remains — `before_agent_start`
	// was removed in #0002 (pill-to-working now happens from `input`).
	pi.on("agent_end", async () => {
		if (!cmuxAvailable()) return;
		clearProgress();
		setStatus(rt.statusKey, "idle", "checkmark", "#30d158");
		logLine(rt.statusKey, "success", `[${hhmm()}] Response complete`);
		notifyCmux("pi", shortCwd(process.cwd()), `[${hhmm()}] Response complete`);
	});

	// Attention tools (hardcoded). When a tool named in `ATTENTION_TOOLS`
	// starts, the pill flips to `waiting` (bell, cyan) and a desktop
	// notification fires so a user in another tab sees pi needs them.
	// On end, the pill reverts to `working`. Tools outside the list are
	// ignored so the noise-free two-state default from #0002 still holds
	// for bash / read / edit / etc.
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

	// ── Manual rename command ──────────────────────────────────────────
	pi.registerCommand("cmux-rename", {
		description:
			"Regenerate the cmux workspace name from the current session log",
		handler: async (_args, ctx) => {
			const ui = (ctx as ExtensionContext).ui;
			if (!cmuxAvailable()) {
				ui.notify("Not running inside cmux (no CMUX_WORKSPACE_ID).", "warning");
				return;
			}
			const entries = getBranchSafely(
				(ctx as ExtensionContext | undefined)?.sessionManager,
			);
			const prompt = buildSessionRenamePrompt(entries);
			if (!prompt) {
				ui.notify(
					"No user prompts in the session log yet — send a message first, then run '/cmux-rename'.",
					"warning",
				);
				return;
			}
			ui.notify("Renaming cmux workspace…", "info");
			rt.namedThisSession = true;
			const ok = await runRename(ctx as unknown as NamesContext, prompt, {
				statusKey: rt.statusKey,
				renameWorkspace: rt.renameWorkspace,
				skipPrefixGate: true,
				runtime: rt,
			});
			if (!ok) {
				ui.notify("Rename failed (model call errored).", "error");
			} else {
				persistRenamed(pi);
				ui.notify("Renamed cmux workspace.", "info");
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
	buildRenameWorkspaceArgs,
	buildSetStatusArgs,
	cmuxAvailable,
	hhmm,
} from "./cmux.js";
