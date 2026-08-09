/**
 * pi-herdr-integration — auto-syncs the herdr workspace label to the pi
 * session display name.
 *
 * Triggers:
 *   - `session_start` (startup, resume, reload, fork): reset guards, attempt
 *     an immediate rename if the session has a name.
 *   - `session_info_changed` (pi >= 0.80.3): rename immediately when the session
 *     display name is set via `/name`, RPC, or `pi.setSessionName()` — no
 *     waiting for the next turn.
 *   - `agent_end`: fallback that checks whether the session name changed since
 *     the last successful rename; catches any name change that bypasses
 *     `session_info_changed`.
 *     NOTE: the `input` event does NOT fire for built-in commands like `/name`
 *     (they are handled at the TUI layer before extension routing). Registering
 *     an extension command called "name" conflicts with the built-in and is
 *     also skipped. `agent_end` is therefore the reliable fallback hook for
 *     turn-boundary updates.
 *   - `/name-session-and-space <label>` command: sets the pi session name AND
 *     immediately renames the herdr workspace in the same keystroke — no waiting
 *     for the next turn. When called WITHOUT arguments, the extension uses the
 *     active LLM to generate a short (≤ 5 lowercase words) session name from
 *     the recent conversation transcript.
 *
 * Failure backoff: when a rename fails (workspace unresolvable or herdr CLI
 * error), the attempted name is recorded in `lastAttemptedName`. Subsequent
 * events with the same name are silently skipped, preventing repeated CLI
 * calls and warning toasts. A retry fires when the session name changes, or
 * when `session_start` fires (which always resets `lastAttemptedName`).
 *
 * Outside herdr (`HERDR_ENV !== "1"`), the extension registers nothing — no
 * command, no event handlers — so it is completely invisible to pi.
 */

import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isInsideHerdr, renameWorkspace, resolveWorkspaceId } from "./herdr.js";
import type { ExecFn } from "./herdr.js";
import { buildTranscript, generateSessionName } from "./name-generation.js";
import { STATE_CUSTOM_TYPE } from "./state.js";

/**
 * Subagent sessions get auto-generated names in the form `<agent>#<hex>`,
 * e.g. `andrey-implementer#763834d1`. These are internal identifiers, not
 * human-chosen labels, and must not be written to the herdr workspace title.
 * Subagents run inside the same herdr pane as the parent agent, so renaming
 * would clobber the workspace label set by the parent session.
 */
const SUBAGENT_NAME_RE = /^[\w-]+#[0-9a-f]{6,}$/i;

