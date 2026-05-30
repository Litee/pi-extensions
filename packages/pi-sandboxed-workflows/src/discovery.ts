/**
 * Discovery — find user-authored workflow scripts in one or more
 * directories, return them as `{ name, path, sourceDir }[]`.
 *
 * Pure fs scan: reads each directory, filters to `*.ts` (excluding
 * `*.d.ts`), and returns one entry per file whose basename maps to a
 * valid `/workflow:<name>` command. Files with bad names are returned as
 * warnings so the caller (extension entry point) can surface them via
 * `ctx.ui.notify`. No `import()` of the workflow files happens here, so
 * any top-level side effects in the workflow source do not run during
 * scanning.
 *
 * Multi-directory merging
 * -----------------------
 * Workflows can come from multiple directories (configured in
 * `~/.pi/agent/pi-sandboxed-workflows.json`). On filename collision, the
 * EARLIER directory in the list wins (so users can shadow a global default
 * by listing a project-local dir first). The shadowed file is reported as
 * a warning so the user knows they have a duplicate.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** A discovered workflow script ready for command registration. */
export interface WorkflowScript {
	/** Filename without the `.ts` extension. Becomes the `<name>` in `/workflow:<name>`. */
	readonly name: string;
	/** Absolute path to the workflow file on disk. */
	readonly path: string;
	/**
	 * Absolute path to the directory the file was discovered in. Useful
	 * for the `/sandbox-workflow` browser TUI and for collision warnings.
	 */
	readonly sourceDir: string;
}

/** A file that looked like a workflow candidate but had an unusable name. */
export interface DiscoveryWarning {
	readonly file: string;
	readonly reason: string;
}

export interface DiscoveryResult {
	readonly scripts: ReadonlyArray<WorkflowScript>;
	readonly warnings: ReadonlyArray<DiscoveryWarning>;
}

/**
 * Names that map cleanly to a `/workflow:<name>` slash command:
 * - lowercase letters, digits, and `-`;
 * - must start with a letter (digits-first names look like option arguments);
 * - no leading dots, spaces, or underscores.
 */
const VALID_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Scan a single directory for `*.ts` workflow scripts.
 *
 * Returns `{ scripts, warnings }`:
 * - `scripts` is sorted alphabetically by `name` so command registration
 *   order is deterministic across runs;
 * - `warnings` lists candidate files whose basename does not satisfy
 *   `VALID_NAME`, so the caller can surface them once at startup.
 *
 * Missing directory is not an error: returns empty arrays.
 */
export function findWorkflowScripts(dir: string): DiscoveryResult {
	let entries: ReadonlyArray<string>;
	try {
		entries = readdirSync(dir);
	} catch {
		// Missing dir, EACCES, ENOTDIR — treat all as "no scripts".
		return { scripts: [], warnings: [] };
	}

	const scripts: WorkflowScript[] = [];
	const warnings: DiscoveryWarning[] = [];

	for (const entry of entries) {
		// Only pick up files with the `.workflow.ts` suffix.
		if (!entry.endsWith(".workflow.ts")) continue;

		const path = join(dir, entry);

		// Skip subdirectories — discovery is non-recursive.
		try {
			if (!statSync(path).isFile()) continue;
		} catch {
			continue;
		}

		const name = entry.slice(0, -".workflow.ts".length);
		if (!VALID_NAME.test(name)) {
			warnings.push({
				file: entry,
				reason: `filename ${JSON.stringify(entry)} does not match /^[a-z][a-z0-9-]*\\.workflow\\.ts$/ — cannot register as /workflow:${name}`,
			});
			continue;
		}

		scripts.push({ name, path, sourceDir: dir });
	}

	scripts.sort((a, b) => a.name.localeCompare(b.name));
	return { scripts, warnings };
}

/**
 * Scan multiple directories in order and merge the results.
 *
 * Collision rule: the FIRST occurrence of a given workflow name wins. Any
 * subsequent file with the same name is skipped and reported via a warning
 * naming both the kept file's path and the shadowed file's path, so the
 * user knows they have a duplicate.
 *
 * The final `scripts` array is sorted alphabetically by name (matching the
 * single-dir behaviour) so registration order is deterministic regardless
 * of which directory contributed each script.
 */
export function discoverWorkflows(
	dirs: ReadonlyArray<string>,
): DiscoveryResult {
	const seen = new Map<string, WorkflowScript>();
	const warnings: DiscoveryWarning[] = [];

	for (const dir of dirs) {
		const perDir = findWorkflowScripts(dir);
		for (const w of perDir.warnings) {
			warnings.push(w);
		}
		for (const s of perDir.scripts) {
			const existing = seen.get(s.name);
			if (existing === undefined) {
				seen.set(s.name, s);
			} else {
				warnings.push({
					file: s.path,
					reason:
						`duplicate workflow name "${s.name}": already registered from ` +
						`${existing.sourceDir} (using ${existing.path}); ` +
						`shadowed copy at ${s.path} in ${dir} ignored`,
				});
			}
		}
	}

	const scripts = [...seen.values()].sort((a, b) =>
		a.name.localeCompare(b.name),
	);
	return { scripts, warnings };
}
