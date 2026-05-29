/**
 * User-level config for pi-file-system-watcher.
 *
 * Reads `~/.pi/agent/pi-file-system-watcher.json` (if present) and validates
 * known fields. Any failure mode is swallowed and yields `{}` so the
 * runtime falls back to hardcoded defaults.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type DisplayMode = "widget" | "statusline";

const VALID_DISPLAY_MODES: ReadonlySet<string> = new Set<DisplayMode>([
	"widget",
	"statusline",
]);

/** Shape of `~/.pi/agent/pi-file-system-watcher.json`. */
export interface FsWatcherConfig {
	/**
	 * Initial display mode used when no display-mode preference is persisted
	 * in the session log. Once the user toggles the display via the
	 * `/file-system-watcher` menu, the persisted value wins — this only seeds the
	 * first session.
	 */
	defaultDisplayMode?: DisplayMode;
}

export function configFilePath(): string {
	return join(getAgentDir(), "pi-file-system-watcher.json");
}

export function loadConfig(): FsWatcherConfig {
	let raw: unknown;
	try {
		const content = readFileSync(configFilePath(), "utf-8");
		raw = JSON.parse(content);
	} catch {
		return {};
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

	const r = raw as Record<string, unknown>;
	const out: FsWatcherConfig = {};

	const mode = r["defaultDisplayMode"];
	if (typeof mode === "string" && VALID_DISPLAY_MODES.has(mode)) {
		out.defaultDisplayMode = mode as DisplayMode;
	}

	return out;
}

/**
 * Persist a partial update to `~/.pi/agent/pi-file-system-watcher.json`.
 * Returns `true` on success, `false` if anything threw.
 */
export function saveConfig(change: { [K in keyof FsWatcherConfig]?: FsWatcherConfig[K] | undefined }): boolean {
	const path = configFilePath();
	try {
		let existing: Record<string, unknown> = {};
		try {
			const content = readFileSync(path, "utf-8");
			const parsed: unknown = JSON.parse(content);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				existing = parsed as Record<string, unknown>;
			}
		} catch {
			/* missing/invalid → start from {} */
		}
		const merged = { ...existing, ...change };
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
		return true;
	} catch {
		return false;
	}
}
