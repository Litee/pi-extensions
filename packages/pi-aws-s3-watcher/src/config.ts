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

import { readFileSync } from "node:fs";
import { join } from "node:path";

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
	 * via `/s3-watcher display`, the persisted value wins on subsequent
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
export function loadConfig(): S3WatcherConfig {
	let raw: unknown;
	try {
		const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
		const configPath = join(home, ".pi", "agent", "pi-aws-s3-watcher.json");
		const content = readFileSync(configPath, "utf-8");
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
