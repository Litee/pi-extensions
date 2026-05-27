/**
 * Git repository watcher.
 *
 * Watches `.git/index` and `.git/HEAD` for each worktree so the UI can
 * refresh automatically when files are staged, committed, or checked out.
 *
 * For linked worktrees the `.git` entry is a *file* (not a directory) whose
 * content is `gitdir: <absolute-path>`.  We resolve that path and watch the
 * real gitdir instead.
 */
import { watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface WatcherHandle {
	stop: () => void;
}

/**
 * Start watching git state for `worktreePaths`.
 *
 * @param worktreePaths  Absolute paths to every worktree to watch.
 * @param onChange       Called with the worktree path that changed.
 * @returns              Handle whose `stop()` tears down all watchers.
 */
export async function watchWorktrees(
	worktreePaths: string[],
	onChange: (worktreePath: string) => void,
): Promise<WatcherHandle> {
	const watchers: FSWatcher[] = [];

	for (const wtPath of worktreePaths) {
		const gitdir = await resolveGitdir(wtPath);
		if (!gitdir) continue;

		for (const target of ["index", "HEAD"]) {
			const fullPath = join(gitdir, target);
			try {
				const watcher = watch(fullPath, () => onChange(wtPath));
				watcher.on("error", () => {
					/* silently ignore watch errors */
				});
				watchers.push(watcher);
			} catch {
				/* file may not exist yet — skip */
			}
		}
	}

	return {
		stop() {
			for (const w of watchers) {
				try {
					w.close();
				} catch {
					/* ignore */
				}
			}
			watchers.length = 0;
		},
	};
}

/**
 * Resolve the actual `.git` directory for a worktree.
 *
 * - Main worktree:   `<root>/.git`  is a **directory** → return it as-is.
 * - Linked worktree: `<root>/.git`  is a **file**      → parse and return the
 *                    `gitdir:` path inside it.
 */
async function resolveGitdir(worktreePath: string): Promise<string | null> {
	const gitPath = join(worktreePath, ".git");

	let info;
	try {
		info = await stat(gitPath);
	} catch {
		return null;
	}

	if (info.isDirectory()) {
		return gitPath;
	}

	// Linked worktree: .git is a file like "gitdir: /abs/path/.git/worktrees/name"
	try {
		const content = await readFile(gitPath, "utf8");
		const m = /^gitdir:\s*(.+)$/m.exec(content.trim());
		if (m && m[1]) {
			return resolve(worktreePath, m[1].trim());
		}
	} catch {
		/* fall through */
	}

	return null;
}
