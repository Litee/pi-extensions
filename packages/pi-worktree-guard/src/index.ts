/**
 * pi-worktree-guard
 *
 * Intercepts `edit` and `write` tool_call events. When the target file is in
 * the main repository (not inside a `.worktrees/` subdirectory), the tool call
 * is blocked and a clear instruction is returned to the LLM telling it to work
 * inside a git worktree instead.
 *
 * Detection is done via `git worktree list --porcelain`. The main worktree
 * path is cached after the first successful detection to avoid redundant
 * subprocess calls. Fails open: when git is unavailable or the directory is
 * not a git repo, all tool calls are allowed through.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

import { detectMainWorktree, isInMainRepo } from "./worktree.js";

/**
 * Builds the block reason message shown to the LLM when it tries to edit
 * a file in the main repository.
 */
export function buildBlockReason(filePath: string, mainRoot: string): string {
	return [
		"⛔ WORKTREE GUARD: Direct edits to the main repository are blocked.",
		"",
		`Attempted to edit: ${filePath}`,
		`Main repository:   ${mainRoot}`,
		"",
		"You MUST make all changes inside a git worktree, never in the main repository.",
		"",
		"To create a new worktree:",
		"  git worktree add .worktrees/<branch-name> -b <branch-name>",
		"",
		"Then work inside:",
		"  .worktrees/<branch-name>/",
		"",
		"To list existing worktrees:",
		"  git worktree list",
	].join("\n");
}

export default function worktreeGuard(pi: ExtensionAPI): void {
	// Per-instance cache — reset to undefined on session_start.
	let mainWorktreePath: string | null | undefined = undefined;
	// Reset cache on session start so a reload picks up any repo changes.
	pi.on("session_start", () => {
		mainWorktreePath = undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		// Only intercept edit and write
		if (
			!isToolCallEventType("edit", event) &&
			!isToolCallEventType("write", event)
		) {
			return undefined;
		}

		// Detect main worktree on first call
		if (mainWorktreePath === undefined) {
			const detected = await detectMainWorktree(
				(cmd, args, opts) => pi.exec(cmd, args, opts),
				ctx.cwd,
			);
			mainWorktreePath = detected ?? null;
		}

		// Fail open when detection failed
		if (mainWorktreePath === null) {
			return undefined;
		}

		const filePath = event.input.path;
		if (typeof filePath !== "string") {
			return undefined;
		}

		if (isInMainRepo(filePath, ctx.cwd, mainWorktreePath)) {
			return { block: true, reason: buildBlockReason(filePath, mainWorktreePath) };
		}

		return undefined;
	});
}
