import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
 */
export function writeDisabled(file: string, disabled: Set<string>): void {
	const state: PersistedState = { disabled: [...disabled].sort() };
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}
