/**
 * Config module — backs `~/.pi/agent/pi-sandboxed-workflows.json`.
 *
 * Bootstrap behaviour:
 *  - First call: writes `{ "directories": ["~/.pi/agent/sandboxed-workflows"] }`
 *    so the user-global default keeps working out of the box.
 *  - Subsequent calls: reads the file as-is. We never mutate an existing
 *    config (no auto-migration, no auto-merge) so users can edit it freely.
 *
 * The on-disk file uses `~`-prefixed paths for readability; this module
 * expands them to absolute paths on read. Other tilde forms (`~user/...`)
 * are returned unchanged \u2014 we don't shell out to resolve other users.
 */
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir as osHomedir } from "node:os";
import { dirname, join } from "node:path";

/** Filename relative to `~/.pi/agent/`. */
export const CONFIG_FILE_NAME = "pi-sandboxed-workflows.json";

/** Default directory inside the JSON, stored with a `~` prefix. */
const DEFAULT_DIR_LITERAL = "~/.pi/agent/sandboxed-workflows";

export interface ResolvedConfig {
	/**
	 * Absolute paths to scan for workflow files. Order matters \u2014 earlier
	 * directories shadow later ones on filename collision (see
	 * {@link discoverWorkflows}).
	 */
	readonly directories: ReadonlyArray<string>;
}

export interface LoadOptions {
	/** Override `os.homedir()`. Tests pass a tmpdir. */
	readonly homedir?: string;
	/** Override the resolved file path. Tests rarely need this. */
	readonly path?: string;
	/** Override process.cwd() for tests. When provided, the project-local
	 *  `.pi/sandboxed-workflows` directory for this cwd is prepended to the
	 *  directories list (higher priority than the global config). */
	readonly cwd?: string;
}

/** Compute `<home>/.pi/agent/<file>` for the given home dir. */
export function defaultConfigPath(homedir: string): string {
	return join(homedir, ".pi", "agent", CONFIG_FILE_NAME);
}

/**
 * Returns the project-local workflow directory for a given working directory.
 * Conventionally `<cwd>/.pi/sandboxed-workflows`. The directory does not need
 * to exist — callers treat a missing directory as "no scripts".
 */
export function projectWorkflowsDir(cwd: string): string {
	return join(cwd, ".pi", "sandboxed-workflows");
}

/**
 * Expand a leading `~` or `~/` to the home directory. Other tilde forms
 * (e.g. `~bob/foo`) are returned unchanged \u2014 we don't resolve other
 * users' home dirs.
 */
export function expandTilde(p: string, home: string): string {
	if (p === "~") return home;
	if (p.startsWith("~/")) return join(home, p.slice(2));
	return p;
}

/**
 * Read the config file, creating it with sensible defaults on first run,
 * and return the resolved (tilde-expanded) directories list.
 *
 * Throws on malformed JSON, wrong shape, or empty/non-string entries \u2014
 * the caller surfaces these as `notify(..., "error")` plus a chat message.
 */
export function loadOrInitConfig(opts: LoadOptions = {}): ResolvedConfig {
	const home = opts.homedir ?? osHomedir();
	const path = opts.path ?? defaultConfigPath(home);

	if (!existsSync(path)) {
		// Bootstrap: ensure parent dir exists, then write the canonical
		// default. We store the `~` literal (not the expanded path) so the
		// user can later move their home and the config stays portable.
		mkdirSync(dirname(path), { recursive: true });
		const defaultBody = `${JSON.stringify({ directories: [DEFAULT_DIR_LITERAL] }, null, 2)}\n`;
		writeFileSync(path, defaultBody);
	}

	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to read ${path}: ${cause}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Failed to parse ${path} as JSON: ${cause}\n` +
				`Edit the file or delete it to regenerate the default.`,
		);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(
			`${path} must be a JSON object with a "directories" array.`,
		);
	}
	const obj = parsed as Record<string, unknown>;
	if (!("directories" in obj)) {
		throw new Error(`${path} is missing the "directories" key.`);
	}
	if (!Array.isArray(obj["directories"])) {
		throw new Error(`${path}: "directories" must be an array of strings.`);
	}
	const dirs: ReadonlyArray<unknown> = obj["directories"];
	if (dirs.length === 0) {
		throw new Error(
			`${path}: "directories" array is empty. Add at least one path.`,
		);
	}
	const expanded: string[] = [];
	for (let i = 0; i < dirs.length; i += 1) {
		const entry: unknown = dirs[i];
		if (typeof entry !== "string") {
			throw new Error(
				`${path}: "directories[${String(i)}]" must be a string, got ${typeof entry}.`,
			);
		}
		expanded.push(expandTilde(entry, home));
	}
	const projectDir = opts.cwd !== undefined
		? projectWorkflowsDir(opts.cwd)
		: undefined;
	if (projectDir !== undefined && !expanded.includes(projectDir)) {
		return { directories: [projectDir, ...expanded] };
	}
	return { directories: expanded };
}
