import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { PersistedState } from "./types.js";

/**
 * Read the persisted disabled-skill ids from `file`.
 *
 * Returns an empty set when the file is missing, unreadable, not JSON, or the
 * `disabled` key is not an array. All other fields are ignored.
 */
export function readDisabled(file: string): Set<string> {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return new Set();
	}
	let parsed: PersistedState;
	try {
		parsed = JSON.parse(raw) as PersistedState;
	} catch {
		return new Set();
	}
	if (!Array.isArray(parsed.disabled)) return new Set();
	return new Set(parsed.disabled);
}

/**
 * Persist `disabled` to `file` as JSON with a trailing newline. The ids are
 * sorted for reproducible output. Parent directories are created as needed.
 *
 * Atomic on POSIX: writes to a sibling temp file and renames onto the final
 * path, so two concurrent pi sessions toggling state cannot interleave and
 * corrupt the JSON (see issue #0002). A process crash between the two
 * system calls either leaves the previous file intact (pre-rename) or the
 * new file in place (post-rename) — never a truncated half-file.
 */
export function writeDisabled(file: string, disabled: Set<string>): void {
	const state: PersistedState = { disabled: [...disabled].sort() };
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
	renameSync(tmp, file);
}