export default function createExtension(pi: ExtensionAPI): void {
	// Everything this extension does requires herdr. Outside herdr, register
	// nothing — no command, no handlers — so /name-session-and-space does not
	// appear in pi's command palette and no inert event handlers run.
	if (!isInsideHerdr(process.env)) return;

	/** The most recently successfully applied name — guards against re-renaming. */
	let lastAppliedName: string | undefined;
	/**
	 * The most recently attempted name (set before any async work). When a
	 * rename fails, subsequent calls with the same name are silently skipped
	 * until the name changes or `session_start` resets this to `undefined`.
	 */
	let lastAttemptedName: string | undefined;

	/**
	 * Build an ExecFn that delegates to pi.exec.
	 * This thin wrapper keeps the herdr helpers decoupled from pi types.
	 */
	const execFn: ExecFn = (cmd, args, opts) => pi.exec(cmd, args, opts);

	/**
	 * Core rename logic. Idempotent: bails out if already applied,
	 * not inside herdr, name is falsy, or workspace cannot be resolved.
	 * Pass `opts.force = true` to bypass the `lastAttemptedName` backoff guard
	 * (used by the explicit command handler so a user can retry a failed rename).
	 */
	async function tryRenameWithName(
		name: string,
		ctx: ExtensionContext,
		opts?: { force?: boolean },
	): Promise<void> {
		if (!name) return;
		if (SUBAGENT_NAME_RE.test(name)) return;
		if (name === lastAppliedName) return;
		if (!opts?.force && name === lastAttemptedName) return;
		lastAttemptedName = name;

		const workspaceId = await resolveWorkspaceId(execFn, process.env);
		if (workspaceId === null) {
			ctx.ui.notify(
				"pi-herdr-integration: could not resolve herdr workspace — will retry when name changes",
				"warning",
			);
			return;
		}

		const renameResult = await renameWorkspace(execFn, workspaceId, name);
		if (!renameResult.ok) {
			ctx.ui.notify(
				`pi-herdr-integration: rename failed — ${renameResult.reason} — will retry when name changes`,
				"warning",
			);
			return;
		}

		// Success — persist state and log a low-key info notification in the pi TUI.
		lastAppliedName = name;
		pi.appendEntry(STATE_CUSTOM_TYPE, {
			lastAppliedName,
			herdrWorkspaceId: workspaceId,
			appliedAt: Date.now(),
		});
		ctx.ui.notify(`herdr workspace renamed to "${name}"`, "info");
	}

	/**
	 * Set the pi session name and rename herdr, forcing a fresh attempt past the
	 * failure backoff. `lastAttemptedName` is armed BEFORE `setSessionName`:
	 * on pi >= 0.80.3 the call synchronously emits `session_info_changed`, whose
	 * handler would otherwise race this rename with a duplicate herdr CLI call.
	 * The guard makes that handler no-op; the forced rename below is the single
	 * attempt.
	 */
	async function setSessionNameAndRename(name: string, ctx: ExtensionContext): Promise<void> {
		lastAttemptedName = name;
		pi.setSessionName(name);
		await tryRenameWithName(name, ctx, { force: true });
	}

	// ---- session_start -------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// Reset both guards: every session_start is a new herdr context where
		// the workspace may not be labeled yet (startup, resume, fork, reload).
		// Never restore lastAppliedName from state — we cannot know whether the
		// current herdr workspace already carries the correct label.
		lastAttemptedName = undefined;
		lastAppliedName = undefined;

		const name = pi.getSessionName();
		if (!name) return;
		await tryRenameWithName(name, ctx);
	});

	// ---- agent_end -----------------------------------------------------------

	pi.on("agent_end", async (_event, ctx) => {
		const name = pi.getSessionName();
		if (!name) return;
		await tryRenameWithName(name, ctx);
	});

	// ---- session_info_changed --------------------------------------------------
	// Emitted synchronously when the session display name is set via /name, RPC,
	// or pi.setSessionName(). Renaming here syncs the herdr label immediately
	// instead of waiting for the next agent_end, which stays as a fallback for
	// any name change that bypasses the event.
	pi.on("session_info_changed", async (_event, ctx) => {
		const name = pi.getSessionName();
		if (!name) return;
		await tryRenameWithName(name, ctx);
	});

	/**
	 * Notify via ctx.ui, but swallow stale-context errors silently.
	 * pi's assertActive throws synchronously — .catch() won't catch it,
	 * so we guard the synchronous part in a try/catch.
	 */
	function tryNotify(
		ctx: ExtensionContext,
		message: string,
		level: "info" | "warning" | "error",
	): boolean {
		try {
			ctx.ui.notify(message, level);
			return true;
		} catch {
			// ctx is stale — session was replaced/reloaded. Silent no-op.
			return false;
		}
	}

	// ---- /name-session-and-space command ------------------------------------

	pi.registerCommand("name-session-and-space", {
		description: "Set the pi session name and rename the herdr workspace to match. Call without arguments to auto-generate a name from the conversation.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const name = args.trim();
			if (name) {
				// Explicit name provided — apply it immediately.
				await setSessionNameAndRename(name, ctx);
				return;
			}

			// No args — auto-generate a name from the conversation via LLM.
			// Capture data upfront and fire the call in the background so the
			// handler returns immediately (no blocking the turn).
			if (!ctx.model) {
				ctx.ui.notify("Cannot generate name: no active model.", "warning");
				return;
			}

			const entries = ctx.sessionManager.getBranch();
			if (!entries.length) {
				ctx.ui.notify("Cannot generate name: no conversation yet.", "info");
				return;
			}

			const transcript = buildTranscript(entries);
			if (!transcript.trim()) {
				ctx.ui.notify("Cannot generate name: no meaningful conversation to name.", "info");
				return;
			}

			ctx.ui.notify("Generating session name in background…", "info");

			// Fire-and-forget: capture needed data, then run asynchronously.
			// Guard against stale ctx — pi throws synchronously from
			// assertActive before the async body, so .catch() won't help.
			void (async () => {
				const controller = new AbortController();
				try {
					const generated = await generateSessionName(transcript, { completeSimple, ctx }, controller.signal);
					if (!generated) {
						if (tryNotify(ctx, "Name generation returned empty — the model may have declined.", "warning")) return;
						return;
					}

					await setSessionNameAndRename(generated, ctx);
					tryNotify(ctx, `Session name set to "${generated}"`, "info");
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					tryNotify(ctx, `Name generation failed: ${message}`, "warning");
				} finally {
					controller.abort();
				}
			})();
		},
	});
}
