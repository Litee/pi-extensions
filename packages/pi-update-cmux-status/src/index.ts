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
 */
export const RENAMED_ENTRY_TYPE = "cmux-status-renamed";

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
 * Return `true` when a prior valid `cmux-status-renamed` marker is
 * present in the session entry log. A valid marker has `data.savedAt`
 * as a finite number; malformed or foreign entries are skipped.
 */
function wasAlreadyRenamedThisSession(entries: {
	getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }>;
}): boolean {
	if (typeof entries.getEntries !== "function") return false;
	const list = entries.getEntries();
	for (let i = list.length - 1; i >= 0; i--) {
		const e = list[i];
		if (!e || e.type !== "custom" || e.customType !== RENAMED_ENTRY_TYPE) {
			continue;
		}
		const data = e.data as { savedAt?: unknown } | undefined | null;
		if (!data || typeof data !== "object") continue;
		if (typeof data.savedAt !== "number" || !Number.isFinite(data.savedAt)) {
			continue;
		}
		return true;
	}
	return false;
}

/**
 * Safe wrapper around `pi.appendEntry` so persistence failures never break
 * the rename flow.
 */
function persistRenamed(
	pi: Pick<ExtensionAPI, "appendEntry">,
): void {
	try {
		pi.appendEntry(RENAMED_ENTRY_TYPE, {
			savedAt: Date.now(),
		});
	} catch (err) {
		// eslint-disable-next-line no-console
		console.warn("[cmux-status] appendEntry failed:", err);
	}
}


/**
 * Prefix that gates the auto-rename of the cmux workspace. See
 * pi-update-cmux-status#0003.
 *
 * The workspace is renamed only when its current title starts with
 * `RENAME_PREFIX_WORKSPACE` — cmux's own default for a fresh workspace
 * (`Terminal <N>`). A workspace the user has already renamed by hand
 * is left alone.
 *
 * The gate fails open: when the current title cannot be determined
 * (cmux unavailable, RPC error, malformed JSON, 3-second timeout), we
 * fall back to renaming unconditionally.
 *
 * Tab renaming was removed in #0003 per user request — the extension
 * never touches the cmux tab title any more.
 */
const RENAME_PREFIX_WORKSPACE = "Terminal ";

/**
 * Dispatches a workspace rename: calls the LLM, then (when the call
 * succeeds) asks cmux to rename the current workspace. The LLM stage
 * is separated out in the source .ts so tests can swap it.
 *
 * Returns `true` once a decision has been made — whether or not a
 * rename was dispatched (the prefix gate may have suppressed it).
 * Returns `false` only when no decision was possible: cmux not
 * available, or the LLM names call failed.
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
		/** Override the names source — tests pass a stub resolving to canned names. */
		fetchNames?: (ctx: NamesContext, prompt: string) => Promise<Awaited<ReturnType<typeof generateNames>>>;
	},
): Promise<boolean> {
	if (!cmuxAvailable()) return false;
	const fetch = opts.fetchNames ?? fetchNamesOverride ?? generateNames;
	const names = await fetch(ctx, prompt);
	if (!names) return false;

	// Prefix gate (#0003). Only rename when the current workspace title
	// still starts with cmux's default `Terminal ` prefix — if the user
	// has already renamed it, leave it alone. Fails open on RPC errors.
	let doWorkspace = opts.renameWorkspace;
	if (doWorkspace && !opts.skipPrefixGate) {
		const wsTitle = await readWorkspaceTitle();
		if (wsTitle !== null && !wsTitle.startsWith(RENAME_PREFIX_WORKSPACE)) {
			doWorkspace = false;
		}
	}

	if (doWorkspace) {
		renameWorkspace(names.workspace);
		logLine(opts.statusKey, "info", `Renamed workspace → "${names.workspace}"`);
	} else {
		logLine(
			opts.statusKey,
			"info",
			opts.renameWorkspace
				? "Skipped workspace rename: title looks user-set (#0003)"
				: "Skipped workspace rename: PI_CMUX_RENAME_WORKSPACE is off",
		);
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
		// Rehydrate persistent once-per-session flag from the session log so
		// a `/reload` does not re-trigger auto-rename. See RENAMED_ENTRY_TYPE.
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
		rt.namedThisSession = true;
		// Fire-and-forget — don't block input processing on the LLM call.
		void (async () => {
			const ok = await runRename(ctx as unknown as NamesContext, text, {
				statusKey: rt.statusKey,
				renameWorkspace: rt.renameWorkspace,
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
