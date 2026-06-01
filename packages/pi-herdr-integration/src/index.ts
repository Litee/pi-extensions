/**
 * pi-herdr-integration — auto-syncs the herdr workspace label to the pi
 * session display name.
 *
 * Triggers:
 *   - `session_start` (startup, resume, reload, fork): restore persisted state
 *     then attempt rename if the session has a name.
 *   - `agent_end`: check whether the session name changed since the last
 *     successful rename (catches `/name` and any other way the name can be
 *     set, e.g. pi.setSessionName() from another extension or RPC).
 *     NOTE: the `input` event does NOT fire for built-in commands like `/name`
 *     (they are handled at the TUI layer before extension routing). Registering
 *     an extension command called "name" conflicts with the built-in and is
 *     also skipped. `agent_end` is therefore the only reliable hook.
 *
 * Failure backoff: when a rename fails (workspace unresolvable or herdr CLI
 * error), the attempted name is recorded in `lastAttemptedName`. Subsequent
 * events with the same name are silently skipped, preventing repeated CLI
 * calls and warning toasts. A retry fires when the session name changes, or
 * when `session_start` fires (which always resets `lastAttemptedName`).
 *
 * No-op when `HERDR_ENV !== "1"` (not running inside herdr).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isInsideHerdr, renameWorkspace, resolveWorkspaceId } from "./herdr.js";
import type { ExecFn } from "./herdr.js";
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
	 */
	async function tryRenameWithName(
		name: string,
		ctx: ExtensionContext,
	): Promise<void> {
		if (!isInsideHerdr(process.env)) return;
		if (!name) return;
		if (SUBAGENT_NAME_RE.test(name)) return;
		if (name === lastAppliedName) return;
		if (name === lastAttemptedName) return;
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

	// ---- session_start -------------------------------------------------------

	pi.on("session_start", async (event, ctx) => {
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
}
