import path from "node:path";

/**
 * Returns the absolute path of the main (primary) worktree by running
 * `git worktree list --porcelain` with cwd as the working directory.
 * Returns undefined if git fails or output is unparseable.
 */
export async function detectMainWorktree(
	exec: (
		cmd: string,
		args: string[],
		opts?: { cwd?: string },
	) => Promise<{ code: number; stdout: string }>,
	cwd: string,
): Promise<string | undefined> {
	try {
		const result = await exec("git", ["worktree", "list", "--porcelain"], { cwd });
		if (result.code !== 0) return undefined;
		const match = result.stdout.match(/^worktree (.+)$/m);
		if (!match?.[1]) return undefined;
		return match[1].trim();
	} catch {
		return undefined;
	}
}

/**
 * Returns true when `filePath` is inside the main repo but NOT under its
 * `.worktrees/` subdirectory (meaning it is in the main repo and should be
 * blocked).
 *
 * `filePath` may be absolute or relative (resolved against `cwd`).
 *
 * Returns false (allow) when:
 *   - filePath resolves outside mainRoot entirely
 *   - filePath is inside mainRoot/.worktrees/
 */
export function isInMainRepo(
	filePath: string,
	cwd: string,
	mainRoot: string,
): boolean {
	const resolved = path.isAbsolute(filePath)
		? filePath
		: path.resolve(cwd, filePath);
	const normalized = path.normalize(resolved);
	const normalizedMain = path.normalize(mainRoot);

	// Not inside this repo at all → allow
	if (
		normalized !== normalizedMain &&
		!normalized.startsWith(normalizedMain + path.sep)
	) {
		return false;
	}

	// Inside a worktree subdirectory → allow
	const worktreesDir = path.join(normalizedMain, ".worktrees") + path.sep;
	if (normalized.startsWith(worktreesDir)) {
		return false;
	}

	// Inside main repo → block
	return true;
}
