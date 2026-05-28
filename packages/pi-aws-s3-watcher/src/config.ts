/**
 * User-level config for pi-aws-s3-watcher.
 *
 * Reads `~/.pi/agent/pi-aws-s3-watcher.json` (if present) and validates
 * known fields. Any failure mode — file missing, unreadable, invalid
 * JSON, wrong root type, unknown field value — is swallowed and yields
 * `{}` so the runtime falls back to its hardcoded defaults.
 *
 * Mirrors the idiom used by `pi-goal/src/state.ts#loadGoalConfig`.
 *
 * No project-level config support — this is intentionally a single
 * user-level lookup so behaviour is consistent across worktrees.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Valid display modes for the S3 watcher widget / status row. */
export type DisplayMode = "widget" | "statusline";

const VALID_DISPLAY_MODES: ReadonlySet<string> = new Set<DisplayMode>([
	"widget",
	"statusline",
]);

/** Shape of `~/.pi/agent/pi-aws-s3-watcher.json`. */
export interface S3WatcherConfig {
	/**
	 * Initial display mode used when no display-mode preference is
	 * persisted in the session log. Once the user toggles the display
	 * via the `/s3-watcher` menu's display-mode switch, the persisted value
	 * wins on subsequent
	 * session loads — this config only seeds the first session.
	 */
	defaultDisplayMode?: DisplayMode;
}

/**
 * Read `~/.pi/agent/pi-aws-s3-watcher.json`; returns `{}` on any
 * read/parse/validation failure. Unknown values for known fields are
 * dropped rather than poisoning the runtime — e.g. a typo'd
 * `defaultDisplayMode: "inline"` is treated the same as the field
 * being absent.
 */
/** Path to the user-level config JSON. Centralised for tests + saveConfig. */
export function configFilePath(): string {
	return join(getAgentDir(), "pi-aws-s3-watcher.json");
}

export function loadConfig(): S3WatcherConfig {
	let raw: unknown;
	try {
		const content = readFileSync(configFilePath(), "utf-8");
		raw = JSON.parse(content);
	} catch {
		return {};
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

	const r = raw as Record<string, unknown>;
	const out: S3WatcherConfig = {};

	const mode = r["defaultDisplayMode"];
	if (typeof mode === "string" && VALID_DISPLAY_MODES.has(mode)) {
		out.defaultDisplayMode = mode as DisplayMode;
	}

	return out;
}

/**
 * Persist a partial update to `~/.pi/agent/pi-aws-s3-watcher.json`.
 *
 * Reads the file fresh and merges `change` over the **raw** JSON object
 * — not the sanitised result of {@link loadConfig} — so unknown keys
 * (e.g. fields added by a newer version of the extension) are
 * preserved on disk when an older build writes back. Returns `true`
 * on success, `false` if anything threw — callers surface a toast.
 *
 * Fields set to `undefined` are omitted from JSON output, which
 * effectively removes them from the stored config.
 */
export function saveConfig(change: { [K in keyof S3WatcherConfig]?: S3WatcherConfig[K] | undefined }): boolean {
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
			/* missing/unreadable/invalid JSON → start from {} */
		}
		const merged = { ...existing, ...change };
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
		return true;
	} catch {
		return false;
	}
}
