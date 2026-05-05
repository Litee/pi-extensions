/**
 * User-level configuration for the recap-model override (tracker issues
 * #0005 + #0006).
 *
 * The extension owns its config file at
 *   `<agentDir>/pi-session-recap.json`
 * (flat, NOT under `extensions-data/`). `<agentDir>` defaults to pi's
 * `getAgentDir()` — which honours `$PI_CODING_AGENT_DIR` — and the whole
 * default path can be replaced outright via `$PI_SESSION_RECAP_CONFIG`.
 *
 * Schema (all keys optional, extensible):
 *   { "model": "anthropic/claude-haiku-4-5" }
 *
 * Precedence (enforced by index.ts):
 *   `--recap-model` CLI flag › this file's `.model` › active pi model.
 *
 * All read paths (missing file, invalid JSON, missing key, wrong type,
 * empty/whitespace value) return `undefined` silently. Write paths swallow
 * errors in migration (best-effort) and surface them to direct callers of
 * `writeUserRecapConfig` (so explicit test harnesses can observe them).
 *
 * Migration: on first `session_start` after upgrade, `migrateLegacyConfig`
 * populates the new flat file from either a legacy `extensions-data/` copy
 * (pre-release #0005 / manual placement) or from `sessionRecap.model` in
 * pi's `settings.json`. Migration never raises; legacy sources are left
 * untouched after the new file exists.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@mariozechner/pi-coding-agent";

/** File name for the extension's own user-level config, under `<agentDir>/`. */
export const CONFIG_FILENAME = "pi-session-recap.json";

/** Env var that, when set to a non-empty string, replaces the default path outright. */
export const ENV_CONFIG_OVERRIDE = "PI_SESSION_RECAP_CONFIG";

/** Pre-#0006 legacy location (under `<agentDir>/extensions-data/`). Read-only; migrated once. */
const LEGACY_EXTENSIONS_DATA_SUBDIR = "extensions-data";

/** Shape of the on-disk config. Forward-compatible — unknown keys are ignored on read. */
export interface UserRecapConfig {
	model?: string;
}

/**
 * Resolve the config file path for the current process.
 *
 * When `$PI_SESSION_RECAP_CONFIG` is set to a non-empty string it wins and
 * is returned verbatim (typically an absolute path). Otherwise the file
 * sits flat under `agentDir`, next to pi's `settings.json`.
 */
export function defaultConfigFile(env: NodeJS.ProcessEnv, agentDir: string = getAgentDir()): string {
	const override = env[ENV_CONFIG_OVERRIDE];
	if (typeof override === "string" && override.trim().length > 0) return override;
	return join(agentDir, CONFIG_FILENAME);
}

/**
 * Read and validate the config at `configFile`.
 *
 * Returns `undefined` when the file is missing, unreadable, or not valid
 * JSON — the caller treats that as "no user config present" and falls
 * through. Returns a `UserRecapConfig` object otherwise; individual fields
 * (currently only `model`) are stripped when they fail type / emptiness
 * checks so callers can rely on `config.model` being a usable string when
 * present.
 */
