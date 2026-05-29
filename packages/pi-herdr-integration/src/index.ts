/**
 * pi-herdr-integration — auto-syncs the herdr workspace label to the pi
 * session display name.
 *
 * Triggers:
 *   - `session_start` (startup, resume, reload, fork): restore persisted state
 *     then attempt rename if the session has a name.
 *   - `input`: intercept the built-in `/name <X>` command and rename
 *     immediately using the matched name (does not wait for pi to process the
 *     command).
 *
 * No-op when `HERDR_ENV !== "1"` (not running inside herdr).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isInsideHerdr, renameWorkspace, resolveWorkspaceId } from "./herdr.js";
import type { ExecFn } from "./herdr.js";
import { STATE_CUSTOM_TYPE, pickLatestState } from "./state.js";
import type { StateCandidateEntry } from "./state.js";

/** Pattern that detects the built-in `/name <X>` command. */
const NAME_COMMAND_RE = /^\s*\/name\s+(\S.*?)\s*$/;

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
	 * Build an ExecFn that delegates to pi.exec.
	 * This thin wrapper keeps the herdr helpers decoupled from pi types.
	 */
	const execFn: ExecFn = (cmd, args, opts) => pi.exec(cmd, args, opts);

	/**
	 * Core rename logic.  Idempotent: bails out if already applied,
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

		const workspaceId = await resolveWorkspaceId(execFn, process.env);
		if (workspaceId === null) {
			ctx.ui.notify(
				"pi-herdr-integration: could not resolve herdr workspace — will retry on next event",
				"warning",
			);
			return;
		}

		const renameResult = await renameWorkspace(execFn, workspaceId, name);
		if (!renameResult.ok) {
			ctx.ui.notify(
				`pi-herdr-integration: rename failed — ${renameResult.reason} (will retry)`,
				"warning",
			);
			return;
		}

		// Success — persist state
		lastAppliedName = name;
		pi.appendEntry(STATE_CUSTOM_TYPE, {
			lastAppliedName,
			herdrWorkspaceId: workspaceId,
			appliedAt: Date.now(),
		});
	}

	// ---- session_start -------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// Restore lastAppliedName from session history (survives /reload and fork).
		const rawEntries = ctx.sessionManager.getEntries() as StateCandidateEntry[];
		const saved = pickLatestState(rawEntries);
		if (saved !== undefined) {
			lastAppliedName = saved.lastAppliedName;
		}

		const name = pi.getSessionName();
		if (!name) return;
		await tryRenameWithName(name, ctx);
	});

	// ---- input: intercept /name <X> -----------------------------------------

	pi.on("input", async (event, ctx) => {
		const match = NAME_COMMAND_RE.exec(event.text);
		if (!match) return undefined;
		const name = match[1] as string;
		await tryRenameWithName(name, ctx);
		return undefined;
	});
}
