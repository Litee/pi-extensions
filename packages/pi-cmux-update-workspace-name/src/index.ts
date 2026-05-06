/**
 * pi-cmux-update-workspace-name — pi extension.
 *
 * Auto-renames the cmux workspace once per pi session based on an LLM
 * summary of the first user prompt. Split out of the old
 * `pi-update-cmux-status` package so the rename half and the sidebar
 * status-pill mirror can be installed independently (see the sibling
 * `pi-cmux-notifications` package for the status half).
 *
 *   session_start          → rehydrate the once-per-session rename flag
 *                             from the pi session log so `/reload`
 *                             skips both the prefix gate and the LLM
 *                             call when a previous session already
 *                             reached a decision.
 *   input (first eligible) → fire-and-forget LLM rename dispatch. Only
 *                             actually renames when the current
 *                             workspace title still starts with cmux's
 *                             default `Terminal ` prefix (fail-closed).
 *   /cmux-rename           → manual command that bypasses the prefix
 *                             gate and rebuilds the summariser prompt
 *                             from the full session branch.
 *
 * All cmux calls are no-ops when not running inside cmux (see
 * `cmuxAvailable`), so loading this extension in a plain terminal is safe.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { cmuxAvailable, logLine, renameWorkspace } from "./cmux.js";
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
 * Naming convention: prefixed with the full package name so the session
 * log stays self-explanatory and collisions with other extensions are
 * impossible.
 */
export const RENAMED_ENTRY_TYPE = "pi-cmux-update-workspace-name-state";

/**
 * Session-log custom-entry types this extension (or its ancestor
 * `pi-update-cmux-status`) has written in the past. Read by
 * `wasAlreadyRenamedThisSession` so a session log that was populated by
 * an older build still short-circuits on `/reload`. Write-side ALWAYS
 * uses `RENAMED_ENTRY_TYPE`.
 */
export const LEGACY_RENAMED_ENTRY_TYPES: readonly string[] = [
	"pi-update-cmux-status-state",
	"cmux-status-renamed",
];

/**
 * Rehydrates the once-per-session rename flag from the pi session log.
 * Called from `session_start` so `/reload` picks up the persisted
 * marker and skips both the prefix gate and the LLM call on the first
 * eligible user message.
 *
 * Returns `true` when the session log has at least one
 * `RENAMED_ENTRY_TYPE` (or legacy) custom entry. Tolerant of missing /
 * unsupported sessionManager shapes (returns `false` in that case).
 */
export function wasAlreadyRenamedThisSession(
	sessionManager:
		| {
				getEntries?: () => Array<{
					type?: string;
					customType?: string;
					data?: unknown;
				}>;
		  }
		| undefined
		| null,
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
 * user-set. Best-effort — any throw is swallowed so a session-log
 * failure does not crash the rename dispatch.
 */
export function persistRenamed(pi: {
	appendEntry?: (customType: string, data: unknown) => void;
}): void {
	try {
		pi.appendEntry?.(RENAMED_ENTRY_TYPE, { savedAt: Date.now() });
	} catch (err) {
		// eslint-disable-next-line no-console
		console.warn("[cmux-update-workspace-name] persistRenamed failed:", err);
	}
}

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
 * Prefix that gates the auto-rename of the cmux workspace.
 *
 * The workspace is renamed only when its current title starts with
 * `RENAME_PREFIX_WORKSPACE` — cmux's own default for a fresh workspace
 * (`Terminal <N>`). A workspace the user has already renamed by hand
 * is left alone. The gate fails CLOSED: when the current title cannot
 * be determined, the rename is skipped for this turn and retried on
 * the next user message.
 */
const RENAME_PREFIX_WORKSPACE = "Terminal ";

/**
 * Dispatches a workspace rename with the following order:
 *
 *   cmuxAvailable()  →  prefix gate (cmux RPC)  →  fetchNames (LLM)  →  dispatch
 *
 * The prefix gate runs BEFORE the LLM call, so a workspace the user has
 * already renamed (or whose title cannot be read) never pays for a
 * completion.
 *
 * When `opts.runtime` is supplied, `runRename` manages
 * `runtime.namedThisSession` itself. The flag is a session-scoped
 * cache; the caller is responsible for persisting the decision via
 * `persistRenamed(pi)` when `runRename` returns `true` (see the input
 * handler and the `/cmux-rename` command).
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
		renameWorkspace: boolean;
		skipPrefixGate?: boolean;
		runtime?: { namedThisSession: boolean };
		fetchNames?: (
			ctx: NamesContext,
			prompt: string,
		) => Promise<Awaited<ReturnType<typeof generateNames>>>;
	},
): Promise<boolean> {
	if (!cmuxAvailable()) {
		if (opts.runtime) opts.runtime.namedThisSession = false;
		return false;
	}

	if (opts.renameWorkspace && !opts.skipPrefixGate) {
		const wsTitle = await readWorkspaceTitle();
		if (wsTitle === null) {
			logLine(
				opts.statusKey,
				"info",
				"Skipped workspace rename: could not read current workspace title; will retry next message",
			);
			if (opts.runtime) opts.runtime.namedThisSession = false;
			return false;
		}
		if (!wsTitle.startsWith(RENAME_PREFIX_WORKSPACE)) {
			logLine(
				opts.statusKey,
				"info",
				"Skipped workspace rename: title looks user-set",
			);
			return true;
		}
	}

	if (opts.runtime) opts.runtime.namedThisSession = true;

	const fetch = opts.fetchNames ?? fetchNamesOverride ?? generateNames;
	const names = await fetch(ctx, prompt);
	if (!names) {
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
	}
	return true;
}

/**
 * Per-session mutable state. Kept in a record so tests can inspect it
 * after invoking the default export.
 */
export interface Runtime {
	statusKey: string;
	renameWorkspace: boolean;
	namedThisSession: boolean;
}

function makeRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
	return {
		statusKey: resolveStatusKey(env),
		renameWorkspace: resolveRenameWorkspace(env),
		namedThisSession: false,
	};
}

export default function cmuxUpdateWorkspaceName(pi: ExtensionAPI): void {
	const rt = makeRuntime();

	// ── Session lifecycle ──────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		rt.namedThisSession = false;
		// Rehydrate the once-per-session flag from the pi session log so
		// `/reload` inside the same pi session skips both the prefix
		// gate and the LLM call on the first eligible user message.
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
			console.warn("[cmux-update-workspace-name] session-start rehydrate failed:", err);
		}
	});

	// ── User input → auto-rename once per pi session ───────────────────
	pi.on("input", async (event, ctx) => {
		if (!cmuxAvailable()) return;
		if (event.source !== "interactive" && event.source !== "rpc") return;
		const text = (event.text || "").trim();
		if (!text) return;
		if (text.startsWith("/")) return; // slash commands
		if (rt.namedThisSession) return;
		// Reserve the slot synchronously-before-IIFE so two back-to-back
		// input events cannot both kick off a rename.
		rt.namedThisSession = true;
		void (async () => {
			const ok = await runRename(ctx as unknown as NamesContext, text, {
				statusKey: rt.statusKey,
				renameWorkspace: rt.renameWorkspace,
				runtime: rt,
			});
			if (ok) persistRenamed(pi);
		})();
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
	buildRenameWorkspaceArgs,
	cmuxAvailable,
	hhmm,
} from "./cmux.js";