export function readUserRecapConfig(configFile: string): UserRecapConfig | undefined {
	let raw: string;
	try {
		raw = readFileSync(configFile, "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const obj = parsed as Record<string, unknown>;
	const config: UserRecapConfig = {};
	const rawModel = obj["model"];
	if (typeof rawModel === "string") {
		const trimmed = rawModel.trim();
		if (trimmed.length > 0) config.model = trimmed;
	}
	return config;
}

/**
 * Persist `config` at `configFile`. Atomic: writes to a sibling temp file
 * and renames onto the final path, so a process crash between the two
 * system calls either leaves the previous file intact (pre-rename) or the
 * new file in place (post-rename) — never a truncated half-file.
 *
 * Parent directories are created as needed. On rename failure (e.g. the
 * temp and final paths straddle a filesystem boundary, yielding `EXDEV`),
 * we fall back to a copy-then-delete of the temp file. Any other error is
 * rethrown after best-effort temp cleanup.
 */
export function writeUserRecapConfig(configFile: string, config: UserRecapConfig): void {
	mkdirSync(dirname(configFile), { recursive: true });
	const tmp = `${configFile}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
		try {
			renameSync(tmp, configFile);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException | undefined)?.code;
			if (code === "EXDEV") {
				copyFileSync(tmp, configFile);
				try {
					unlinkSync(tmp);
				} catch {
					/* noop */
				}
			} else {
				throw err;
			}
		}
	} catch (err) {
		try {
			unlinkSync(tmp);
		} catch {
			/* noop */
		}
		throw err;
	}
}

/**
 * Read `sessionRecap.model` from `<agentDir>/settings.json`. Used only by
 * the migration path — the extension no longer reads pi's `settings.json`
 * as a live config source. Same tolerant-parsing rules as the reader above.
 */
function readLegacySettingsJsonModel(agentDir: string): string | undefined {
	const file = join(agentDir, "settings.json");
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const sr = (parsed as { sessionRecap?: unknown }).sessionRecap;
	if (!sr || typeof sr !== "object" || Array.isArray(sr)) return undefined;
	const m = (sr as { model?: unknown }).model;
	if (typeof m !== "string") return undefined;
	const trimmed = m.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * One-shot, silent, forward-only migration to the new flat config file.
 *
 * Order of checks:
 *   1. New flat path exists → done. Nothing to do. Legacy sources (if any)
 *      are ignored but NOT deleted; user may have edited them for reasons.
 *   2. Else `<agentDir>/extensions-data/pi-session-recap.json` exists
 *      (pre-release #0005 / manual placement) → rename to the new flat
 *      path. On `EXDEV` fall back to copy-then-delete.
 *   3. Else `sessionRecap.model` present in `<agentDir>/settings.json` →
 *      write the new file with `{ "model": "<value>" }`. `settings.json`
 *      is NOT modified; the extension simply stops reading it.
 *   4. Else → nothing to migrate; no file is created.
 *
 * Never raises. Any I/O error (permission denied, mkdir races, partial
 * writes) is swallowed — the recap feature is best-effort and a missing
 * config just means we fall back to the active pi model.
 */
export function migrateLegacyConfig(
	agentDir: string,
	env: NodeJS.ProcessEnv,
): { migrated: boolean } {
	try {
		const newPath = defaultConfigFile(env, agentDir);
		if (existsSync(newPath)) return { migrated: false };

		// Leg 1: pre-#0006 extensions-data/ location. We always move the
		// file (rename, or copy-then-delete on EXDEV) so the legacy location
		// never accumulates stale state after a successful migration.
		const legacyExtData = join(agentDir, LEGACY_EXTENSIONS_DATA_SUBDIR, CONFIG_FILENAME);
		if (existsSync(legacyExtData)) {
			try {
				mkdirSync(dirname(newPath), { recursive: true });
				try {
					renameSync(legacyExtData, newPath);
				} catch (err) {
					const code = (err as NodeJS.ErrnoException | undefined)?.code;
					if (code !== "EXDEV") throw err;
					copyFileSync(legacyExtData, newPath);
					try {
						unlinkSync(legacyExtData);
					} catch {
						/* noop — leaving the legacy copy behind is preferable to failing migration */
					}
				}
				return { migrated: true };
			} catch {
				return { migrated: false };
			}
		}

		// Leg 2: pi settings.json. We copy the value into the new file but
		// leave the legacy key in place — editing pi's core config from an
		// extension is the exact anti-pattern this migration exists to fix.
		const legacyModel = readLegacySettingsJsonModel(agentDir);
		if (legacyModel) {
			try {
				writeUserRecapConfig(newPath, { model: legacyModel });
				return { migrated: true };
			} catch {
				return { migrated: false };
			}
		}

		return { migrated: false };
	} catch {
		return { migrated: false };
	}
}

/**
 * Back-compat wrapper kept so `src/index.ts`'s `configuredOverride`
 * doesn't need a full rewrite — delegates to the new reader and returns
 * just the resolved `.model` string (or `undefined` when absent/invalid).
 */
export function readUserRecapModel(agentDir: string = getAgentDir()): string | undefined {
	const configFile = defaultConfigFile(process.env, agentDir);
	return readUserRecapConfig(configFile)?.model;
}
